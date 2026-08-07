import { createDatabaseClient } from "./database.js";
import { assertPublicHttpUrl } from "./feed.js";
import { NewsRepository } from "./news-repository.js";
import {
  getNotionAuditConfig,
  NotionAuditLogger,
  withNotionAudit,
} from "./notion-audit.js";

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const logger = new NotionAuditLogger(getNotionAuditConfig());
  return withNotionAudit(
    logger,
    {
      name: `Source registry: ${command || "invalid"}`,
      objective: `Execute the ${command || "requested"} source-registry command.`,
    },
    async (auditRun) => {
      const result = await execute(command, args);
      return {
        value: result,
        auditResult: result,
        auditLinks: auditRun.pageUrl,
      };
    },
  );
}

async function execute(command, args) {
  const repository = new NewsRepository(createDatabaseClient());

  if (command === "list") {
    const sources = await repository.listSourceHealth();
    for (const source of sources) {
      console.log(
        [
          source.id,
          source.name,
          source.source_type,
          source.enabled ? "enabled" : "disabled",
          source.disabled_until
            ? `quarantined-until=${new Date(source.disabled_until).toISOString()}`
            : "available",
          `failures=${source.consecutive_failures ?? 0}`,
          `topics=${(source.topic_codes ?? []).join(",")}`,
          source.feed_url ?? "",
        ].join("\t"),
      );
    }
    return `Listed ${sources.length} sources with health status.`;
  }

  if (command === "add") {
    const name = valueAfter(args, "--name");
    const feedUrl = assertPublicHttpUrl(valueAfter(args, "--feed")).toString();
    const sourceType = args.includes("--type")
      ? valueAfter(args, "--type")
      : "rss";
    const homepageArg = args.includes("--homepage")
      ? valueAfter(args, "--homepage")
      : undefined;
    const homepageUrl = homepageArg
      ? assertPublicHttpUrl(homepageArg).toString()
      : new URL(feedUrl).origin;
    const score = args.includes("--score")
      ? Number(valueAfter(args, "--score"))
      : 70;
    const isPrimary = args.includes("--primary");

    if (!Number.isInteger(score) || score < 0 || score > 100) {
      throw new Error("--score must be an integer from 0 to 100");
    }
    if (!["rss", "website", "api", "manual"].includes(sourceType)) {
      throw new Error("--type must be rss, website, api, or manual");
    }

    const source = await repository.upsertSource({
      name,
      feed_url: feedUrl,
      homepage_url: homepageUrl,
      source_type: sourceType,
      reliability_score: score,
      enabled: true,
      is_primary: isPrimary,
    });
    console.log(`Saved source ${source.id}: ${source.name}`);
    return `Saved source ${source.id}: ${source.name}.`;
  }

  if (command === "enable" || command === "disable") {
    const id = valueAfter(args, "--id");
    const source = await repository.setSourceEnabled(id, command === "enable");
    console.log(
      `${command === "enable" ? "Enabled" : "Disabled"} ${source.name}`,
    );
    return `${command === "enable" ? "Enabled" : "Disabled"} source ${source.id}: ${source.name}.`;
  }

  throw new Error(
    "Usage: sources <list|add|enable|disable> [--name NAME --feed URL --type TYPE --homepage URL --score N --primary | --id UUID]",
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
