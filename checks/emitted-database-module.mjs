import assert from "node:assert/strict";

import { NestFactory } from "@nestjs/core";
import { types } from "pg";

process.env.DATABASE_URL =
  "postgresql://emitted-build:unused@127.0.0.1:1/emitted-build";

const { DatabaseModule } = await import(
  "../dist/database/database.module.js"
);
const { DATABASE_LIFECYCLE, DRIZZLE_DB, PG_POOL } = await import(
  "../dist/database/database.tokens.js"
);

const application = await NestFactory.createApplicationContext(
  DatabaseModule,
  { logger: false },
);

assert.equal(typeof PG_POOL, "symbol");
assert.equal(typeof DRIZZLE_DB, "symbol");
assert.equal(typeof DATABASE_LIFECYCLE, "symbol");
assert.equal(application.get(PG_POOL), application.get(PG_POOL));
assert.equal(application.get(DRIZZLE_DB), application.get(DRIZZLE_DB));
assert.equal(
  types.getTypeParser(types.builtins.INT8)("9007199254740991"),
  9_007_199_254_740_991,
);

await application.close();
