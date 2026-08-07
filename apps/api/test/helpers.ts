import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { randomBytes } from "node:crypto";

export async function startTestDb() {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  let base: string;
  let stopContainer = async () => {};
  if (process.env.TESTCONTAINERS_DISABLED === "1") {
    base = process.env.DATABASE_URL!; // CI service container
  } else {
    const c = await new PostgreSqlContainer("postgres:16").start();
    base = c.getConnectionUri();
    stopContainer = async () => {
      await c.stop();
    };
  }
  const admin = postgres(base);
  await admin.unsafe(`create schema "${schema}"`);
  await admin.end();
  // search_path = suite schema first, then public — unqualified DDL/DML
  // lands in the suite schema while the citext type (installed WITH
  // SCHEMA public, Task 2) still resolves.
  const url = `${base}?options=${encodeURIComponent(`-c search_path=${schema},public`)}`;
  return {
    url,
    schema,
    stop: async () => {
      const s = postgres(base);
      await s.unsafe(`drop schema "${schema}" cascade`);
      await s.end();
      await stopContainer();
    },
  };
}
