import { useContext } from "react";
import { AuthContext, type AuthValue } from "./AuthContext";

/**
 * The session, and the four things you can do to it.
 *
 * Throws outside the provider rather than handing back a null-ish default: a
 * component that renders "signed out" because it was mounted in the wrong
 * place is a bug that looks like a feature.
 */
export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return value;
}
