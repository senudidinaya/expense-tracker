import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUTH_RATE_LIMITS,
  GLOBAL_RATE_LIMIT,
} from "../../src/plugins/security.js";
import { makeTestApp, testEnv } from "../helpers.js";

/** The origin the test app is configured with (`testEnv().APP_ORIGIN`). */
const APP_ORIGIN = testEnv().APP_ORIGIN;

/** Anything that is not APP_ORIGIN. Same host, different port, on purpose. */
const FOREIGN_ORIGIN = "http://localhost:5174";

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Buckets are keyed by IP, so tests that must not disturb each other claim their
 * own address. TEST-NET-3 (203.0.113.0/24) and TEST-NET-2 (198.51.100.0/24) are
 * the reserved documentation ranges — no real client can ever be one of these.
 */
const IP = {
  loginHeaders: "203.0.113.1",
  signupHeaders: "203.0.113.2",
  csrfBudget: "203.0.113.3",
  victim: "203.0.113.7",
  otherClient: "203.0.113.8",
} as const;

/** What an attacker would put in the header it controls. */
const SPOOFED = "198.51.100.42";

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ app, stop } = await makeTestApp());

  // Probe routes: the mutating verbs the CSRF hook guards have no real routes
  // until Task 8, and the header-only assertions below should not depend on
  // whichever real routes happen to exist.
  for (const method of [...MUTATING, "GET"] as const) {
    app.route({
      method,
      url: "/probe/mutate",
      handler: async () => ({ ok: true }),
    });
  }

  // A limit small enough to exhaust in three requests. The X-Forwarded-For test
  // is about how the rate-limit *key* is derived, not about any one route's
  // number, so it uses a route it can fill without 20 argon2 hashes.
  app.post(
    "/probe/limited",
    { config: { rateLimit: { max: 2, timeWindow: "1 minute" } } },
    async () => ({ ok: true }),
  );

  await app.ready();
}, 120_000);

// `stop` is undefined if beforeAll threw; calling it would bury the real error.
afterAll(() => stop?.());

