import { Logger, type OnApplicationShutdown } from "@nestjs/common";
import type { Pool } from "pg";

export type IdlePoolErrorReporter = (message: string) => void;

const logger = new Logger("DatabaseLifecycle");

function safeErrorCode(error: Error): string {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_-]{1,24}$/.test(code)
    ? code
    : "UNKNOWN";
}

function defaultIdlePoolErrorReporter(message: string): void {
  logger.error(message);
}

export class DatabaseLifecycle implements OnApplicationShutdown {
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly pool: Pool,
    idlePoolErrorReporter: IdlePoolErrorReporter = defaultIdlePoolErrorReporter,
  ) {
    this.pool.on("error", (error) => {
      idlePoolErrorReporter(
        `PostgreSQL idle client error (${safeErrorCode(error)})`,
      );
    });
  }

  close(): Promise<void> {
    if (this.closePromise === null) {
      this.closePromise = this.pool.end();
    }
    return this.closePromise;
  }

  onApplicationShutdown(): Promise<void> {
    return this.close();
  }
}
