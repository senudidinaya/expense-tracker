import { errorEnvelope } from "@expense/shared";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/client.js";

/**
 * `/health` sits outside `/api`: it is consumed by the platform health check and
 * the uptime pinger, never by the web app, so its schema stays local instead of
 * joining the shared contract.
 */
const healthResponse = z.object({
  status: z.literal("ok"),
  version: z.string(),
});

/** The 503 body is the standard error envelope, declared locally for the same reason. */
const unavailableResponse = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export const healthRoutes: FastifyPluginAsyncZod<{
  db: Db;
  version: string;
}> = async (app, opts) => {
  app.get(
    "/health",
    { schema: { response: { 200: healthResponse, 503: unavailableResponse } } },
    async (req, reply) => {
      try {
        await opts.db.execute(sql`select 1`);
      } catch (err) {
        // Ops learns the database is the reason from the log; the caller learns
        // only that much. Driver errors carry the connection string.
        req.log.error({ err }, "health check failed: database unreachable");
        return reply
          .code(503)
          .send(errorEnvelope("internal", "Database unreachable"));
      }
      return reply.send({ status: "ok" as const, version: opts.version });
    },
  );
};
