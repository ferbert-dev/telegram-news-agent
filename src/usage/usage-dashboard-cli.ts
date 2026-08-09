import "reflect-metadata";

import { pathToFileURL } from "node:url";

import { NestFactory } from "@nestjs/core";

import { renderUsageDashboard } from "../telegram-stats.js";
import { GetDailyUsageDashboardQuery } from "./application/get-daily-usage-dashboard.query.js";
import { UsageDashboardService } from "./application/usage-dashboard.service.js";
import { UsageApplicationModule } from "./usage-application.module.js";

const DEFAULT_TIME_ZONE = "Europe/Madrid";

type UsageDashboardApplicationContext = {
  get(token: typeof UsageDashboardService): UsageDashboardService;
  close(): Promise<void>;
};

type UsageDashboardCliOptions = {
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  write?: (text: string) => void;
  createApplicationContext?: () => Promise<UsageDashboardApplicationContext>;
};

async function createApplicationContext(): Promise<UsageDashboardApplicationContext> {
  return NestFactory.createApplicationContext(UsageApplicationModule, {
    logger: false,
  });
}

function requiredChannelId(environment: NodeJS.ProcessEnv): string {
  const channelId = environment.TELEGRAM_CHANNEL_ID?.trim();
  if (!channelId) {
    throw new Error("TELEGRAM_CHANNEL_ID is required");
  }
  return channelId;
}

export async function runUsageDashboardCli({
  environment = process.env,
  now = () => new Date(),
  write = (text) => process.stdout.write(`${text}\n`),
  createApplicationContext: createContext = createApplicationContext,
}: UsageDashboardCliOptions = {}) {
  const channelId = requiredChannelId(environment);
  let application: UsageDashboardApplicationContext | undefined;

  try {
    application = await createContext();
    const dashboard = await application
      .get(UsageDashboardService)
      .execute(
        new GetDailyUsageDashboardQuery({
          channelId,
          now: now().toISOString(),
          timeZone: DEFAULT_TIME_ZONE,
        }),
      );
    write(renderUsageDashboard(dashboard, { timeZone: DEFAULT_TIME_ZONE }));
    return dashboard;
  } finally {
    await application?.close();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  runUsageDashboardCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
