import {
  handleSettingsCallback,
  handleSettingsInput,
  showSettings,
} from "../../telegram-settings.js";
import {
  handleLabsCallback,
  showLabs,
} from "../../telegram-labs.js";
import { showUsageDashboard } from "../../telegram-stats.js";
import type {
  TelegramControlFeatureGateway,
  TelegramControlOutcome,
  TelegramControlRequest,
} from "../telegram-application.contracts.js";
import { TelegramControlError } from "../telegram-application.contracts.js";
import type { TelegramBotApiCall } from "./telegram-bot-api.gateway.js";

type LegacyRepository = Record<string, unknown>;
type SettingsOperations = {
  show: typeof showSettings;
  callback: typeof handleSettingsCallback;
  input: typeof handleSettingsInput;
};
type LabsOperations = {
  show: typeof showLabs;
  callback: typeof handleLabsCallback;
};

type CallbackPayload = {
  callbackId: string;
  messageId: number;
  action: unknown;
};
type SettingsInputPayload = {
  text: string;
  replyToMessageId: number;
};

function callbackPayload(value: unknown): CallbackPayload {
  const payload = value as Partial<CallbackPayload> | undefined;
  if (
    !payload ||
    typeof payload.callbackId !== "string" ||
    !payload.callbackId.trim() ||
    !Number.isSafeInteger(payload.messageId) ||
    (payload.messageId as number) <= 0 ||
    !payload.action
  ) {
    throw new TelegramControlError("malformed_callback", "Invalid callback payload");
  }
  return payload as CallbackPayload;
}

function callback(request: TelegramControlRequest, payload: CallbackPayload) {
  return {
    id: payload.callbackId,
    from: { id: request.actorId },
    message: {
      message_id: payload.messageId,
      chat: { id: request.chatId, type: request.chatType },
    },
  };
}

/** Reuses the verified legacy settings transport until its typed UI slice is extracted. */
export class TelegramLegacySettingsGateway implements TelegramControlFeatureGateway {
  constructor(
    private readonly token: string,
    private readonly channelId: string,
    private readonly repository: LegacyRepository,
    private readonly callTelegram: TelegramBotApiCall,
    private readonly operations: SettingsOperations = {
      show: showSettings,
      callback: handleSettingsCallback,
      input: handleSettingsInput,
    },
  ) {}

  async execute(request: TelegramControlRequest): Promise<TelegramControlOutcome> {
    if (request.route.kind !== "settings") {
      throw new TelegramControlError("malformed_command", "Expected settings route");
    }
    if (request.route.action === "open") {
      const result = await this.operations.show({
        token: this.token,
        channelId: this.channelId,
        chatId: request.chatId,
        userId: request.actorId,
        repository: this.repository,
        callTelegram: this.callTelegram,
      });
      return { status: "settings_ready", result };
    }
    if (request.route.action === "callback") {
      const payload = callbackPayload(request.route.payload);
      const result = await this.operations.callback(
        callback(request, payload),
        payload.action,
        {
          token: this.token,
          channelId: this.channelId,
          userId: request.actorId,
          repository: this.repository,
          callTelegram: this.callTelegram,
        },
      );
      return { status: "settings_updated", result };
    }
    const payload = request.route.payload as Partial<SettingsInputPayload> | undefined;
    if (
      typeof payload?.text !== "string" ||
      !Number.isSafeInteger(payload.replyToMessageId) ||
      (payload.replyToMessageId as number) <= 0
    ) {
      throw new TelegramControlError("malformed_command", "Invalid settings input");
    }
    const result = await this.operations.input(
      {
        text: payload.text,
        from: { id: request.actorId },
        chat: { id: request.chatId, type: request.chatType },
        reply_to_message: { message_id: payload.replyToMessageId },
      },
      {
        token: this.token,
        channelId: this.channelId,
        userId: request.actorId,
        repository: this.repository,
        callTelegram: this.callTelegram,
      },
    );
    return { status: "settings_updated", result };
  }
}

/** Reuses the version-fenced legacy Labs UI behind the transport-neutral port. */
export class TelegramLegacyLabsGateway implements TelegramControlFeatureGateway {
  constructor(
    private readonly token: string,
    private readonly channelId: string,
    private readonly repository: LegacyRepository,
    private readonly callTelegram: TelegramBotApiCall,
    private readonly operations: LabsOperations = {
      show: showLabs,
      callback: handleLabsCallback,
    },
  ) {}

  async execute(request: TelegramControlRequest): Promise<TelegramControlOutcome> {
    if (request.route.kind !== "labs") {
      throw new TelegramControlError("malformed_command", "Expected Labs route");
    }
    if (request.route.action === "open") {
      const result = await this.operations.show({
        token: this.token,
        channelId: this.channelId,
        chatId: request.chatId,
        userId: request.actorId,
        repository: this.repository,
        callTelegram: this.callTelegram,
      });
      return { status: "labs_ready", result };
    }
    const payload = callbackPayload(request.route.payload);
    const result = await this.operations.callback(
      callback(request, payload),
      payload.action,
      {
        token: this.token,
        channelId: this.channelId,
        userId: request.actorId,
        repository: this.repository,
        callTelegram: this.callTelegram,
      },
    );
    return { status: "labs_updated", result };
  }
}

/** Keeps the existing DST-safe usage dashboard query and Telegram rendering together. */
export class TelegramLegacyStatsGateway implements TelegramControlFeatureGateway {
  constructor(
    private readonly token: string,
    private readonly channelId: string,
    private readonly repository: LegacyRepository,
    private readonly callTelegram: TelegramBotApiCall,
    private readonly show: typeof showUsageDashboard = showUsageDashboard,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(request: TelegramControlRequest): Promise<TelegramControlOutcome> {
    if (request.route.kind !== "stats") {
      throw new TelegramControlError("malformed_command", "Expected stats route");
    }
    const dashboard = await this.show({
      token: this.token,
      channelId: this.channelId,
      chatId: request.chatId,
      repository: this.repository,
      callTelegram: this.callTelegram,
      now: this.now,
    });
    return { status: "stats_ready", dashboard };
  }
}
