import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectories = [path.join(root, "db", "migrations")];

async function migrationFiles() {
  const files = [];
  for (const directory of migrationDirectories) {
    const names = await readdir(directory).catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    for (const name of names.filter((entry) => entry.endsWith(".sql"))) {
      files.push({ name, path: path.join(directory, name) });
    }
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

function checksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString, max: 1 });
const client = await pool.connect();

try {
  await client.query(
    "select pg_advisory_lock(hashtext('telegram-news-agent-migrations'))",
  );
  await client.query(`
    create table if not exists public.schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);

  for (const migration of await migrationFiles()) {
    const sql = await readFile(migration.path, "utf8");
    const digest = checksum(sql);
    const existing = await client.query(
      "select checksum from public.schema_migrations where filename = $1",
      [migration.name],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== digest) {
        throw new Error(
          `Migration ${migration.name} changed after it was applied`,
        );
      }
      continue;
    }

    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into public.schema_migrations (filename, checksum) values ($1, $2)",
        [migration.name, digest],
      );
      await client.query("commit");
      console.log(JSON.stringify({ event: "migration_applied", migration: migration.name }));
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  await client
    .query("select pg_advisory_unlock(hashtext('telegram-news-agent-migrations'))")
    .catch(() => {});
  client.release();
  await pool.end();
}
