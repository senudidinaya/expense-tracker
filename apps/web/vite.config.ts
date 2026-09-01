import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    proxy: {
      // Production serves the SPA and the API from one origin; dev has to look
      // the same or none of the security model works — a cross-origin XHR
      // would not carry the SameSite=Lax session cookie, and the API's CSRF
      // check compares `Origin` against APP_ORIGIN, which is this dev server.
      //
      // `changeOrigin` stays off (its default): it rewrites `Host`, and while
      // it leaves `Origin` alone, turning it on invites the assumption that
      // rewriting headers here is harmless. It is not — the API is reading one
      // of them.
      "/api": { target: "http://localhost:3000" },
    },
  },

  test: {
    // The app is a browser app: `window.dispatchEvent`, `Headers`, and every
    // component test that follows need a DOM. `apps/web` has no other
    // environment, so this is set once here rather than per file.
    environment: "jsdom",
  },
});
