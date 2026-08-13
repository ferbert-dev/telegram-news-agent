import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const sourceRoot = path.join(projectRoot, "src");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(target);
      }
      return entry.isFile() && target.endsWith(".ts") ? [target] : [];
    }),
  );
  return nested.flat().sort();
}

function importsOf(file: string, source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /^\s*import\s+["']([^"']+)["'];?/gm,
    /^\s*import(?:\s+type)?\s+[\s\S]*?\sfrom\s+["']([^"']+)["'];?/gm,
    /^\s*export(?:\s+type)?\s+[\s\S]*?\sfrom\s+["']([^"']+)["'];?/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  assert.ok(file.endsWith(".ts"));
  return [...specifiers];
}

function isDirectDatabasePackage(specifier: string): boolean {
  return /^pg(?:\/|$)/.test(specifier) || /^drizzle-orm(?:\/|$)/.test(specifier);
}

function relative(file: string): string {
  return path.relative(projectRoot, file).split(path.sep).join("/");
}

function isApplicationLayerFile(file: string): boolean {
  return (
    file.includes("/application/") ||
    /(?:^|\/)[^/]+-application(?:\.[^/]+)?\.ts$/.test(file) ||
    file.endsWith(".service.ts") ||
    file.endsWith(".use-case.ts")
  );
}

function assertApplicationDependencies(file: string, source: string): void {
  for (const specifier of importsOf(file, source)) {
    assert.equal(
      isDirectDatabasePackage(specifier),
      false,
      `${file} imports database package ${specifier}`,
    );
    assert.doesNotMatch(specifier, /(?:^|\/)database(?:\/|$)/, file);
    assert.doesNotMatch(specifier, /news-repository/, file);
    assert.doesNotMatch(specifier, /(?:^|\/)notion-audit(?:\.js)?$/, file);
    assert.doesNotMatch(specifier, /(?:^|\/)pipeline(?:\.js)?$/, file);
    assert.doesNotMatch(specifier, /(?:^|\/)draft(?:\.js)?$/, file);
    assert.doesNotMatch(specifier, /(?:^|\/)publish(?:\.js)?$/, file);
    assert.doesNotMatch(
      specifier,
      /(?:^|\/)publication-recovery(?:\.js)?$/,
      file,
    );
    assert.doesNotMatch(specifier, /(?:openai|gemini)-provider/, file);
    assert.doesNotMatch(specifier, /(?:^|\/)(?:openai|@google\/genai)(?:\/|$)/, file);
    assert.doesNotMatch(specifier, /telegram-(?:bot|polling)/, file);
    assert.doesNotMatch(specifier, /(?:^|\/)telegram(?:\.js)?$/, file);
    assert.doesNotMatch(specifier, /(?:^|\/)send-message(?:\.js)?$/, file);
    assert.doesNotMatch(specifier, /(?:\/transport\/|-transport\.)/, file);
    assert.doesNotMatch(specifier, /^(?:node:)?https?(?:\/|$)/, file);
    assert.doesNotMatch(specifier, /^(?:axios|undici)(?:\/|$)/, file);
  }
  assert.doesNotMatch(source, /\b(?:globalThis\.)?fetch\s*\(/, file);
}

function resolveRelativeImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const candidate = path.resolve(path.dirname(from), specifier).replace(/\.js$/, ".ts");
  return candidate;
}

const expectedPersistenceModules = new Map([
  ["src/catalog/catalog-persistence.module.ts", "CatalogPersistenceModule"],
  ["src/research/research-persistence.module.ts", "ResearchPersistenceModule"],
  ["src/editorial/editorial-persistence.module.ts", "EditorialPersistenceModule"],
  ["src/usage/usage-persistence.module.ts", "UsagePersistenceModule"],
  ["src/operations/operations-persistence.module.ts", "OperationsPersistenceModule"],
  ["src/settings/settings-persistence.module.ts", "SettingsPersistenceModule"],
  ["src/scheduler/scheduler-persistence.module.ts", "SchedulerPersistenceModule"],
  ["src/telegram/telegram-persistence.module.ts", "TelegramPersistenceModule"],
  [
    "src/story-deduplication/story-deduplication-persistence.module.ts",
    "StoryDeduplicationPersistenceModule",
  ],
]);

