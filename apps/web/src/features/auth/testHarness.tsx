import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { Outlet, RouterProvider, createMemoryRouter } from "react-router";
import {
  errorEnvelope,
  type ErrorCode,
  type ErrorDetail,
} from "@expense/shared";
import { AuthProvider } from "../../auth/AuthContext";

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function envelopeResponse(
  status: number,
  code: ErrorCode,
  message: string,
  details?: ErrorDetail[],
): Response {
  return jsonResponse(status, errorEnvelope(code, message, details));
}

/**
 * The bootstrap `GET /auth/me` answer for a visitor with no session. Every
 * test on these pages needs it, and none of them are about it.
 */
export const noSession = () =>
  envelopeResponse(401, "unauthorized", "Not signed in");

/**
 * Mounts an auth page the way the router does: inside `AuthProvider`, on a
 * real (in-memory) router, with `/` and `/expenses` reachable so a successful
 * submit has somewhere to land.
 *
 * The provider is not stubbed. It is under test as much as the page is — it
 * owns the `?next=` redirect and the decision that a 401 from a login form is
 * a wrong password rather than an expiry — and a fake in its place would let
 * the page pass against a contract the app does not actually have.
 */
export function renderAuthPage(
  element: ReactElement,
  { route = "/login" }: { route?: string } = {},
) {
  const router = createMemoryRouter(
    [
      {
        element: (
          <AuthProvider>
            <Outlet />
          </AuthProvider>
        ),
        children: [
          { path: "/login", element },
          { path: "/signup", element },
          { path: "/", element: <h1>Dashboard</h1> },
          { path: "/expenses", element: <h1>Expenses</h1> },
        ],
      },
    ],
    { initialEntries: [route] },
  );

  return { router, ...render(<RouterProvider router={router} />) };
}
