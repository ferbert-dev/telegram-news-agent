import { createDatabaseClient } from "./database.js";
import { NewsRepository } from "./news-repository.js";
import {
  getNotionAuditConfig,
  NotionAuditLogger,
  withNotionAudit,
} from "./notion-audit.js";
import { runResearch } from "./research.js";

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const windowHours = Number(option(args, "--hours", "48"));
  const keywords = option(args, "--keywords", "AI,agent,model")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error("--hours must be a positive number");
  }

  const logger = new NotionAuditLogger(getNotionAuditConfig());
  const result = await withNotionAudit(
    logger,
    {
      name: "Primary-source AI research",
      objective: `Research and persist important AI developments from the last ${windowHours} hours.`,
    },
    async (auditRun) => {
      const repository = new NewsRepository(createDatabaseClient());
      const research = await runResearch({
        repository,
        query: `Important AI developments from the last ${windowHours} hours`,
        keywords,
        windowHours,
      });
      return {
        value: research,
        auditResult: `Saved ${research.candidates.length} candidates in search run ${research.runId}; selected ${research.selected.title}.`,
        auditLinks: [auditRun.pageUrl, research.selected.canonicalUrl].join("\n"),
      };
    },
  );

  console.log(`Research run: ${result.runId}`);
  console.log(`Candidates saved: ${result.candidates.length}`);
  console.log(`Selected: ${result.selected.title}`);
  console.log(`URL: ${result.selected.canonicalUrl}`);
  console.log(`Score: ${result.selected.score}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
