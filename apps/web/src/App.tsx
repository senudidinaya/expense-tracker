import { KitchenSink } from "./kitchen/KitchenSink";

/**
 * Placeholder shell. Task 18 replaces this file with the real router
 * (React Router, auth-gated layout) and deletes the `/_kitchen` branch below
 * along with `src/kitchen/`.
 *
 * The pathname check stands in for a router on purpose — pulling React Router
 * in one task early, purely to reach a scratch page, would put the routing
 * decision in the wrong diff.
 */
export default function App() {
  if (window.location.pathname === "/_kitchen") {
    return <KitchenSink />;
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg px-6 text-center">
      <h1 className="text-2xl font-semibold text-text">Expense tracker</h1>
      <p className="text-sm text-muted">
        No screens yet — the app shell arrives in Task 18.
      </p>
      <a
        href="/_kitchen"
        className="text-sm font-medium text-accent underline underline-offset-4"
      >
        View the UI kit
      </a>
    </main>
  );
}
