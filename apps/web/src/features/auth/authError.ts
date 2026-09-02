import { ApiError } from "../../api/client";

/**
 * Turns whatever a failed auth call threw into the one line the banner shows.
 *
 * There are two classes of error on these screens and they are rendered
 * differently on purpose. A zod failure belongs to a field — the user typed
 * something we can point at — so react-hook-form renders it under that input.
 * Everything the *server* decided belongs to the submission as a whole: a
 * taken email, a rejected credential pair, a demo at capacity. None of those
 * identify an input to point at (saying "wrong password" would be a claim the
 * API refuses to make), so they go to the banner above the form.
 *
 * `message` is rendered verbatim wherever it exists: the envelope's message is
 * written for users, and rewriting it here would put a second copy of the
 * API's wording in the client, free to drift.
 */
export function authErrorMessage(caught: unknown): string {
  if (!(caught instanceof ApiError)) {
    // Not an envelope at all — `fetch` itself rejected. Offline, DNS, a
    // connection dropped mid-flight.
    return "Could not reach the server. Check your connection and try again.";
  }

  // `validation_failed` is the one code whose top-level message is generic
  // ("Invalid request"): the sentence written for the user sits in `details`,
  // because the envelope is shaped for a field-by-field client. The web app's
  // own zod resolver has already caught everything the schema can catch, so a
  // 400 arriving here is a rule only the server holds — today that is the
  // common-password list. Its detail is the message worth showing.
  if (caught.code === "validation_failed") {
    const detail = caught.details?.[0]?.message;
    if (detail !== undefined) return detail;
  }

  return caught.message;
}
