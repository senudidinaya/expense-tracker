import { z } from "zod";
import { timestamp, uuid } from "./common.js";

/** RFC 5321 caps an address at 254 characters. */
const email = z.email().max(254);

/**
 * Password policy is length-only by design (no composition rules). The
 * common-password list check is a server-side concern — it needs a bundled
 * ~10k-entry list that has no business in a browser bundle.
 */
export const signupBody = z.object({
  email,
  password: z.string().min(8).max(128),
});

/**
 * Login deliberately does *not* re-apply the signup length rules: they would
 * reject credentials issued under an older policy, and a rejected-too-early
 * login leaks which passwords could exist. The max is kept as an argon2 input
 * bound.
 */
export const loginBody = z.object({
  email,
  password: z.string().min(1).max(128),
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
