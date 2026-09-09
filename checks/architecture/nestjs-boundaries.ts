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

test("scheduler worker owns the loop, stays durable, and remains unwired from production", async () => {
  const workerPath = path.join(sourceRoot, "scheduler/news-scheduler-worker.ts");
  const worker = await readFile(workerPath, "utf8");
  const useCase = await readFile(
    path.join(
      sourceRoot,
      "scheduler/application/run-scheduled-news-once.use-case.ts",
    ),
    "utf8",
  );

  // The loop belongs to the worker, never to the one-shot application layer.
  assert.match(worker, /export class NewsSchedulerWorker\s+implements RuntimeWorker/);
  assert.match(worker, /\bwhile\s*\(/, "worker must own the occurrence loop");
  assert.doesNotMatch(useCase, /\bwhile\s*\(/);

  // Durable PostgreSQL scheduling must not be replaced by cron or memory.
  assert.doesNotMatch(worker, /@nestjs\/schedule/);
  assert.doesNotMatch(worker, /\b(?:Cron|Interval|Timeout)\s*\(/);
  assert.doesNotMatch(worker, /setInterval\s*\(/);

  // Claim, CAS, checkpoint and quiet-hours authority stays in the use case.
  for (const durable of [
    /claimDueNewsSchedule/,
    /renewNewsScheduleClaim/,
    /saveNewsScheduleDraft/,
    /finishNewsSchedule/,
    /deferNewsScheduleForQuietHours/,
    /shouldDeferScheduledNews/,
  ]) {
    assert.doesNotMatch(worker, durable, `worker must not reimplement ${durable}`);
  }

  // The worker reaches persistence only through the one-shot application port.
  for (const specifier of importsOf(workerPath, worker)) {
    assert.equal(isDirectDatabasePackage(specifier), false, specifier);
    assert.doesNotMatch(specifier, /(?:^|\/)database(?:\/|$)/, specifier);
    assert.doesNotMatch(specifier, /news-repository/, specifier);
  }

  for (const entrypoint of ["telegram-bot.js", "news-scheduler.js"]) {
    const source = await readFile(path.join(sourceRoot, entrypoint), "utf8");
    assert.doesNotMatch(source, /news-scheduler-worker/, entrypoint);
    assert.doesNotMatch(source, /NewsSchedulerWorker/, entrypoint);
  }
});

test("legacy research compatibility adapter is single-writer, narrow, and remains unwired", async () => {
  const gateway = await readFile(
    path.join(sourceRoot, "research/legacy-research-execution.gateway.ts"),
    "utf8",
  );
  const useCase = await readFile(
    path.join(
      sourceRoot,
      "research/application/run-research.use-case.ts",
    ),
    "utf8",
  );
  assert.doesNotMatch(gateway, /NewsRepository|news-repository|\bpg\b|PG_POOL/);
  assert.doesNotMatch(gateway, /createAiProvider|process\.env/);
  assert.match(gateway, /claimSourceDiscovery/);
  assert.match(gateway, /recordStoryDedupDecision/);
  assert.match(gateway, /recordAiUsage/);
  assert.doesNotMatch(
    useCase,
    /startSearchRun|finishSearchRun|failSearchRun|saveRawContent|recordAiUsage/,
  );
  assert.match(useCase, /RESEARCH_EXECUTION_GATEWAY/);

  for (const entrypoint of ["telegram-bot.js", "pipeline.js"]) {
    const source = await readFile(path.join(sourceRoot, entrypoint), "utf8");
    assert.doesNotMatch(
      source,
      /legacy-research-execution|LegacyResearchExecutionGateway/,
      entrypoint,
    );
  }
});

// typed-research-execution.gateway.ts is not matched by isApplicationLayerFile
// (it's a *.gateway.ts, not *-application*/*.service.ts/*.use-case.ts), so
// the generic application-layer scanner above never runs against it — even
// though it IS orchestration logic in the sense that guard cares about. It
// also reaches directly into a handful of legacy JS modules, which CLAUDE.md
// otherwise reserves for legacy-*.gateway.ts files. Both are deliberate,
// reviewed exceptions (the file composes typed child slices and reuses only
// pure, stateless legacy helpers with no persistence/network of their own) —
// this test makes that exception explicit and narrow rather than an
// unenforced gap: it fails if the exact allowed import set drifts, or if the
// forbidden database/legacy-runtime/provider-SDK/HTTP surface ever appears.
test("typed research execution engine has no direct database or legacy-runtime dependency and its legacy JS reuse stays narrow", async () => {
  const gateway = await readFile(
    path.join(sourceRoot, "research/typed-research-execution.gateway.ts"),
    "utf8",
  );
  assert.doesNotMatch(gateway, /NewsRepository|news-repository|\bpg\b|PG_POOL|drizzle-orm/);
  assert.doesNotMatch(gateway, /\.\.\/(?:pipeline|draft|publish|publication-recovery|notion-audit)\.js/);
  assert.doesNotMatch(gateway, /(?:^|\/)(?:openai|@google\/genai|exa-js)(?:\/|$)/);
  assert.doesNotMatch(gateway, /node:https?\b|\baxios\b|\bundici\b|(?<!\.)\bfetch\(/);

  // Only single-segment "../x.js" specifiers are genuine plain-JS legacy
  // reuse. Typed sibling modules also end in .js (NodeNext requires the
  // extension even for .ts sources) but always live under a subdirectory,
  // e.g. "../ai/ai-provider-composition.js" — excluded by the [^/]+ here.
  const legacyJsImports = [...gateway.matchAll(/from "\.\.\/([^"/]+\.js)"/g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(legacyJsImports)].sort(),
    ["ai-usage.js", "excluded-topic-policy.js", "feed.js", "news-settings.js"],
    "legacy JS reuse must stay exactly this narrow set — extending it is a deliberate change, not an accident",
  );

  assert.match(gateway, /recordAiUsage/);
  assert.match(gateway, /this\.research\.failSearchRun/);
  assert.match(gateway, /terminalRunRecorded/);

  for (const entrypoint of ["telegram-bot.js", "pipeline.js"]) {
    const source = await readFile(path.join(sourceRoot, entrypoint), "utf8");
    assert.doesNotMatch(
      source,
      /typed-research-execution|TypedResearchExecutionGateway/,
      entrypoint,
    );
  }
});

// SourceAcquisitionGateway and EvidenceCurationService are the two other
// large orchestration engines that, like typed-research-execution.gateway.ts
// above, are named *.gateway.ts/*.engine.ts and so escape isApplicationLayerFile
// entirely. Unlike the research gateways they have no sanctioned reason to
// reach legacy JS at all (no "legacy-" prefix) — this test's bar is simply
// "zero forbidden imports, full stop," which is what isApplicationLayerFile
// would already enforce if it matched these filenames.
test("source acquisition and evidence curation engines have no direct database, legacy-runtime, or forbidden-transport dependency", async () => {
  for (const relativePath of [
    "research/source-acquisition.gateway.ts",
    "research/curation/evidence-curation.engine.ts",
  ]) {
    const absolute = path.join(sourceRoot, relativePath);
    const source = await readFile(absolute, "utf8");
    assertApplicationDependencies(relativePath, source);
  }

  // evidence-curation.engine.ts's one legacy JS import (news-settings.js, for
  // LANGUAGE_OPTIONS/TOPIC_PRESETS constants) is deliberate and narrow — make
  // that explicit rather than leaving it as an unstated exception.
  const curation = await readFile(
    path.join(sourceRoot, "research/curation/evidence-curation.engine.ts"),
    "utf8",
  );
  const legacyJsImports = [...curation.matchAll(/from "\.\.\/\.\.\/([^"/]+\.js)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(legacyJsImports)], ["news-settings.js"]);
});

test("scheduler adapters keep their legacy JS reuse narrow and stay unwired from production", async () => {
  // Same coverage gap as the research gateways: these are *.adapter.ts files,
  // which isApplicationLayerFile does not match, so the generic scanner never
  // sees them despite their being real composition logic.
  for (const relativePath of [
    "scheduler/typed-scheduler-news-workflow.adapter.ts",
    "scheduler/telegram-scheduler-review-delivery.adapter.ts",
    "scheduler/legacy-scheduler-audit.adapter.ts",
  ]) {
    const source = await readFile(path.join(sourceRoot, relativePath), "utf8");
    assert.doesNotMatch(source, /NewsRepository|news-repository|\bpg\b|PG_POOL|drizzle-orm/, relativePath);
    assert.doesNotMatch(source, /\.\.\/(?:pipeline|draft|publish|publication-recovery|research)\.js/, relativePath);
    assert.doesNotMatch(source, /^(?:node:)?https?(?:\/|$)|\baxios\b|\bundici\b/m, relativePath);
  }

  // The news-workflow adapter composes research and editorial, so it must not
  // reach either concrete implementation -- the ports are structural on
  // purpose, and the guard below forbids the use case from doing it directly.
  const newsWorkflow = await readFile(
    path.join(sourceRoot, "scheduler/typed-scheduler-news-workflow.adapter.ts"),
    "utf8",
  );
  // Import-based, not text-based: the file's doc comment legitimately quotes
  // both class names when explaining which seam it binds to instead.
  for (const specifier of importsOf("news-workflow.ts", newsWorkflow)) {
    assert.doesNotMatch(specifier, /research\.service|editorial-workflow\.service/, specifier);
  }
  const legacyJsImports = [...newsWorkflow.matchAll(/from "\.\.\/([^"/]+\.js)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(legacyJsImports)], ["news-settings.js"]);

  for (const entrypoint of ["telegram-bot.js", "news-scheduler.js"]) {
    const source = await readFile(path.join(sourceRoot, entrypoint), "utf8");
    assert.doesNotMatch(source, /typed-scheduler-news-workflow|TypedSchedulerNewsWorkflowAdapter/, entrypoint);
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

/**
 * Every `.ts` and `.mjs` file that can name a module: `src/` for the wiring
 * itself, `checks/` because a slice that only a check assembles is still
 * assembled somewhere, and `checks/emitted-*.mjs` because those reach the same
 * modules through `dist/`.
 */
async function moduleReferenceFiles(): Promise<string[]> {
  const scan = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return scan(target);
        return entry.isFile() && /\.(?:ts|mjs)$/.test(target) ? [target] : [];
      }),
    );
    return nested.flat().sort();
  };
  return [
    ...(await scan(sourceRoot)),
    ...(await scan(path.join(projectRoot, "checks"))),
  ];
}

