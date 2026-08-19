import {
  errorEnvelope,
  zodErrorToDetails,
  type ErrorDetail,
} from "@expense/shared";
import fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodFastifySchemaValidationError,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import type { Db } from "./db/client.js";
import type { Env } from "./env.js";
import { newId } from "./lib/ids.js";
import { authPlugin } from "./plugins/auth.js";
import { securityPlugin } from "./plugins/security.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";

/** design/api.md: request body size capped at 32 KB. */
const BODY_LIMIT_BYTES = 32 * 1024;

/**
 * A caller-supplied request id is echoed back in a response header, so it is
 * accepted only in the shape ids actually take. An arbitrary header value would
 * be attacker-controlled data flowing into our response headers and log lines.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

const requestIdFrom = (headers: IncomingHttpHeaders): string => {
  const supplied = headers["x-request-id"];
  const first = Array.isArray(supplied) ? supplied[0] : supplied;
  return first !== undefined && REQUEST_ID_RE.test(first) ? first : newId();
};

/**
 * The zod type provider flattens the `ZodError` into fastify's own validation
 * shape (`keyword`, `instancePath`, `schemaPath`, `params`) before the error
 * handler ever sees it, and `params` is the zod issue minus path/code/message —
 * it can carry the rejected input. Rebuilding a `ZodError` and funnelling it
 * through `zodErrorToDetails` keeps one rule for what may leave the process:
 * a dotted path and a message. (The rebuilt issue `code` is irrelevant —
 * `zodErrorToDetails` reads path and message and nothing else.)
 */
const validationDetails = (
  validation: ZodFastifySchemaValidationError[],
): ErrorDetail[] =>
  zodErrorToDetails(
    new z.ZodError(
      validation.map((issue) => ({
        code: "custom",
        // "/nested/n" -> ["nested", "n"]; a root-level issue is "/" -> [].
        path: issue.instancePath.split("/").filter((segment) => segment !== ""),
        message: issue.message ?? "Invalid input",
      })),
    ),
  );

export async function buildApp({
  db,
  env,
  logger = { level: "info" },
}: {
  db: Db;
  env: Env;
  /** Tests pass `false`; production keeps the pino default. */
  logger?: FastifyServerOptions["logger"];
}) {
  const app = fastify({
    logger,
    genReqId: (req) => requestIdFrom(req.headers),
    // Read the header ourselves (above) so it can be validated first.
    requestIdHeader: false,
    bodyLimit: BODY_LIMIT_BYTES,
    // Exactly one hop: the platform's proxy appends the real client address to
    // X-Forwarded-For, and trusting only that last hop is what stops a client
    // from choosing its own rate-limit key by sending the header itself.
    trustProxy: 1,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // design/api.md: the request id is echoed in responses so a user-reported
  // failure can be found in the logs.
  app.addHook("onRequest", async (req, reply) => {
    void reply.header("x-request-id", req.id);
  });

  await app.register(securityPlugin, { env });
  // After securityPlugin: the session cookie is read through @fastify/cookie,
  // which that plugin registers. Before the routes, which use `app.authenticate`.
  await app.register(authPlugin, { db, env });

  /**
   * The single place a non-2xx body is produced. Later tasks reply with the
   * envelope directly rather than throwing, so what reaches here is either a
   * schema failure, a framework-level client error, or a bug — and a bug tells
   * the client nothing beyond "internal".
   */
  app.setErrorHandler<FastifyError>((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply
        .code(400)
        .send(
          errorEnvelope(
            "validation_failed",
            "Invalid request",
            validationDetails(err.validation),
          ),
        );
    }

    switch (err.statusCode) {
      case 429:
        return reply
          .code(429)
          .send(errorEnvelope("rate_limited", "Too many requests"));
      // Body-shape rejections from fastify itself: too large (413), wrong
      // content type (415), unparseable JSON (400). All normalize to 400
      // because the error-code union pins `validation_failed` to 400.
      case 413:
        return reply
          .code(400)
          .send(
            errorEnvelope("validation_failed", "Request body is too large"),
          );
      case 415:
        return reply
          .code(400)
          .send(errorEnvelope("validation_failed", "Unsupported content type"));
      case 400:
        return reply
          .code(400)
          .send(errorEnvelope("validation_failed", "Malformed request body"));
    }

    // The stack goes to the log, never to the response.
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send(errorEnvelope("internal", "Internal error"));
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send(errorEnvelope("not_found", "Not found")),
  );

  await app.register(healthRoutes, { db, version: env.APP_VERSION });
  await app.register(authRoutes, { db, prefix: "/api/auth" });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
