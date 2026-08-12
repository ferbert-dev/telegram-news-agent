import type {
  TelegramControlChatType,
  TelegramControlRequest,
  TelegramControlRoute,
} from "../telegram-application.contracts.js";
import { TelegramControlError } from "../telegram-application.contracts.js";
import { parseLabsCallback } from "../../telegram-labs.js";
import { parseSettingsCallback } from "../../telegram-settings.js";

type TelegramActor = { id?: number; is_bot?: boolean };
type TelegramChat = { id?: number; type?: TelegramControlChatType };
type TelegramMessage = {
  message_id?: number;
  text?: string;
  from?: TelegramActor;
  chat?: TelegramChat;
  reply_to_message?: {
    message_id?: number;
    from?: TelegramActor;
  };
};
type TelegramCallback = {
  id?: string;
  data?: string;
  from?: TelegramActor;
  message?: TelegramMessage;
};
export type TelegramControlRawUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallback;
};

const REVIEW_CALLBACK = /^news:([pr]):([a-f0-9]{32,64})$/;

function command(
  text: string | undefined,
  name: "news" | "settings" | "stats" | "labs",
): { botUsername: string | null; malformed: boolean } | null {
  if (typeof text !== "string") return null;
  const match = new RegExp(
    `^/${name}(?:@([A-Za-z0-9_]+))?(\\s.*)?$`,
    "i",
  ).exec(text.trim());
  return match
    ? { botUsername: match[1] ?? null, malformed: Boolean(match[2]?.trim()) }
    : null;
}

function addressedElsewhere(
  parsed: { botUsername: string | null },
  botUsername: string,
): boolean {
  return Boolean(
    parsed.botUsername &&
      parsed.botUsername.toLowerCase() !== botUsername.toLowerCase(),
  );
}

function settingsInput(message: TelegramMessage | undefined, botId: number): boolean {
  return Boolean(
    message?.chat?.type === "private" &&
      typeof message.text === "string" &&
      message.reply_to_message?.message_id &&
      message.reply_to_message.from?.id === botId,
  );
}

function updateKindFor(route: TelegramControlRoute): string {
  switch (route.kind) {
    case "news": return "news_command";
    case "review": return "news_callback";
    case "settings":
      return route.action === "callback"
        ? "settings_callback"
        : route.action === "input"
          ? "settings_input"
          : "settings_command";
    case "stats": return "stats_command";
    case "labs": return route.action === "callback" ? "labs_callback" : "labs_command";
    case "malformed":
      return route.target === "review"
        ? "news_callback"
        : route.target === "settings"
          ? "settings_callback"
          : "labs_callback";
  }
}

function routeFor(
  update: TelegramControlRawUpdate,
  botUsername: string,
  botId: number,
): TelegramControlRoute | null {
  for (const [name, route] of [
    ["labs", "labs"],
    ["settings", "settings"],
    ["stats", "stats"],
    ["news", "news"],
  ] as const) {
    const parsed = command(update.message?.text, name);
    if (!parsed) continue;
    if (addressedElsewhere(parsed, botUsername)) return null;
    if (route === "labs") return { kind: "labs", action: "open", malformed: parsed.malformed };
    if (route === "settings") return { kind: "settings", action: "open", malformed: parsed.malformed };
    return { kind: route, malformed: parsed.malformed };
  }

  const data = update.callback_query?.data;
  if (typeof data === "string" && data.startsWith("news:")) {
    const parsed = REVIEW_CALLBACK.exec(data);
    return parsed
      ? {
          kind: "review",
          action: parsed[1] === "p" ? "publish" : "reject",
          sessionId: parsed[2],
          messageId: update.callback_query?.message?.message_id ?? Number.NaN,
          callbackId: update.callback_query?.id ?? "",
        }
      : {
          kind: "malformed",
          target: "review",
          errorCode: "malformed_callback",
        };
  }
  if (typeof data === "string" && data.startsWith("cfg:")) {
    const parsed = parseSettingsCallback(data);
    return parsed
      ? {
          kind: "settings",
          action: "callback",
          payload: {
            callbackId: update.callback_query?.id,
            messageId: update.callback_query?.message?.message_id,
            action: parsed,
          },
        }
      : {
          kind: "malformed",
          target: "settings",
          errorCode: "malformed_callback",
        };
  }
  if (typeof data === "string" && data.startsWith("lab:")) {
    const parsed = parseLabsCallback(data);
    return parsed
      ? {
          kind: "labs",
          action: "callback",
          payload: {
            callbackId: update.callback_query?.id,
            messageId: update.callback_query?.message?.message_id,
            action: parsed,
          },
        }
      : {
          kind: "malformed",
          target: "labs",
          errorCode: "malformed_callback",
        };
  }
  if (settingsInput(update.message, botId)) {
    return {
      kind: "settings",
      action: "input",
      payload: {
        text: update.message?.text,
        replyToMessageId: update.message?.reply_to_message?.message_id,
      },
    };
  }
  return null;
}

export function parseTelegramControlUpdate(
  update: TelegramControlRawUpdate,
  options: { botUsername: string; botId: number; channelId: string },
): TelegramControlRequest | null {
  let route = routeFor(update, options.botUsername, options.botId);
  if (!route) return null;
  if (!Number.isSafeInteger(update.update_id) || (update.update_id as number) <= 0) {
    throw new TelegramControlError("malformed_update", "Invalid Telegram update id");
  }
  if (typeof options.channelId !== "string" || !options.channelId.trim()) {
    throw new TelegramControlError("malformed_update", "Telegram channel is missing");
  }
  const callback = update.callback_query;
  const message = update.message ?? callback?.message;
  const actor = update.message?.from ?? callback?.from;
  if (
    callback &&
    (typeof callback.id !== "string" ||
      !callback.id.trim() ||
      !Number.isSafeInteger(callback.message?.message_id) ||
      (callback.message?.message_id as number) <= 0)
  ) {
    route = {
      kind: "malformed",
      target:
        typeof callback.data === "string" && callback.data.startsWith("cfg:")
          ? "settings"
          : typeof callback.data === "string" && callback.data.startsWith("lab:")
            ? "labs"
            : "review",
      errorCode: "malformed_callback",
    };
  }
  return {
    updateId: update.update_id as number,
    updateKind: updateKindFor(route),
    channelId: options.channelId,
    actorId: actor?.id ?? Number.NaN,
    chatId: message?.chat?.id ?? Number.NaN,
    chatType: message?.chat?.type ?? "channel",
    route,
  };
}
