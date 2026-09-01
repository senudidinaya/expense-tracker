import { useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { Button } from "../../components/ui/Button";
import { AuthCard } from "./AuthCard";

/**
 * TEMPORARY SHAPE — Task 19 replaces the body of this file with the real
 * email/password form (react-hook-form + the shared `loginBody` resolver,
 * inline field errors, opaque single error on a bad password).
 *
 * What is here now is the demo button, which is the one credential-free path
 * through the whole stack: it exercises `apiFetch` → `useAuth` → the
 * `?next=` redirect → the authed shell, so Task 18 is verifiable end to end
 * instead of only up to the redirect. Task 19 keeps this button; it is part
 * of the finished page.
 */
export function LoginPage() {
  const { demo } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onDemo() {
    setError(null);
    setPending(true);
    try {
      await demo();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not reach the server.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthCard
      title="Sign in"
      subtitle="The email and password form arrives in Task 19."
      error={error}
      footer={
        <>
          No account?{" "}
          <Link
            to="/signup"
            className="font-medium text-accent underline underline-offset-4"
          >
            Sign up
          </Link>
        </>
      }
    >
      <Button variant="primary" loading={pending} onClick={() => void onDemo()}>
        Try the demo
      </Button>
    </AuthCard>
  );
}
