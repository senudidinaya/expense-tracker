import { errorEnvelope } from "@expense/shared";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fp from "fastify-plugin";
import type { Env } from "../env.js";

/**
 * Requests per minute per IP for everything without a stricter per-route limit.
 */
export const GLOBAL_RATE_LIMIT = 300;

/**
 * The tighter per-route limits from design/api.md, in one place because they are
 * a security parameter and not a property of whichever route happens to use
 * them. `demo` has no route yet — `POST /api/auth/demo` lands in Task 15 — and
 * is carried here so that route only has to reference it.
 *
 * All are keyed by IP (the limiter's default `req.ip`), which behind the
 * platform proxy is the address the proxy observed; see `trustProxy` in app.ts.
 */
export const AUTH_RATE_LIMITS = {
  login: { max: 10, timeWindow: "1 minute" },
  signup: { max: 10, timeWindow: "1 minute" },
  demo: { max: 5, timeWindow: "1 minute" },
} as const satisfies Record<string, { max: number; timeWindow: string }>;

/**
 * The methods the Origin check guards. A cross-site GET/HEAD cannot change
 * state, and guarding it would break ordinary navigation to the app.
 */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

  /**
   * CSRF defence, second layer. `SameSite=Lax` already keeps the session cookie
   * off cross-site POSTs; this is what makes that a policy rather than a
   * browser-default we hope holds.
   *
   * An absent `Origin` is allowed on purpose. Browsers attach it to every
   * cross-site mutating request — fetch, XHR and form POST alike — so its
   * absence means the caller is not a browser: curl, a mobile client, a script.
   * Those have no ambient cookie for a third-party page to ride, which is the
   * whole CSRF threat model. Requiring the header would break every non-browser
   * client and stop no attack, because an attacker free to choose whether to
   * send it is not running inside the victim's browser to begin with.
   *
   * Registered before the rate limiter so a forged request is rejected on a
   * string comparison and never counted: the forgeries arrive from the victim's
   * own browser at the victim's IP, and counting them would let a hostile page
   * exhaust a real user's rate budget with a hidden form.
   */
  app.addHook("onRequest", async (req, reply) => {
    if (!MUTATING_METHODS.has(req.method)) return;

    const { origin } = req.headers;
    if (origin === undefined || origin === env.APP_ORIGIN) return;

    // 403 is reserved for exactly this case — cross-user access is 404 and a
    // missing session is 401 — so a 403 from this API means one thing. The
    // message names the reason without echoing the origin that was sent.
    return reply.code(403).send(errorEnvelope("forbidden", "Origin mismatch"));
  });

  await app.register(rateLimit, {
    global: true,
    max: GLOBAL_RATE_LIMIT,
    timeWindow: "1 minute",
  });
});
