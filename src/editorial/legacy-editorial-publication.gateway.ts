import {
  type EditorialPublicationGateway,
  type EditorialPublicationReceipt,
  type EditorialPublicationRequest,
  PublicationDeliveryError,
} from "./editorial-application.contracts.js";
import {
  boldArticleTitleEntities,
  TelegramError,
  callTelegram,
  validateMessage,
} from "../telegram.js";

type LegacyPublicationDependencies = {
  token: string;
};

type SendMessage = (
  token: string,
  channelId: string,
  text: string,
  disableNotification: boolean,
  signal?: AbortSignal,
  entities?: Array<{ type: string; offset: number; length: number }>,
) => Promise<{
  message_id?: unknown;
  date?: number | null;
}>;

async function defaultSendMessage(
  token: string,
  channelId: string,
  text: string,
  disableNotification: boolean,
  signal?: AbortSignal,
  entities?: Array<{ type: string; offset: number; length: number }>,
) {
  // Preserve the legacy local rejection boundary while sending the exact
  // content that the application classified and atomically claimed.
  validateMessage(text);
  return (callTelegram as (
    token: string,
    method: string,
    body: unknown,
    options?: unknown,
  ) => Promise<unknown>)(
    token,
    "sendMessage",
    {
      chat_id: channelId,
      text,
      disable_notification: disableNotification,
      ...(entities?.length ? { entities } : {}),
    },
    signal ? { signal } : undefined,
  ) as Promise<{ message_id?: unknown; date?: number | null }>;
}

export type LegacyEditorialPublicationGatewayDependencies =
  LegacyPublicationDependencies & {
    sendMessage?: SendMessage;
  };

export class LegacyEditorialPublicationGateway
  implements EditorialPublicationGateway
{
  private readonly sendMessage: SendMessage;
  private readonly dependencies: LegacyEditorialPublicationGatewayDependencies;

  constructor(
    dependencies: LegacyEditorialPublicationGatewayDependencies,
    sendMessage: SendMessage = defaultSendMessage,
  ) {
    this.dependencies = dependencies;
    this.sendMessage = dependencies.sendMessage ?? sendMessage;
  }

  async publish(
    request: EditorialPublicationRequest,
    signal?: AbortSignal,
  ): Promise<EditorialPublicationReceipt> {
    try {
      const sent = await this.sendMessage(
        this.dependencies.token,
        request.channelId,
        request.text,
        request.disableNotification,
        signal,
        boldArticleTitleEntities(request.text),
      );
      const messageId = Number(sent?.message_id);
      if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        throw new Error(
          "Legacy publication gateway returned an invalid Telegram message id",
        );
      }
      return {
        messageId,
        messageDate: typeof sent.date === "number" && Number.isFinite(sent.date)
          ? sent.date
          : null,
      };
    } catch (error) {
      if (error instanceof TelegramError) {
        throw new PublicationDeliveryError(
          "Publication was rejected by Telegram",
          "rejected",
          { cause: error },
        );
      }
      throw error;
    }
  }
}
