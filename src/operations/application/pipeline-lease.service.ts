import { Inject, Injectable } from "@nestjs/common";

import type {
  PipelineLeaseApplicationPort,
  PipelineLeaseReleaseRequest,
  PipelineLeaseRequest,
} from "../operations-application.contracts.js";
import type { PipelineLeasesRepositoryPort } from "../operations.interfaces.js";
import { PIPELINE_LEASES_REPOSITORY } from "../operations.tokens.js";

@Injectable()
export class PipelineLeaseService implements PipelineLeaseApplicationPort {
  constructor(
    @Inject(PIPELINE_LEASES_REPOSITORY)
    private readonly leases: PipelineLeasesRepositoryPort,
  ) {}

  acquire(request: PipelineLeaseRequest): Promise<boolean> {
    return this.leases.acquirePipelineLease(
      request.name,
      request.ownerId,
      request.ttlSeconds,
    );
  }

  renew(request: PipelineLeaseRequest): Promise<boolean> {
    return this.leases.renewPipelineLease(
      request.name,
      request.ownerId,
      request.ttlSeconds,
    );
  }

  release(request: PipelineLeaseReleaseRequest): Promise<boolean> {
    return this.leases.releasePipelineLease(request.name, request.ownerId);
  }
}
