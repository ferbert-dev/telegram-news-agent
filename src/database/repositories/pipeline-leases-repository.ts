import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import type { PipelineLeasesRepositoryPort } from "../../operations/operations.interfaces.js";
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
  implements PipelineLeasesRepositoryPort
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
}
