import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database, Queryable } from "./index.js";

const FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

/** Locate the repository migrations directory from source or compiled output. */
export function migrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "migrations");
    if (existsSync(join(candidate, "001_initial.sql"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error("accesslease: migrations directory not found");
}

const checksumOf = (sql: string) => createHash("sha256").update(sql).digest("hex");

function listMigrations(dir: string): { file: string; sql: string; checksum: string }[] {
  return readdirSync(dir)
    .filter((f) => FILE_PATTERN.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), "utf8");
      return { file, sql, checksum: checksumOf(sql) };
    });
}

/**
 * Apply pending migrations in order, each in its own transaction. A failed, modified or unknown
 * migration throws, which stops startup (and keeps /health/ready failing: AC-13).
 */
export async function migrate(db: Database, dir = migrationsDir()): Promise<{ applied: string[] }> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL)");
  const files = listMigrations(dir);
  const done = await db.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations");
  const known = new Map(done.rows.map((r) => [r.version, r.checksum]));
  for (const version of known.keys()) {
    if (!files.some((f) => f.file === version)) throw new Error(`accesslease: database has migration ${version} unknown to this build; refusing to start`);
  }
  const applied: string[] = [];
  for (const { file, sql, checksum } of files) {
    const previous = known.get(file);
    if (previous !== undefined) {
      if (previous !== checksum) throw new Error(`accesslease: applied migration ${file} was modified; refusing to start`);
      continue;
    }
    try {
      await db.transaction(async (tx) => {
        await tx.query(sql);
        await tx.query("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ($1, $2, now())", [file, checksum]);
      });
    } catch (error) {
      throw new Error(`accesslease: migration ${file} failed: ${(error as Error).message}`);
    }
    applied.push(file);
  }
  return { applied };
}

export interface MigrationStatus {
  ok: boolean;
  applied: string[];
  pending: string[];
  problem: string | null;
}

/** Read-only status used by readiness and `doctor`: ready only when every shipped migration is applied unmodified. */
export async function migrationStatus(db: Queryable, dir = migrationsDir()): Promise<MigrationStatus> {
  let rows: { version: string; checksum: string }[];
  try {
    rows = (await db.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations")).rows;
  } catch {
    return { ok: false, applied: [], pending: listMigrations(dir).map((f) => f.file), problem: "schema_migrations table is missing" };
  }
  const files = listMigrations(dir);
  const known = new Map(rows.map((r) => [r.version, r.checksum]));
  const pending = files.filter((f) => !known.has(f.file)).map((f) => f.file);
  const modified = files.find((f) => known.has(f.file) && known.get(f.file) !== f.checksum);
  const unknown = rows.find((r) => !files.some((f) => f.file === r.version));
  const problem = modified
    ? `applied migration ${modified.file} was modified`
    : unknown
      ? `database has migration ${unknown.version} unknown to this build`
      : pending.length > 0
        ? `pending migrations: ${pending.join(", ")}`
        : null;
  return { ok: problem === null, applied: [...known.keys()].sort(), pending, problem };
}
