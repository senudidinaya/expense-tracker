import { z } from "zod";
import { zodErrorToDetails } from "@expense/shared";

/**
 * Every environment variable the API reads, validated once at boot. A missing or
 * malformed value is a startup failure, not a `undefined` that surfaces as a
 * confusing runtime error three layers deep.
 */
export const envSchema = z.object({
  DATABASE_URL: z.url(),

  /** Cookie signing key. 32 bytes is the floor for a secret worth having. */
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters"),

  /**
   * The single origin the app is served from. Stored as a bare origin (no path,
   * no trailing slash) because the CSRF check compares it to the `Origin`
   * header verbatim — a trailing slash there would fail every mutation.
   */
  APP_ORIGIN: z.url().refine((v) => new URL(v).origin === v, {
    message: "APP_ORIGIN must be a bare origin, e.g. https://example.com",
  }),

  SENTRY_DSN: z.string().min(1).optional(),

  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  /** Reported by `GET /health`; the container build passes the git sha. */
  APP_VERSION: z.string().min(1).default("dev"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses `process.env`, throwing with the offending keys and nothing else —
 * `zodErrorToDetails` drops the received values, so a crash log never contains
 * the database password that made the URL invalid.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = zodErrorToDetails(parsed.error)
      .map((d) => `${d.path}: ${d.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${problems}`);
  }
  return parsed.data;
}
