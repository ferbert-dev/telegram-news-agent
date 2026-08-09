import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawName = process.argv.slice(2).join("_").trim();
const migrationName = rawName
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

if (!migrationName) {
  throw new Error("Migration name is required, for example: npm run database:new -- add_story_relationships");
}

const timestamp = new Date()
  .toISOString()
  .replace(/[-:T]/g, "")
  .slice(0, 14);
const filename = `${timestamp}_${migrationName}.sql`;
const migrationPath = path.join(root, "db", "migrations", filename);

try {
  await writeFile(
    migrationPath,
    `-- ${migrationName.replaceAll("_", " ")}\n`,
    { encoding: "utf8", flag: "wx" },
  );
} catch (error) {
  if (error.code === "EEXIST") {
    throw new Error(`Migration already exists: ${filename}`);
  }
  throw error;
}

console.log(JSON.stringify({ event: "migration_created", filename }));
