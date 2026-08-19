import { errorEnvelope } from "@expense/shared";
import type { CookieSerializeOptions } from "@fastify/cookie";
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import fp from "fastify-plugin";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";
import { hashSessionToken } from "../lib/crypto.js";
import { SESSION_TTL_MS, sessionsRepo } from "../repos/sessions.js";

export const SESSION_COOKIE = "session";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `app.authenticate`; `null` on any route that does not use it. */
    userId: string | null;
  }

  interface FastifyReply {
    setSessionCookie(token: string): void;
    clearSessionCookie(): void;
  }

  interface FastifyInstance {
    /** `preHandler` for every route that needs a user. */
    authenticate: preHandlerAsyncHookHandler;
  }
}

/**
 * The session user id, for handlers behind `app.authenticate`.
 *
 * The throw is not defensive noise: it is what turns "route registered without
 * the preHandler" — an omission that would otherwise silently serve one user's
 * data to anybody — into a 500 the first time it is exercised.
 */
export function currentUserId(req: FastifyRequest): string {
  if (req.userId === null) {
    throw new Error(
      "currentUserId() on a route that does not use app.authenticate",
    );
  }
  return req.userId;
}

/**
 * Session cookie handling and the `authenticate` preHandler.
 *
 * `fastify-plugin`-wrapped so the decorators exist on the root instance; an
 * encapsulated plugin would decorate only routes registered inside it.
 */
export const authPlugin = fp<{ db: Db; env: Env }>(async (app, { db, env }) => {
  /**
   * The one definition of the session cookie's flags. design/api.md:
   * `HttpOnly; Secure; SameSite=Lax; Path=/`.
   *
   * `Secure` tracks the deployed scheme rather than being hardcoded on: a Secure
   * cookie is never sent back over http, so pinning it would break local dev,
   * and hardcoding it off would ship the session in the clear.
   *
   * Not signed: the value is already 256 bits of unguessable randomness that
   * only means anything if it matches a row, so a signature adds a failure mode
   * and no security.
   */
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: env.APP_ORIGIN.startsWith("https://"),
    maxAge: SESSION_TTL_MS / 1000,
  } as const satisfies CookieSerializeOptions;

  app.decorateRequest("userId", null);

  app.decorateReply(
    "setSessionCookie",
    function (this: FastifyReply, token: string) {
      void this.setCookie(SESSION_COOKIE, token, cookieOptions);
    },
  );

  app.decorateReply("clearSessionCookie", function (this: FastifyReply) {
    // Same flags as when it was set — a browser only replaces a cookie whose
    // name, path and domain all match.
    void this.clearCookie(SESSION_COOKIE, cookieOptions);
  });

  app.decorate("authenticate", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const session =
      token === undefined
        ? null
        : await sessionsRepo.findValid(db, hashSessionToken(token));

    if (!session) {
      // One answer for absent, unrecognised, expired and past-the-cap. Which of
      // the four it was is not the client's business, and saying would help
      // someone probing with harvested tokens.
      return reply
        .code(401)
        .send(errorEnvelope("unauthorized", "Authentication required"));
    }

    req.userId = session.userId;
  });
});
