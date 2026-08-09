import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "db", "migrations");
const connectionString = process.env.DATABASE_URL?.trim();

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const filenames = (await readdir(migrationDirectory))
  .filter((entry) => entry.endsWith(".sql"))
  .sort((left, right) => left.localeCompare(right));
const local = new Map();

for (const filename of filenames) {
  const contents = await readFile(path.join(migrationDirectory, filename), "utf8");
  local.set(
    filename,
    createHash("sha256").update(contents).digest("hex"),
  );
}

const pool = new Pool({ connectionString, max: 1 });

try {
  const table = await pool.query(
    "select to_regclass('public.schema_migrations') is not null as exists",
  );
  const appliedRows = table.rows[0]?.exists
    ? (
        await pool.query(
          "select filename, checksum, applied_at from public.schema_migrations order by filename",
        )
      ).rows
    : [];
  const applied = new Map(appliedRows.map((row) => [row.filename, row]));
  const status = [];

  for (const [filename, digest] of local) {
    const row = applied.get(filename);
    status.push({
      filename,
      status: !row ? "pending" : row.checksum === digest ? "applied" : "changed",
      appliedAt: row?.applied_at ?? null,
    });
  }

  for (const row of appliedRows) {
    if (!local.has(row.filename)) {
      status.push({
        filename: row.filename,
        status: "missing_locally",
        appliedAt: row.applied_at,
      });
    }
  }

  const counts = status.reduce((result, entry) => {
    result[entry.status] = (result[entry.status] ?? 0) + 1;
    return result;
  }, {});

  console.table(status);
  console.log(JSON.stringify({ event: "migration_status", counts }));

  if (counts.changed || counts.missing_locally) {
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
