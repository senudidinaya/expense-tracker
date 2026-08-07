import { PostgreSqlContainer } from "@testcontainers/postgresql";

export async function startTestDb() {
  const c = await new PostgreSqlContainer("postgres:16").start();
  return { url: c.getConnectionUri(), stop: () => c.stop() };
}
