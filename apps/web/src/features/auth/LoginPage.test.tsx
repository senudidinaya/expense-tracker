import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";
import {
  envelopeResponse,
  jsonResponse,
  noSession,
  renderAuthPage,
} from "./testHarness";

const user = {
  id: "0192f1d6-0000-7000-8000-000000000002",
  email: "someone@example.test",
  isDemo: false,
  createdAt: "2026-09-01T00:00:00.000Z",
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function callsTo(path: string) {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).endsWith(`/api${path}`),
  );
}

/**
 * `GET /auth/me` always answers "no session"; everything else answers with
 * `rest`. Each test supplies only the response it is about.
 */
function mockApi(rest: () => Response | Promise<Response>) {
  fetchMock.mockImplementation((input) =>
    String(input).endsWith("/api/auth/me")
      ? Promise.resolve(noSession())
      : Promise.resolve(rest()),
  );
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  mockApi(() => {
    throw new Error("unmocked request");
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fillAndSubmit(email: string, password: string) {
  const person = userEvent.setup();
  await person.type(screen.getByLabelText("Email"), email);
  await person.type(screen.getByLabelText("Password"), password);
  await person.click(screen.getByRole("button", { name: "Sign in" }));
  return person;
}

describe("LoginPage", () => {
  // `loginBody` accepts any non-empty password on purpose — the signup length
  // rule would reject credentials issued under an older policy and would tell
  // an attacker which passwords are worth trying. The form inherits that by
  // resolving against the shared schema, so the only thing it refuses to send
  // is an unparseable address.
  it("rejects a malformed email in the browser, without calling the API", async () => {
    renderAuthPage(<LoginPage />);

    await fillAndSubmit("not-an-email", "x");

    expect(
      await screen.findByText("Enter a valid email address"),
    ).toBeInTheDocument();
    expect(callsTo("/auth/login")).toHaveLength(0);
  });

  it("does not apply the signup length rule to a login password", async () => {
    mockApi(() => jsonResponse(200, { user }));

    renderAuthPage(<LoginPage />);
    await fillAndSubmit("someone@example.test", "short");

    // Six characters, and it still reaches the server: whether it is right is
    // the server's answer to give.
    await waitFor(() => {
      expect(callsTo("/auth/login")).toHaveLength(1);
    });
  });

  // The rule the whole screen is built around. The API answers identically for
  // "no such email" and "wrong password"; pinning the message to either input
  // would undo that from the client side.
  it("renders a 401 as one opaque banner, not as a field error", async () => {
    mockApi(() =>
      envelopeResponse(401, "unauthorized", "Invalid email or password"),
    );

    renderAuthPage(<LoginPage />);
    await fillAndSubmit("someone@example.test", "wrong-password");

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Invalid email or password");

    expect(screen.getByLabelText("Email")).not.toBeInvalid();
    expect(screen.getByLabelText("Password")).not.toBeInvalid();
    expect(screen.getByLabelText("Email")).not.toHaveAccessibleDescription();
    expect(screen.getByLabelText("Password")).not.toHaveAccessibleDescription();
  });

  // `apiFetch` fires `auth:expired` on every 401. `AuthContext` only listens
  // while someone is signed in, which is what keeps a failed login from
  // redirecting the login page onto itself.
  it("stays on the login page after a 401", async () => {
    mockApi(() =>
      envelopeResponse(401, "unauthorized", "Invalid email or password"),
    );

    const { router } = renderAuthPage(<LoginPage />, {
      route: "/login?next=%2Fexpenses",
    });
    await fillAndSubmit("someone@example.test", "wrong-password");

    await screen.findByRole("alert");
    expect(router.state.location.pathname).toBe("/login");
  });

  it("disables the submit button while the request is in flight", async () => {
    let release!: (response: Response) => void;
    const inFlight = new Promise<Response>((resolve) => {
      release = resolve;
    });
    mockApi(() => inFlight);

    renderAuthPage(<LoginPage />);
    await fillAndSubmit("someone@example.test", "correct-horse");

    const submit = screen.getByRole("button", { name: "Sign in" });
    await waitFor(() => {
      expect(submit).toBeDisabled();
    });
    expect(submit).toHaveAttribute("aria-busy", "true");
    // The double-submit guard, asserted rather than assumed.
    await userEvent.click(submit);
    expect(callsTo("/auth/login")).toHaveLength(1);
    // The demo is the other way out of this screen; it must not start a second
    // session race while a sign-in is open.
    expect(screen.getByRole("button", { name: "Try the demo" })).toBeDisabled();

    release(jsonResponse(200, { user }));
    await screen.findByRole("heading", { name: "Dashboard" });
  });

  it("returns to ?next= after a successful sign in", async () => {
    mockApi(() => jsonResponse(200, { user }));

    renderAuthPage(<LoginPage />, { route: "/login?next=%2Fexpenses" });
    await fillAndSubmit("someone@example.test", "correct-horse");

    expect(
      await screen.findByRole("heading", { name: "Expenses" }),
    ).toBeInTheDocument();
  });

  describe("the demo button", () => {
    it("signs in without credentials", async () => {
      mockApi(() => jsonResponse(201, { user: { ...user, isDemo: true } }));

      renderAuthPage(<LoginPage />);
      await userEvent.click(
        screen.getByRole("button", { name: "Try the demo" }),
      );

      expect(
        await screen.findByRole("heading", { name: "Dashboard" }),
      ).toBeInTheDocument();
      expect(callsTo("/auth/demo")).toHaveLength(1);
    });

    it("renders the capacity 503's message in the banner", async () => {
      mockApi(() =>
        envelopeResponse(
          503,
          "demo_unavailable",
          "The demo is at capacity right now — please try again in a little while",
        ),
      );

      renderAuthPage(<LoginPage />);
      await userEvent.click(
        screen.getByRole("button", { name: "Try the demo" }),
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The demo is at capacity right now",
      );
    });
  });
});
