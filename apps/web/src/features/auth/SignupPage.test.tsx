import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignupPage } from "./SignupPage";
import {
  envelopeResponse,
  jsonResponse,
  noSession,
  renderAuthPage,
} from "./testHarness";

const user = {
  id: "0192f1d6-0000-7000-8000-000000000001",
  email: "new@example.test",
  isDemo: false,
  createdAt: "2026-09-01T00:00:00.000Z",
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

/** Requests to `POST /api/auth/signup`, whatever else the app also fetched. */
function signupCalls() {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).endsWith("/api/auth/signup"),
  );
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
    if (String(input).endsWith("/api/auth/me")) {
      return Promise.resolve(noSession());
    }
    throw new Error(`unmocked request: ${String(input)}`);
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
  await person.click(screen.getByRole("button", { name: "Create account" }));
  return person;
}

describe("SignupPage", () => {
  // The point of resolving against the shared schema rather than posting and
  // reading the 400 back. If this ever passes only because the server said no,
  // the shared package has stopped earning its keep.
  it("rejects a short password in the browser, without calling the API", async () => {
    renderAuthPage(<SignupPage />, { route: "/signup" });

    await fillAndSubmit("new@example.test", "short");

    expect(
      await screen.findByText("Password must be at least 8 characters"),
    ).toBeInTheDocument();
    expect(signupCalls()).toHaveLength(0);
  });

  // The inline/banner split, from the other side: a field error is attached to
  // its input, so it is what the input is described by. The banner is not.
  it("attaches the field error to the password input, not to the banner", async () => {
    renderAuthPage(<SignupPage />, { route: "/signup" });

    await fillAndSubmit("new@example.test", "short");

    const password = await screen.findByLabelText("Password");
    expect(password).toHaveAccessibleDescription(
      "Password must be at least 8 characters",
    );
    expect(password).toBeInvalid();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the API's already-registered wording in the banner on a 409", async () => {
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith("/api/auth/me")) {
        return Promise.resolve(noSession());
      }
      return Promise.resolve(
        envelopeResponse(
          409,
          "conflict",
          "That email address is already registered",
        ),
      );
    });

    renderAuthPage(<SignupPage />, { route: "/signup" });
    await fillAndSubmit("taken@example.test", "correct-horse");

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(
      "That email address is already registered",
    );
    // Not pinned to a field: the API is refusing the submission, and pointing
    // at the email input would be the client asserting more than the API did.
    expect(screen.getByLabelText("Email")).not.toBeInvalid();
  });

  // The one signup rule the client cannot hold: the wordlist lives on the
  // server, so this 400 is real information rather than a client bug. Its
  // message is in `details` — `validation_failed`'s envelope message is the
  // generic "Invalid request".
  it("surfaces the common-password 400's detail message in the banner", async () => {
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith("/api/auth/me")) {
        return Promise.resolve(noSession());
      }
      return Promise.resolve(
        envelopeResponse(400, "validation_failed", "Invalid request", [
          {
            path: "password",
            message:
              "password is among the most commonly used — choose a less predictable one",
          },
        ]),
      );
    });

    renderAuthPage(<SignupPage />, { route: "/signup" });
    await fillAndSubmit("new@example.test", "password1234");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "password is among the most commonly used",
    );
  });

  it("disables the submit button while the request is in flight", async () => {
    // A signup that never settles: the button's disabled state is a property
    // of the flight, so the test has to hold the flight open to observe it.
    let release!: (response: Response) => void;
    const inFlight = new Promise<Response>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith("/api/auth/me")) {
        return Promise.resolve(noSession());
      }
      return inFlight;
    });

    renderAuthPage(<SignupPage />, { route: "/signup" });
    await fillAndSubmit("new@example.test", "correct-horse");

    const submit = screen.getByRole("button", { name: "Create account" });
    await waitFor(() => {
      expect(submit).toBeDisabled();
    });
    expect(submit).toHaveAttribute("aria-busy", "true");
    // Disabled is the whole of the double-submit guard: a second click while
    // the first is open must not reach the API.
    await userEvent.click(submit);
    expect(signupCalls()).toHaveLength(1);

    release(jsonResponse(201, { user }));
    expect(
      await screen.findByRole("heading", { name: "Dashboard" }),
    ).toBeInTheDocument();
  });

  it("lands on the dashboard after a successful signup", async () => {
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith("/api/auth/me")) {
        return Promise.resolve(noSession());
      }
      return Promise.resolve(jsonResponse(201, { user }));
    });

    renderAuthPage(<SignupPage />, { route: "/signup" });
    await fillAndSubmit("new@example.test", "correct-horse");

    expect(
      await screen.findByRole("heading", { name: "Dashboard" }),
    ).toBeInTheDocument();
  });
});
