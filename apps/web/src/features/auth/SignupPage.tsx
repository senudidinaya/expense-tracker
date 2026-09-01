import { Link } from "react-router";
import { AuthCard } from "./AuthCard";

/**
 * TEMPORARY SHAPE — Task 19 fills this in with the real form (shared
 * `signupBody` resolver, inline field errors, 409 on a taken email). The
 * route exists now so the shell's public half is complete and `/signup` is
 * not a 404 from the login page.
 */
export function SignupPage() {
  return (
    <AuthCard
      title="Create an account"
      subtitle="The signup form arrives in Task 19."
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
    />
  );
}
