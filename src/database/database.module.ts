import "reflect-metadata";

import { Module, type Provider } from "@nestjs/common";
import type { Pool } from "pg";

import { createDatabaseClient } from "../database.js";
import {
  createDrizzleDatabase,
  type DrizzleDatabase,
} from "./drizzle-client.js";
import { DatabaseLifecycle } from "./database-lifecycle.js";
import {
  DATABASE_LIFECYCLE,
  DRIZZLE_DB,
  PG_POOL,
} from "./database.tokens.js";

const poolProvider: Provider<Pool> = {
  provide: PG_POOL,
  useFactory: (): Pool => createDatabaseClient(),
};

const drizzleProvider: Provider<DrizzleDatabase> = {
  provide: DRIZZLE_DB,
  inject: [PG_POOL],
  useFactory: (pool: Pool): DrizzleDatabase => createDrizzleDatabase(pool),
};

const lifecycleProvider: Provider<DatabaseLifecycle> = {
  provide: DATABASE_LIFECYCLE,
  inject: [PG_POOL],
  useFactory: (pool: Pool): DatabaseLifecycle => new DatabaseLifecycle(pool),
};

@Module({
  providers: [poolProvider, drizzleProvider, lifecycleProvider],
  exports: [PG_POOL, DRIZZLE_DB, DATABASE_LIFECYCLE],
})
export class DatabaseModule {}
