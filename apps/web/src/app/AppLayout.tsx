import { NavLink, Outlet } from "react-router";
import { Button } from "../components/ui/Button";
import { useAuth } from "../auth/useAuth";
import { cn } from "../lib/cn";

/** The four pages behind the session. `end` so `/` is not active everywhere. */
const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/expenses", label: "Expenses", end: false },
  { to: "/budgets", label: "Budgets", end: false },
  { to: "/settings", label: "Settings", end: false },
] as const;

export function AppLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen bg-bg">
      <nav
        aria-label="Main"
        className="flex w-48 shrink-0 flex-col gap-6 border-r border-border bg-surface px-3 py-6"
      >
        <span className="px-3 text-sm font-semibold text-text">Expenses</span>

        <ul className="flex flex-col gap-1">
          {NAV.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "block rounded-md px-3 py-2 text-sm transition-colors duration-100",
                    isActive
                      ? "bg-accent-subtle font-medium text-accent"
                      : "text-muted hover:bg-surface-hover hover:text-text",
                  )
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="mt-auto flex flex-col items-start gap-2 px-3">
          {/* An email is longer than the sidebar; truncating beats wrapping a
              nav into two lines, and the title attribute keeps it readable. */}
          <span
            className="max-w-full truncate text-xs text-muted"
            title={user?.email}
          >
            {user?.email}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </nav>

      <main className="min-w-0 flex-1 px-6 py-8">
        <div className="mx-auto flex max-w-page flex-col gap-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
