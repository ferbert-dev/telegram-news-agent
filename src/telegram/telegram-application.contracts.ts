import type { DraftRow } from "../editorial/editorial-persistence.contracts.js";

export type TelegramControlChatType = "private" | "group" | "supergroup" | "channel";

export type TelegramControlRoute =
  | { kind: "news"; malformed?: boolean }
  | { kind: "settings"; action: "open" | "callback" | "input"; payload?: unknown; malformed?: boolean }
  | { kind: "stats"; malformed?: boolean }
  | { kind: "status"; action: "open" | "callback"; payload?: unknown; malformed?: boolean }
  | { kind: "labs"; action: "open" | "callback"; payload?: unknown; malformed?: boolean }
  | {
      kind: "malformed";
      target: "review" | "settings" | "labs" | "status";
      errorCode: "malformed_callback";
    }
  | {
      kind: "review";
      action: "publish" | "reject";
      sessionId: string;
      messageId: number;
      callbackId: string;
    };

export type TelegramControlRequest = {
  updateId: number;
  updateKind: string;
  channelId: string;
  actorId: number;
  chatId: number;
  chatType: TelegramControlChatType;
  route: TelegramControlRoute;
};

export type TelegramControlOutcome = {
  status: string;
  [key: string]: unknown;
};

export type TelegramControlAuditContext = {
  updateId: number;
  updateKind: string;
  routeKind: TelegramControlRoute["kind"];
};

export interface TelegramControlAuditGateway {
  run<T>(
    context: TelegramControlAuditContext,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface TelegramAdminAuthorizationGateway {
  isChannelAdmin(channelId: string, actorId: number): Promise<boolean>;
}

export interface TelegramControlFeatureGateway {
  execute(request: TelegramControlRequest): Promise<TelegramControlOutcome>;
}

export type RestoreReviewControlsResult = "available" | "missing";

/** Semantic presentation port implemented by a Telegram Bot API adapter. */
export interface TelegramReviewPresentationGateway {
  restoreControls(input: {
    chatId: number;
    messageId: number;
    sessionId: string;
  }): Promise<RestoreReviewControlsResult>;
  disableControls(input: { chatId: number; messageId: number }): Promise<void>;
  answerCallback(input: {
    callbackId: string;
    text: string;
    showAlert?: boolean;
  }): Promise<void>;
  sendReview(input: {
    chatId: number;
    sessionId: string;
    preview: string;
    draft: DraftRow;
  }): Promise<{ messageId: number }>;
}

export interface TelegramControlIdGenerator {
  next(): string;
}

export interface TelegramControlClock {
  now(): Date;
}

export interface TelegramNewsApplicationPort {
  execute(
    request: TelegramControlRequest,
    updateClaimToken: string,
  ): Promise<TelegramControlOutcome>;
}

export interface TelegramReviewDecisionApplicationPort {
  execute(request: TelegramControlRequest): Promise<TelegramControlOutcome>;
}

export interface TelegramControlApplicationPort {
  handle(
    request: TelegramControlRequest,
    present: (outcome: TelegramControlOutcome) => Promise<void>,
  ): Promise<TelegramControlOutcome>;
}

const TERMINAL_CODES = new Set([
  "forbidden",
  "private_chat_required",
  "malformed_command",
  "missing_sender",
  "malformed_callback",
  "invalid_review_session",
  "publication_unresolved",
  "malformed_update",
]);

export class TelegramControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TelegramControlError";
  }
}

export function isTerminalTelegramControlError(error: unknown): boolean {
  return error instanceof TelegramControlError && TERMINAL_CODES.has(error.code);
}