describe("CSRF origin check", () => {
  it.each(MUTATING)(
    "%s from a foreign Origin -> 403 forbidden envelope",
    async (method) => {
      const r = await app.inject({
        method,
        url: "/probe/mutate",
        headers: { origin: FOREIGN_ORIGIN },
      });

      expect(r.statusCode).toBe(403);
      // `forbidden` is reserved for exactly this: cross-user access is 404 and
      // an absent session is 401, so a 403 in this API means one thing.
      expect(r.json().error).toEqual({
        code: "forbidden",
        message: "Origin mismatch",
      });
      expect(r.json().error.details).toBeUndefined();
    },
  );

  it.each(MUTATING)("%s from the app's own Origin passes", async (method) => {
    const r = await app.inject({
      method,
      url: "/probe/mutate",
      headers: { origin: APP_ORIGIN },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it("GET from a foreign Origin is unaffected", async () => {
    // Only mutating methods are guarded. A cross-site GET cannot change state,
    // and guarding it would break plain <a> navigation and link previews.
    const r = await app.inject({
      method: "GET",
      url: "/probe/mutate",
      headers: { origin: FOREIGN_ORIGIN },
    });

    expect(r.statusCode).toBe(200);
  });

  it("a mutating request with no Origin header at all is allowed", async () => {
    // Deliberate, and safe: a browser always attaches Origin to a cross-site
    // mutating request (fetch/XHR/form POST alike), so its *absence* means the
    // caller is not a browser — curl, a mobile client, a server-side script.
    // Those callers have no ambient cookie a third-party page can ride, which
    // is the entire CSRF threat model, so there is nothing to defend against.
    // Rejecting them would only break non-browser clients while stopping no
    // attack: an attacker who can choose whether to send the header is not
    // running inside the victim's browser and does not have the victim's cookie.
    const r = await app.inject({ method: "POST", url: "/probe/mutate" });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it("a rejected cross-site POST does not consume the caller's rate budget", async () => {
    // The origin check runs before the limiter on purpose. The forged requests
    // arrive from the *victim's* browser at the victim's IP, so counting them
    // would let a hostile page burn a real user's rate budget with a hidden
    // form — a denial of service handed out by the CSRF defence itself.
    const forged = await app.inject({
      method: "POST",
      url: "/probe/mutate",
      headers: { origin: FOREIGN_ORIGIN, "x-forwarded-for": IP.csrfBudget },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.headers["x-ratelimit-remaining"]).toBeUndefined();

    // The victim's first real request is still their first against the limiter.
    const real = await app.inject({
      method: "POST",
      url: "/probe/mutate",
      headers: { "x-forwarded-for": IP.csrfBudget },
    });
    expect(real.headers["x-ratelimit-remaining"]).toBe(
      String(GLOBAL_RATE_LIMIT - 1),
    );
  });
});

describe("auth rate limits", () => {
  it("the 11th login attempt in a minute -> 429 rate_limited envelope", async () => {
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: APP_ORIGIN },
        payload: { email: "nobody@example.com", password: "wrong-password" },
      });

    const allowed = await Promise.all(
      Array.from({ length: AUTH_RATE_LIMITS.login.max }, attempt),
    );
    // All ten were actually processed — 401, the credential answer, not 429.
    expect(allowed.map((r) => r.statusCode)).toEqual(
      Array.from({ length: AUTH_RATE_LIMITS.login.max }, () => 401),
    );

    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({ code: "rate_limited" });
    expect(limited.headers["retry-after"]).toBeDefined();
  }, 30_000);

  it("login advertises 10/min", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: APP_ORIGIN, "x-forwarded-for": IP.loginHeaders },
      payload: { email: "not-an-email", password: "" },
    });

    expect(r.headers["x-ratelimit-limit"]).toBe("10");
  });

  it("signup advertises 10/min", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      headers: { origin: APP_ORIGIN, "x-forwarded-for": IP.signupHeaders },
      // Invalid on purpose: this asserts the limit, not the signup path.
      payload: { email: "not-an-email", password: "" },
    });

    expect(r.statusCode).toBe(400);
    expect(r.headers["x-ratelimit-limit"]).toBe("10");
  });

  it("everything else keeps the global limit", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.headers["x-ratelimit-limit"]).toBe(String(GLOBAL_RATE_LIMIT));
  });

  it("the demo limit is configured ahead of its route", async () => {
    // POST /api/auth/demo lands in Task 15; design/api.md fixes it at 5/min and
    // the limiter map carries it now so the route only has to reference it.
    expect(AUTH_RATE_LIMITS.demo.max).toBe(5);
    expect(AUTH_RATE_LIMITS.login.max).toBe(10);
    expect(AUTH_RATE_LIMITS.signup.max).toBe(10);
  });
});

describe("rate-limit key behind the proxy", () => {
  const post = (forwardedFor: string) =>
    app.inject({
      method: "POST",
      url: "/probe/limited",
      headers: { origin: APP_ORIGIN, "x-forwarded-for": forwardedFor },
    });

  it("a client cannot escape its bucket by sending its own X-Forwarded-For", async () => {
    // Production topology: the platform's proxy *appends* the connecting
    // address to whatever X-Forwarded-For the client sent, so a request from a
    // client that forged the header arrives as "<forged>, <real client>".
    // `trustProxy: 1` (app.ts) trusts exactly that one appended hop, so the key
    // is the last entry — the address the proxy observed, which the client
    // cannot choose. Without it, the first entry would win and every attacker
    // would get a fresh bucket per request, making the limits decorative.
    const first = await post(IP.victim);
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-ratelimit-remaining"]).toBe("1");

    // Same client, now prepending an address of its choosing: same bucket.
    const spoofed = await post(`${SPOOFED}, ${IP.victim}`);
    expect(spoofed.statusCode).toBe(200);
    expect(spoofed.headers["x-ratelimit-remaining"]).toBe("0");

    const exhausted = await post(`${SPOOFED}, ${IP.victim}`);
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.json().error).toMatchObject({ code: "rate_limited" });
  });

  it("a genuinely different client still gets its own bucket", async () => {
    // The other half of the proof: the key is not simply constant. A request
    // the proxy saw coming from a different address counts separately, even
    // when the forged prefix is identical to the exhausted client's.
    const r = await post(`${SPOOFED}, ${IP.otherClient}`);

    expect(r.statusCode).toBe(200);
    expect(r.headers["x-ratelimit-remaining"]).toBe("1");
  });
});
