import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";

export type DB = PostgresJsDatabase<typeof schema>;

export function connect(url = process.env.DATABASE_URL): { db: DB; sql: postgres.Sql } {
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  return { db: drizzle(sql, { schema }), sql };
}

/** Applies SQL migrations shipped in packages/core/drizzle. */
export async function runMigrations(db: DB, sql: postgres.Sql): Promise<void> {
  // Bot and hub both start here; an advisory lock keeps them from migrating at the same time.
  const lock = await sql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(727001)`;
    await lock`CREATE EXTENSION IF NOT EXISTS vector`;
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/db (or src/db in tests) -> ../../drizzle
    await migrate(db, { migrationsFolder: path.resolve(here, "../../drizzle") });
  } finally {
    await lock`SELECT pg_advisory_unlock(727001)`.catch(() => {});
    lock.release();
  }
}

export { schema };
