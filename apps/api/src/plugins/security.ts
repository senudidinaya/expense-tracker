import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fp from "fastify-plugin";
import type { Env } from "../env.js";

/**
 * Requests per minute per IP for everything without a stricter per-route limit.
 * The auth routes get their own, tighter limits in Task 7.
 */
export const GLOBAL_RATE_LIMIT = 300;

/** Six months, the conventional HSTS max-age. */
const HSTS_MAX_AGE_SECONDS = 15_552_000;

/**
 * Headers, cookies and the global rate limit — everything that must apply to
 * every route, so it is wrapped with `fastify-plugin` (an encapsulated plugin's
 * hooks would only cover routes registered inside it).
 *
 * The CSP is self-only by design: fonts are self-hosted and charts are rendered
 * without an external script, so nothing legitimate needs a second origin. That
 * is also what makes the same-origin CSRF defence (SameSite=Lax + Origin check)
 * sufficient without a token dance.
 */
export const securityPlugin = fp<{ env: Env }>(async (app, { env }) => {
  // TLS is terminated by the platform; HSTS is only meaningful — and only
  // honored by browsers — when the app is actually reached over https.
  const isHttps = env.APP_ORIGIN.startsWith("https://");

  await app.register(helmet, {
    contentSecurityPolicy: {
      // No helmet defaults: the list below is the whole policy, so a helmet
      // upgrade cannot quietly widen it.
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        // Inter is bundled and served from /assets — no font CDN.
        "font-src": ["'self'"],
        // Vite inlines small assets (icons, the favicon) as data: URIs.
        "img-src": ["'self'", "data:"],
        "object-src": ["'none'"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "connect-src": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
      },
    },
    // design/api.md says frame-deny; helmet's own default is only sameorigin.
    frameguard: { action: "deny" },
    hsts: isHttps
      ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true }
      : false,
  });

  // Signed cookies: the session cookie itself carries an opaque random token, so
  // the signature is defence in depth, not the security boundary.
  await app.register(cookie, { secret: env.SESSION_SECRET });

  await app.register(rateLimit, {
    global: true,
    max: GLOBAL_RATE_LIMIT,
    timeWindow: "1 minute",
  });
});
