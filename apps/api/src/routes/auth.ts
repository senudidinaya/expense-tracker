import {
  errorEnvelope,
  errorResponse,
  loginBody,
  signupBody,
  userDto,
} from "@expense/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { dummyPasswordHash, hashSessionToken } from "../lib/crypto.js";
import { isCommonPassword } from "../lib/password-blocklist.js";
import { SESSION_COOKIE, currentUserId } from "../plugins/auth.js";
import { sessionsRepo } from "../repos/sessions.js";
import { usersRepo, type UserRecord } from "../repos/users.js";

/** Every auth route that returns a success body returns this one. */
const userResponse = z.object({ user: userDto });

/**
 * Framework-level statuses — 413/415/429 and the catch-all 500 — are produced by
 * the error handler in `app.ts` from fixed envelopes with no request data in
 * them, and apply to every route in the app rather than to these four. What each
 * route declares below is what its own handler and preHandler can reply.
 */

/**
 * The repository's `Date` becomes the wire's ISO string here, at the HTTP
 * boundary — `userDto.createdAt` is `z.iso.datetime({ offset: true })`.
 */
const toUserDto = (user: UserRecord) => ({
  id: user.id,
  email: user.email,
  isDemo: user.isDemo,
  createdAt: user.createdAt.toISOString(),
});

/**
 * Handlers here are deliberately thin — parse, one repo call, reply. All SQL
 * lives in `repos/`, including credential verification, which is what keeps the
 * password hash from ever reaching this file.
 */
export const authRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (
  app,
  { db },
) => {
  dummyPasswordHash().catch(() => {
    // Warming the timing-uniformity digest at boot, so the first unknown-email
    // login does not pay for it and stand out. Best effort: `dummyPasswordHash`
    // drops a failed attempt, so the login path simply retries.
  });

  app.post(
    "/signup",
    {
      schema: {
        body: signupBody,
        response: {
          201: userResponse,
          // 400 covers both the body failing `signupBody` and the
          // common-password rejection below; 409 is the taken address.
          400: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;

      // Length lives in the shared schema so both sides enforce it; list
      // membership cannot — it needs a bundled ~3.6k-entry wordlist that has no
      // business in a browser bundle.
      if (isCommonPassword(password)) {
        return reply.code(400).send(
          errorEnvelope("validation_failed", "Invalid request", [
            {
              path: "password",
              message:
                "password is among the most commonly used — choose a less predictable one",
            },
          ]),
        );
      }

      const created = await usersRepo.create(db, { email, password });
      if (!created.ok) {
        return reply
          .code(409)
          .send(
            errorEnvelope(
              "conflict",
              "That email address is already registered",
            ),
          );
      }

      const token = await sessionsRepo.create(db, created.user.id);
      reply.setSessionCookie(token);
      return reply.code(201).send({ user: toUserDto(created.user) });
    },
  );

  app.post(
    "/login",
    {
      schema: {
        body: loginBody,
        response: {
          200: userResponse,
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const user = await usersRepo.verifyCredentials(db, req.body);
      if (!user) {
        // One message for both "no such email" and "wrong password"; the repo
        // makes them cost the same, and this makes them read the same.
        return reply
          .code(401)
          .send(errorEnvelope("unauthorized", "Invalid email or password"));
      }

      // Session fixation: whatever session the client arrived holding is
      // destroyed, so a token planted before login never becomes a logged-in
      // token. Only the presented cookie — other devices stay signed in.
      const presented = req.cookies[SESSION_COOKIE];
      if (presented !== undefined) {
        await sessionsRepo.delete(db, hashSessionToken(presented));
      }

      const token = await sessionsRepo.create(db, user.id);
      reply.setSessionCookie(token);
      return reply.send({ user: toUserDto(user) });
    },
  );

  app.post("/logout", { preHandler: app.authenticate }, async (req, reply) => {
    const presented = req.cookies[SESSION_COOKIE];
    // `authenticate` already established there is one; this is for the type.
    if (presented !== undefined) {
      await sessionsRepo.delete(db, hashSessionToken(presented));
    }
    reply.clearSessionCookie();
    return reply.code(204).send();
  });

  app.get(
    "/me",
    {
      preHandler: app.authenticate,
      schema: { response: { 200: userResponse, 401: errorResponse } },
    },
    async (req, reply) => {
      const user = await usersRepo.findById(db, currentUserId(req));
      if (!user) {
        // The session outlived its user — deleted mid-request, or a demo account
        // reaped by the nightly cron. The cookie is worthless; say so rather
        // than 500 on a row that is simply gone.
        reply.clearSessionCookie();
        return reply
          .code(401)
          .send(errorEnvelope("unauthorized", "Authentication required"));
      }
      return reply.send({ user: toUserDto(user) });
    },
  );
};