test("persistence modules have explicit names and never depend on application or transport layers", async () => {
  for (const [modulePath, className] of expectedPersistenceModules) {
    const absolute = path.join(projectRoot, modulePath);
    const source = await readFile(absolute, "utf8");
    assert.match(source, new RegExp(`export class ${className}\\s*\\{`), modulePath);
    for (const specifier of importsOf(absolute, source)) {
      assert.doesNotMatch(specifier, /(?:\/application\/|-application\.)/, modulePath);
      assert.doesNotMatch(specifier, /(?:\/transport\/|-transport\.)/, modulePath);
    }
  }

  await assert.rejects(
    readFile(path.join(sourceRoot, "operations/operations.module.ts"), "utf8"),
    /ENOENT/,
  );
  await assert.rejects(
    readFile(path.join(sourceRoot, "settings/settings.module.ts"), "utf8"),
    /ENOENT/,
  );
});

test("legacy facade composes persistence modules only", async () => {
  const facadePath = path.join(sourceRoot, "persistence/persistence-facade.module.ts");
  const facade = await readFile(facadePath, "utf8");
  const moduleImports = importsOf(facadePath, facade).filter((specifier) =>
    specifier.endsWith(".module.js"),
  );

  assert.equal(moduleImports.length, expectedPersistenceModules.size);
  for (const specifier of moduleImports) {
    assert.match(specifier, /-persistence\.module\.js$/, specifier);
  }
});

test("dependency scanner covers re-exports, dynamic imports, and database package subpaths", () => {
  const found = importsOf(
    "adversarial-fixture.ts",
    `
      import "reflect-metadata";
      import type { Pool } from "pg";
      export { DatabaseModule } from "../../database/database.module.js";
      export type { Sql } from "drizzle-orm/sql";
      const adapter = await import("drizzle-orm/pg-core");
      const client = require("pg/lib/client");
    `,
  );

  assert.deepEqual(found.sort(), [
    "../../database/database.module.js",
    "drizzle-orm/pg-core",
    "drizzle-orm/sql",
    "pg",
    "pg/lib/client",
    "reflect-metadata",
  ]);
  assert.equal(isDirectDatabasePackage("pg"), true);
  assert.equal(isDirectDatabasePackage("pg/lib/client"), true);
  assert.equal(isDirectDatabasePackage("drizzle-orm"), true);
  assert.equal(isDirectDatabasePackage("drizzle-orm/pg-core"), true);
  assert.equal(isDirectDatabasePackage("@app/drizzle-orm"), false);
});

test("application boundary scanner covers root contracts and tokens and rejects concrete infrastructure", () => {
  const allowed = new Map([
    [
      "src/example/example-application.contracts.ts",
      `
        import type { DomainEvent } from "./example.interfaces.js";
        export type { DomainEvent };
      `,
    ],
    [
      "src/example/example-application.tokens.ts",
      `export const EXAMPLE_APPLICATION = Symbol("EXAMPLE_APPLICATION");`,
    ],
    [
      "src/example/example-application.ts",
      `export type ApplicationResult = { ok: boolean };`,
    ],
  ]);
  for (const [file, source] of allowed) {
    assert.equal(isApplicationLayerFile(file), true, file);
    assert.doesNotThrow(() => assertApplicationDependencies(file, source), file);
  }

  const forbidden = new Map([
    [
      "src/example/notion-application.contracts.ts",
      `import { NotionAuditLogger } from "../../notion-audit.js";`,
    ],
    [
      "src/example/fetch-application.tokens.ts",
      `export const request = () => globalThis.fetch("https://example.test");`,
    ],
    [
      "src/example/http-application.contracts.ts",
      `import type { RequestOptions } from "node:http";`,
    ],
    [
      "src/example/axios-application.tokens.ts",
      `import axios from "axios";`,
    ],
    [
      "src/example/undici-application.contracts.ts",
      `import { request } from "undici";`,
    ],
    [
      "src/example/postgres-application.tokens.ts",
      `import type { Pool } from "pg";`,
    ],
    [
      "src/example/drizzle-application.contracts.ts",
      `export type { SQL } from "drizzle-orm/sql";`,
    ],
    [
      "src/example/legacy-application.tokens.ts",
      `export { NewsRepository } from "../../news-repository.js";`,
    ],
    [
      "src/editorial/editorial-application.contracts.ts",
      `import OpenAI from "openai";`,
    ],
    [
      "src/editorial/editorial-application.tokens.ts",
      `import { GoogleGenAI } from "@google/genai";`,
    ],
    [
      "src/editorial/editorial-application.module.ts",
      `export { sendTelegramMessage } from "../telegram.js";`,
    ],
    [
      "src/editorial/application/publish-approved-draft.use-case.ts",
      `export { publishApprovedDraft } from "../../publish.js";`,
    ],
    [
      "src/telegram/telegram-control-application.module.ts",
      `export { TelegramBotApiGateway } from "./transport/telegram-bot-api.gateway.js";`,
    ],
  ]);
  for (const [file, source] of forbidden) {
    assert.equal(isApplicationLayerFile(file), true, file);
    assert.throws(
      () => assertApplicationDependencies(file, source),
      (error: unknown) =>
        error instanceof Error && error.name === "AssertionError",
      `forbidden fixture ${file}`,
    );
  }
});

