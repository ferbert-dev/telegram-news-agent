import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import * as schema from "./schema/index.js";

export const createDrizzleDatabase = (pool: Pool) =>
  drizzle(pool, {
    schema,
  });

export type DrizzleDatabase = ReturnType<typeof createDrizzleDatabase>;
