import { z } from "zod";
import { timestamp, uuid } from "./common.js";

/**
 * RFC 5321 caps an address at 254 characters.
 *
 * The messages here are written to be read by a person, because they are: the
 * API puts them in the envelope's `details`, and the web app feeds the same
 * schemas to its react-hook-form resolver and renders them under the field.
 * Zod's defaults ("Too small: expected string to have >=8 characters") are
 * diagnostics, not copy. Keeping the wording beside the rule is the same
 * argument as keeping the rule here at all — one edit, both sides.
 */
const email = z
  .email({ error: "Enter a valid email address" })
  .max(254, { error: "Email address is too long" });

/**
 * Password policy is length-only by design (no composition rules). The
 * common-password list check is a server-side concern — it needs a bundled
 * ~10k-entry list that has no business in a browser bundle.
 */
export const signupBody = z.object({
  email,
  password: z
    .string()
    .min(8, { error: "Password must be at least 8 characters" })
    .max(128, { error: "Password must be at most 128 characters" }),
});

/**
 * Login deliberately does *not* re-apply the signup length rules: they would
 * reject credentials issued under an older policy, and a rejected-too-early
 * login leaks which passwords could exist. The max is kept as an argon2 input
 * bound.
 */
export const loginBody = z.object({
  email,
  password: z
    .string()
    .min(1, { error: "Enter your password" })
    .max(128, { error: "Password must be at most 128 characters" }),
});

/** Output shape. `passwordHash` is absent — the hash never leaves the repository layer. */
export const userDto = z.object({
  id: uuid,
  email: z.email(),
  isDemo: z.boolean(),
  createdAt: timestamp,
});

export type SignupBody = z.infer<typeof signupBody>;
export type LoginBody = z.infer<typeof loginBody>;
export type User = z.infer<typeof userDto>;
