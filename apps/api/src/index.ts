import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { loadEnv } from "./env.js";

const env = loadEnv();

// Fail closed: an app running against a half-migrated database is worse than an
// app that refuses to start. This runs before anything listens.
try {
  await runMigrations(env.DATABASE_URL);
} catch (err) {
  console.error("migrations failed, refusing to start", err);
  process.exit(1);
}

const { db, sql } = createDb(env.DATABASE_URL);
const app = await buildApp({ db, env });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app
      .close()
      .then(() => sql.end())
      .then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error({ err }, "failed to listen");
  process.exit(1);
}
