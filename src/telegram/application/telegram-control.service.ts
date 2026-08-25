import { Inject, Injectable } from "@nestjs/common";

import type {
  TelegramControlApplicationPort,
  TelegramControlOutcome,
  TelegramControlRequest,
} from "../telegram-application.contracts.js";
import { HandleTelegramControlUpdateUseCase } from "./handle-telegram-control-update.use-case.js";

@Injectable()
export class TelegramControlService implements TelegramControlApplicationPort {
  constructor(
    @Inject(HandleTelegramControlUpdateUseCase)
    private readonly handler: HandleTelegramControlUpdateUseCase,
  ) {}

  handle(
    request: TelegramControlRequest,
    present: (outcome: TelegramControlOutcome) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<TelegramControlOutcome> {
    return this.handler.execute(request, present, signal);
  }
}
