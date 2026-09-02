import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { signupBody, type SignupBody } from "@expense/shared";
import { useAuth } from "../../auth/useAuth";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { AuthCard } from "./AuthCard";
import { authErrorMessage } from "./authError";

/**
 * Create an account.
 *
 * The resolver is the shared `signupBody`, so the 8-character minimum is
 * enforced here by the same object the API's route declares — a short password
 * never leaves the browser. What the client cannot check is list membership:
 * `isCommonPassword` needs a bundled wordlist that has no business in a
 * browser bundle, so that rule stays server-side and comes back as a 400. It
 * lands in the banner rather than under the password field because it is a
 * decision the server made about a submission we already believed was valid.
 *
 * A taken address is a 409, and the banner shows the API's own wording. It
 * confirms nothing the API has not already confirmed by answering 409 at all:
 * signup cannot both reject duplicates and hide that it is doing so. Login is
 * where the address must stay unknowable, and it does — see `LoginPage`.
 */
export function SignupPage() {
  const { signup } = useAuth();
  const [banner, setBanner] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupBody>({
    resolver: zodResolver(signupBody),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setBanner(null);
    try {
      await signup(values);
    } catch (caught) {
      setBanner(authErrorMessage(caught));
    }
  });

  return (
    <AuthCard
      title="Create an account"
      subtitle="Track what you spend, in rupees."
      error={banner}
      footer={
        <>
          Already have an account?{" "}
          <Link
            to="/login"
            className="font-medium text-accent underline underline-offset-4"
          >
            Sign in
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
            autoComplete="new-password"
            hint="At least 8 characters."
            error={errors.password?.message}
          />
          <Button type="submit" variant="primary" loading={isSubmitting}>
            Create account
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
