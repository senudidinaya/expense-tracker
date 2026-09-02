import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { loginBody, type LoginBody } from "@expense/shared";
import { useAuth } from "../../auth/useAuth";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { AuthCard } from "./AuthCard";
import { authErrorMessage } from "./authError";

/**
 * Sign in, plus the credential-free way past it.
 *
 * The resolver is the shared `loginBody` — the same object the API's route
 * declares — so the client refuses exactly what the server would and nothing
 * more. Note what that means here: `loginBody` requires a non-empty password,
 * not an 8-character one. Re-applying the signup rule would reject a valid
 * credential issued under an older policy, and it would tell an attacker
 * which passwords are worth trying. The shared schema already made that
 * decision; importing it is how the form inherits it.
 *
 * Redirect-back is not implemented here. `AuthContext.authenticate` reads and
 * validates `?next=` and navigates; a second reader of that parameter would be
 * a second place for the open-redirect check to be got wrong.
 */
export function LoginPage() {
  const { login, demo } = useAuth();
  const [banner, setBanner] = useState<string | null>(null);
  const [demoPending, setDemoPending] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginBody>({
    resolver: zodResolver(loginBody),
    defaultValues: { email: "", password: "" },
  });

  // `handleSubmit` runs the resolver first, so nothing below this line executes
  // until the shared schema is satisfied — a malformed email never becomes a
  // request. It also holds `isSubmitting` true for as long as the returned
  // promise is pending, which is what disables the button for the whole flight
  // rather than for a render.
  const onSubmit = handleSubmit(async (values) => {
    setBanner(null);
    try {
      await login(values);
    } catch (caught) {
      setBanner(authErrorMessage(caught));
    }
  });

  async function onDemo() {
    setBanner(null);
    setDemoPending(true);
    try {
      await demo();
    } catch (caught) {
      // Capacity (503 `demo_unavailable`) lands here like any other envelope,
      // and says what the API says: the demo is full, come back shortly.
      setBanner(authErrorMessage(caught));
    } finally {
      setDemoPending(false);
    }
  }

  const busy = isSubmitting || demoPending;

  return (
    <AuthCard
      title="Sign in"
      subtitle="Track what you spend, in rupees."
      error={banner}
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
      {/* `noValidate`: the browser's own bubbles would fire before the
          resolver and say something the shared schema did not. One validator. */}
      <form noValidate onSubmit={(event) => void onSubmit(event)}>
        <div className="flex flex-col gap-4">
          <Input
            {...register("email")}
            label="Email"
            type="email"
            autoComplete="email"
            autoFocus
            error={errors.email?.message}
          />
          <Input
            {...register("password")}
            label="Password"
            type="password"
            autoComplete="current-password"
            error={errors.password?.message}
          />
          <Button
            type="submit"
            variant="primary"
            loading={isSubmitting}
            disabled={busy}
          >
            Sign in
          </Button>
        </div>
      </form>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <p className="text-sm text-muted">
          Or look around first — the demo signs you into a throwaway account
          with a year of expenses already in it.
        </p>
        <Button
          variant="secondary"
          loading={demoPending}
          disabled={busy}
          onClick={() => void onDemo()}
        >
          Try the demo
        </Button>
      </div>
    </AuthCard>
  );
}
