import { COMMON_PASSWORDS_RAW } from "./common-passwords.js";

/**
 * Split once at module load. A Set turns the check into a hash lookup; scanning
 * the newline-delimited blob per signup would put a few thousand string
 * comparisons on a request path for no benefit.
 */
const COMMON_PASSWORDS = new Set(COMMON_PASSWORDS_RAW.split("\n"));

/**
 * How many distinct passwords the check actually consults. Exported so a test
 * can assert the list is a real wordlist without naming entries in it — a named
 * entry only proves that one string is present, and guessing at membership is
 * how you get a test that fails on a wordlist that is perfectly fine.
 */
export const commonPasswordCount = COMMON_PASSWORDS.size;

/**
 * design/api.md: signup rejects passwords from the bundled common-password list.
 * Length is the only other rule — no composition requirements, which push users
 * toward `Password1!` and are exactly what this list already contains.
 *
 * The lookup lowercases because the list does: "Password1234" is the same guess
 * as "password1234", and capitalising the first letter is a transformation every
 * cracking ruleset applies for free.
 */
export const isCommonPassword = (password: string): boolean =>
  COMMON_PASSWORDS.has(password.toLowerCase());
