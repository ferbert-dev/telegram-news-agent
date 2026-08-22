import { Injectable } from "@nestjs/common";

import type {
  ArticlePublishedEvent,
  ArticlePublishedEventBus,
  ArticlePublishedEventSubscriber,
} from "../editorial-application.contracts.js";

/**
 * In-process fan-out for additive, replay-safe post-publication subscribers.
 * The database-backed outbox required for crash-independent replay remains a
 * standalone-runtime cutover gate.
 */
@Injectable()
export class EditorialArticlePublishedEventPublisher
  implements ArticlePublishedEventBus
{
  private readonly subscribers = new Set<ArticlePublishedEventSubscriber>();

  subscribe(subscriber: ArticlePublishedEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  async publish(
    event: ArticlePublishedEvent,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const failures: unknown[] = [];
    for (const subscriber of this.subscribers) {
      try {
        await subscriber.handle(event, signal);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more article-published subscribers failed",
      );
    }
  }
}
