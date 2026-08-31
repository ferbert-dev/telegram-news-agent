import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import { eq } from "drizzle-orm";

import type {
  PipelineLeaseReadPort,
  PipelineLeaseSnapshot,
  PipelineLeasesRepositoryPort,
} from "../../operations/operations.interfaces.js";
import { pipelineLeases } from "../schema/operations.js";
import { DRIZZLE_DB, PG_POOL } from "../database.tokens.js";
import type { DrizzleDatabase } from "../drizzle-client.js";
import {
  postgresScalar,
  RepositorySupport,
} from "./repository-support.js";

const acquirePipelineLeaseFunction = postgresScalar<boolean>(
  "public.acquire_pipeline_lease",
  3,
);
const renewPipelineLeaseFunction = postgresScalar<boolean>(
  "public.renew_pipeline_lease",
  3,
);
const releasePipelineLeaseFunction = postgresScalar<boolean>(
  "public.release_pipeline_lease",
  2,
);

@Injectable()
export class PipelineLeasesRepository
  extends RepositorySupport
  implements PipelineLeasesRepositoryPort, PipelineLeaseReadPort
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  acquirePipelineLease(
    name: string,
    ownerId: string,
    ttlSeconds = 900,
  ): Promise<boolean> {
    return this.functionScalar(
      "Acquire pipeline lease",
      acquirePipelineLeaseFunction,
      [name, ownerId, ttlSeconds],
    );
  }

  renewPipelineLease(
    name: string,
    ownerId: string,
    ttlSeconds = 60,
  ): Promise<boolean> {
    return this.functionScalar(
      "Renew pipeline lease",
      renewPipelineLeaseFunction,
      [name, ownerId, ttlSeconds],
    );
  }

  releasePipelineLease(name: string, ownerId: string): Promise<boolean> {
    return this.functionScalar(
      "Release pipeline lease",
      releasePipelineLeaseFunction,
      [name, ownerId],
    );
  }

  readPipelineLease(name: string): Promise<PipelineLeaseSnapshot | null> {
    return this.operation("Read pipeline lease", async () => {
      const rows = await this.database
        .select({
          name: pipelineLeases.name,
          ownerId: pipelineLeases.ownerId,
          acquiredAt: pipelineLeases.acquiredAt,
          expiresAt: pipelineLeases.expiresAt,
        })
        .from(pipelineLeases)
        .where(eq(pipelineLeases.name, name))
        .limit(1);
      const row = this.optionalOne(rows, "Read pipeline lease");
      return row === null
        ? null
        : {
            name: row.name,
            ownerId: row.ownerId,
            // The timestamps are the proof the health check reasons about, so
            // they are normalized to ISO strings at this boundary rather than
            // left as driver-shaped values.
            acquiredAt: new Date(row.acquiredAt as unknown as string).toISOString(),
            expiresAt: new Date(row.expiresAt as unknown as string).toISOString(),
          };
    });
  }
}
