import { Navigate, Outlet, useLocation } from "react-router";
import { Spinner } from "../components/ui/Button";
import { useAuth } from "./useAuth";

/**
 * The gate in front of every authenticated route.
 *
 * This handles the *deep link* case — arriving at `/expenses` with no session
 * — which is not the same as the expiry case in `AuthContext`: here there was
 * never a session to lose, so nothing has been dispatched and nothing needs
 * clearing. Both funnel through the same `?next=` so the two paths cannot
 * disagree about where the user comes back to.
 */
export function RequireAuth() {
  const { user, status } = useAuth();
  const location = useLocation();

  // Redirecting before `GET /auth/me` answers would bounce every signed-in
  // user through the login page on a hard refresh.
  if (status === "loading") {
    return (
      <div
        role="status"
        aria-label="Loading"
        className="flex min-h-screen items-center justify-center bg-bg text-muted"
      >
        <Spinner />
      </div>
    );
  }

  if (user === null) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return <Outlet />;
}