test("application layer has no direct database, legacy runtime, provider, or HTTP dependency", async () => {
  const files = await sourceFiles(sourceRoot);
  const applicationFiles = files.filter((file) =>
    isApplicationLayerFile(relative(file)),
  );

  assert.ok(applicationFiles.length > 0, "at least one application slice must exist");
  for (const file of applicationFiles) {
    const source = await readFile(file, "utf8");
    const name = relative(file);
    assertApplicationDependencies(name, source);
  }
});

test("Nest TypeScript composition remains standalone without an HTTP platform or listener", async () => {
  for (const file of await sourceFiles(sourceRoot)) {
    const source = await readFile(file, "utf8");
    const name = relative(file);
    for (const specifier of importsOf(file, source)) {
      assert.doesNotMatch(specifier, /^@nestjs\/platform-/, name);
    }
    assert.doesNotMatch(source, /NestFactory\.create\s*\(/, name);
    assert.doesNotMatch(source, /\.listen\s*\(/, name);
  }
});

test("additive Telegram application slice is not wired into the legacy poller or production entrypoint", async () => {
  for (const file of [
    path.join(sourceRoot, "telegram-bot.js"),
    path.join(sourceRoot, "telegram-polling.js"),
  ]) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /telegram-control-application/, relative(file));
    assert.doesNotMatch(source, /TelegramControlTransportHandler/, relative(file));
  }
});

test("additive Scheduler application is one-shot and remains unwired from the legacy production loop", async () => {
  const applicationModule = await readFile(
    path.join(sourceRoot, "scheduler/scheduler-application.module.ts"),
    "utf8",
  );
  const useCase = await readFile(
    path.join(
      sourceRoot,
      "scheduler/application/run-scheduled-news-once.use-case.ts",
    ),
    "utf8",
  );
  assert.doesNotMatch(applicationModule, /@nestjs\/schedule/);
  assert.doesNotMatch(applicationModule, /\b(?:Cron|Interval|Timeout)\s*\(/);
  assert.doesNotMatch(useCase, /\bwhile\s*\(/);
  assert.doesNotMatch(useCase, /runNewsScheduler|news-scheduler\.js/);
  assert.doesNotMatch(useCase, /ResearchService|candidates\s*\[\s*0\s*\]/);
  assert.match(useCase, /SCHEDULER_NEWS_WORKFLOW_APPLICATION/);

  for (const entrypoint of ["telegram-bot.js", "news-scheduler.js"]) {
    const source = await readFile(path.join(sourceRoot, entrypoint), "utf8");
    assert.doesNotMatch(source, /scheduler-application/, entrypoint);
    assert.doesNotMatch(source, /RunScheduledNewsOnceUseCase/, entrypoint);
  }
});

test("Nest module imports are acyclic and avoid forwardRef", async () => {
  const files = (await sourceFiles(sourceRoot)).filter((file) =>
    file.endsWith(".module.ts"),
  );
  const modules = new Set(files);
  const graph = new Map<string, string[]>();

  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\bforwardRef\s*\(/, relative(file));
    const dependencies = importsOf(file, source)
      .map((specifier) => resolveRelativeImport(file, specifier))
      .filter((candidate): candidate is string => candidate !== null)
      .filter((candidate) => modules.has(candidate));
    graph.set(file, dependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string, stack: string[]): void => {
    if (visiting.has(file)) {
      assert.fail(
        `Nest module dependency cycle: ${[...stack, file]
          .map(relative)
          .join(" -> ")}`,
      );
    }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) ?? []) {
      visit(dependency, [...stack, file]);
    }
    visiting.delete(file);
    visited.add(file);
  };

  for (const file of files) visit(file, []);
});
