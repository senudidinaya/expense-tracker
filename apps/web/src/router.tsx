import { Outlet, createBrowserRouter } from "react-router";
import { AppLayout } from "./app/AppLayout";
import { NotFoundPage } from "./app/NotFoundPage";
import { AuthProvider } from "./auth/AuthContext";
import { RequireAuth } from "./auth/RequireAuth";

/**
 * `AuthProvider` sits inside the router, not around it: it navigates (on
 * expiry, and after a successful login to `?next=`), so it needs the router's
 * hooks. Wrapping `<RouterProvider>` would put it outside the context it
 * depends on.
 */
function RootLayout() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

/**
 * Every page is code-split at the route. The shell — provider, guard, sidebar
 * — is in the entry chunk because it renders on every path; nothing else is.
 * Splitting here rather than per component means a route's whole subtree,
 * including the query hooks it will grow in Tasks 20–23, comes down as one
 * chunk on first visit.
 */
export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      {
        path: "login",
        lazy: async () => ({
          Component: (await import("./features/auth/LoginPage")).LoginPage,
        }),
      },
      {
        path: "signup",
        lazy: async () => ({
          Component: (await import("./features/auth/SignupPage")).SignupPage,
        }),
      },
      {
        // Two nested layout routes with one job each: the guard decides
        // whether anything below renders at all, the shell decides what it
        // looks like. Folding them together would make the sidebar's
        // existence a fact about authentication.
        element: <RequireAuth />,
        children: [
          {
            element: <AppLayout />,
            children: [
              {
                index: true,
                lazy: async () => ({
                  Component: (await import("./features/reports/DashboardPage"))
                    .DashboardPage,
                }),
              },
              {
                path: "expenses",
                lazy: async () => ({
                  Component: (await import("./features/expenses/ExpensesPage"))
                    .ExpensesPage,
                }),
              },
              {
                path: "budgets",
                lazy: async () => ({
                  Component: (await import("./features/budgets/BudgetsPage"))
                    .BudgetsPage,
                }),
              },
              {
                path: "settings",
                lazy: async () => ({
                  Component: (await import("./features/settings/SettingsPage"))
                    .SettingsPage,
                }),
              },
            ],
          },
        ],
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
