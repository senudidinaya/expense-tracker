import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { z } from "zod";
import {
  userDto,
  type LoginBody,
  type SignupBody,
  type User,
} from "@expense/shared";
import {
  ApiError,
  AUTH_EXPIRED_EVENT,
  apiFetch,
  noContent,
} from "../api/client";

/** Every auth route answers with the same envelope. */
const userResponse = z.object({ user: userDto });

export interface AuthValue {
  /** `null` once bootstrapped and signed out; also `null` while bootstrapping. */
  user: User | null;
  /** `loading` until `GET /auth/me` has answered once, `ready` forever after. */
  status: "loading" | "ready";
  signup: (body: SignupBody) => Promise<void>;
  login: (body: LoginBody) => Promise<void>;
  demo: () => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthValue | null>(null);

/**
 * Where to send someone whose session is gone, remembering where they were.
 *
 * DECIDED (plan Task 18): re-authentication is a full navigation to `/login`,
 * and a successful login returns to `next`. In-progress form state is lost. A
 * modal re-auth over the current screen would preserve it, but it means
 * maintaining two login surfaces — a page and a dialog — with two sets of
 * error states, for a case that costs a signed-in user one re-typed form
 * every thirty days. This app does not earn that.
 */
function loginPathFrom(pathname: string, search: string): string {
  return `/login?next=${encodeURIComponent(pathname + search)}`;
}

/**
 * `next` arrives from the URL, so it is attacker-controllable: a link to
 * `/login?next=https://evil.example` would turn our own redirect into an open
 * redirect. Only a same-site absolute path is accepted — and `//host` is
 * rejected explicitly, because it is protocol-relative and reads as a path
 * right up until the browser resolves it.
 */
function safeNext(value: string | null): string {
  if (value === null) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthValue["status"]>("loading");
  const navigate = useNavigate();
  const location = useLocation();

  // Bootstrap. The session lives in an httpOnly cookie, so the only way to
  // learn whether there is one is to ask the server.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { user: me } = await apiFetch(userResponse, "/auth/me");
        if (!cancelled) setUser(me);
      } catch {
        // Every failure means the same thing here — 401, offline, a bad
        // gateway: we cannot prove there is a session, so there isn't one.
        // The route guard takes it from here.
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setStatus("ready");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // The listener for the event `apiFetch` raises on a 401, and the only place
  // in the app that turns "the session is gone" into a navigation.
  //
  // It is mounted ONLY while someone is signed in, which is what keeps a
  // failed login from bouncing the login page onto itself: a 401 from
  // `POST /auth/login` is a wrong password, not an expiry, and with no user
  // there is nothing to expire. The form shows the ApiError instead.
  const signedIn = user !== null;
  useEffect(() => {
    if (!signedIn) return;

    const onExpired = () => {
      setUser(null);
      void navigate(loginPathFrom(location.pathname, location.search), {
        replace: true,
      });
    };

    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [signedIn, location.pathname, location.search, navigate]);

  const next = safeNext(new URLSearchParams(location.search).get("next"));

  const authenticate = useCallback(
    async (path: string, body?: SignupBody | LoginBody) => {
      const result = await apiFetch(userResponse, path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      setUser(result.user);
      // `replace`, so Back from the dashboard does not land on the login form
      // the user has already cleared.
      void navigate(next, { replace: true });
    },
    [navigate, next],
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch(noContent, "/auth/logout", { method: "POST" });
    } catch (error) {
      // A logout that fails because the session was already gone has done its
      // job. Anything else the server says is not a reason to keep someone
      // inside an app they asked to leave — but a bug in this layer still is.
      if (!(error instanceof ApiError)) throw error;
    }
    // Clearing the user is the whole of it. `RequireAuth` is already mounted
    // above every screen that has a Sign out button, so dropping the user
    // redirects to `/login?next=…` on the next render. Navigating here as well
    // put two redirects in flight for one click, and the guard won the race
    // anyway — a second mechanism that only ever decided nothing.
    setUser(null);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      status,
      signup: (body) => authenticate("/auth/signup", body),
      login: (body) => authenticate("/auth/login", body),
      demo: () => authenticate("/auth/demo"),
      logout,
    }),
    [user, status, authenticate, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
