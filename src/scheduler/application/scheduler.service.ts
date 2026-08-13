import { Inject, Injectable } from "@nestjs/common";

import type {
  RunScheduledNewsOnceInput,
  SchedulerApplicationPort,
  SchedulerRunResult,
} from "../scheduler-application.contracts.js";
import { RunScheduledNewsOnceUseCase } from "./run-scheduled-news-once.use-case.js";

@Injectable()
export class SchedulerService implements SchedulerApplicationPort {
  constructor(
    @Inject(RunScheduledNewsOnceUseCase)
    private readonly runScheduledNewsOnce: RunScheduledNewsOnceUseCase,
  ) {}

  runOnce(input: RunScheduledNewsOnceInput = {}): Promise<SchedulerRunResult> {
    return this.runScheduledNewsOnce.execute(input);
  }
}
