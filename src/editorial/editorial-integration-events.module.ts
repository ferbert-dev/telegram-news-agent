import { Module } from "@nestjs/common";

import { EditorialArticlePublishedEventPublisher } from "./application/article-published-event.publisher.js";
import { ARTICLE_PUBLISHED_EVENT_PUBLISHER } from "./editorial-application.tokens.js";

@Module({
  providers: [
    EditorialArticlePublishedEventPublisher,
    {
      provide: ARTICLE_PUBLISHED_EVENT_PUBLISHER,
      useExisting: EditorialArticlePublishedEventPublisher,
    },
  ],
  exports: [ARTICLE_PUBLISHED_EVENT_PUBLISHER],
})
export class EditorialIntegrationEventsModule {}