/**
 * A relative specifier resolved to the `src/` file it names, so a reference
 * through the compiled output counts as a reference to the source.
 */
function resolveModuleReference(from: string, specifier: string): string | null {
  const resolved = resolveRelativeImport(from, specifier);
  if (resolved === null) return null;
  const distRoot = path.join(projectRoot, "dist") + path.sep;
  if (!resolved.startsWith(distRoot)) return resolved;
  return path.join(sourceRoot, resolved.slice(distRoot.length));
}

/**
 * A `.module.ts` nothing imports is dead wiring, and it does not look dead:
 * `EvidenceCorroborationModule` declared providers and exports for a service
 * that the composition root was meanwhile constructing with `new`, so the
 * slice worked and its module was never loaded. That survived review, a
 * cutover-readiness pass and a module-graph drawing, and was found by hand.
 *
 * The rule is deliberately generous about who may do the importing. Several
 * slices are additive and are assembled only by a check until their cutover
 * ticket -- that is the documented state of this repository, not a defect. A
 * module that no check assembles either is a different thing: nothing anywhere
 * has ever built it, so nothing can say whether it still works.
 */
test("every Nest module is imported by something that assembles it", async () => {
  const modules = new Set(
    (await sourceFiles(sourceRoot)).filter((file) => file.endsWith(".module.ts")),
  );
  const referenced = new Set<string>();

  for (const file of await moduleReferenceFiles()) {
    const source = await readFile(file, "utf8");
    // `importsOf` asserts a `.ts` name; the scanner itself is extension-blind,
    // and the emitted checks it has to read are `.mjs`.
    for (const specifier of importsOf(file.replace(/\.mjs$/, ".ts"), source)) {
      const resolved = resolveModuleReference(file, specifier);
      if (resolved !== null && resolved !== file && modules.has(resolved)) {
        referenced.add(resolved);
      }
    }
  }

  const orphans = [...modules]
    .filter((file) => !referenced.has(file))
    .map(relative)
    .sort();

  assert.deepEqual(
    orphans,
    [],
    `Nest modules that nothing imports: ${orphans.join(", ")}. Either wire the module into the composition that needs it, or delete it and say in a comment why the thing it provided is built directly instead.`,
  );
});

test("the corroboration slice is wired through its module rather than constructed by hand", async () => {
  const draftModule = await readFile(
    path.join(sourceRoot, "editorial/legacy-editorial-draft.module.ts"),
    "utf8",
  );
  assert.match(draftModule, /EvidenceCorroborationModule\.register\(/);
  assert.match(draftModule, /inject:\s*\[EVIDENCE_CORROBORATION\]/);

  // The root composes the gateway's module, not the service. `new
  // EvidenceCorroborationService` there is what made the module dead the first
  // time, and it is invisible from the module graph.
  const root = await readFile(
    path.join(sourceRoot, "composition/news-agent.module.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    root,
    /new EvidenceCorroborationService\s*\(/,
    "the composition root must take corroboration from the module, not construct it",
  );
});

test("runtime bootstrap owns signals and never calls process.exit directly", async () => {
  const runtimeCoordinator = await readFile(
    path.join(sourceRoot, "runtime/runtime-coordinator.ts"),
    "utf8",
  );
  const runtimeBootstrap = await readFile(
    path.join(sourceRoot, "runtime/runtime-bootstrap.ts"),
    "utf8",
  );
  const runtimeModule = await readFile(
    path.join(sourceRoot, "runtime/runtime-module.ts"),
    "utf8",
  );

  assert.doesNotMatch(runtimeCoordinator, /process\.exit\s*\(/);
  assert.doesNotMatch(runtimeCoordinator, /process\.exitCode/);
  assert.doesNotMatch(runtimeCoordinator, /process\.(on|off)\(/);
  assert.match(runtimeBootstrap, /RuntimeModule\.register/);
  assert.match(runtimeBootstrap, /bindApplicationClose/);
  assert.match(runtimeBootstrap, /createRuntimeApplicationContext/);
  assert.match(runtimeModule, /createProcessSignalSource/);
  assert.match(runtimeModule, /RUNTIME_STOP_GRACE_PERIOD_MS/);
  assert.match(runtimeModule, /createProcessSecondSignalEscalation/);
  assert.match(runtimeModule, /DEFAULT_STOP_GRACE_PERIOD_MS/);
  assert.match(runtimeModule, /MAX_STOP_GRACE_PERIOD_MS|45_000/);
  assert.ok(!/45_000/.test(runtimeBootstrap), "default stop grace should be below compose 45s");
  assert.ok(!/process\.exit/.test(runtimeBootstrap), "exit should be in escalation boundary");
  assert.ok(!/process\.exit/.test(runtimeCoordinator), "exit should be in escalation boundary");
});
