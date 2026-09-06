import { exaUsageEvent } from "../../ai-usage.js";
import type {
  ArticleContent,
  ArticleContentPort,
} from "./article-content.contracts.js";

export type DailyCallStore = {
  get(key: string): { date: string; calls: number } | undefined;
  set(key: string, value: { date: string; calls: number }): void;
};

/**
 * Long enough for a feature article, short enough that one bad page cannot
 * dominate a prompt. The pipeline's own extractor returns 12-13k on ordinary
 * news pages, so this leaves headroom without inviting a book.
 */
const MAX_ARTICLE_CHARACTERS = 20_000;

export class ExaDailyContentCapError extends Error {
  readonly code = "exa_daily_content_cap";
  constructor(cap: number) {
    super(`Exa daily content cap of ${cap} calls was reached`);
    this.name = "ExaDailyContentCapError";
  }
}

/**
 * Shared across the process, like the search cap it sits beside.
 *
 * Both have the same weakness and it is worth stating rather than discovering:
 * a container restart resets the count. For a stage that is redeployed several
 * times a day this is a soft ceiling, not a hard one. Moving it into the
 * database is a separate change; leaving it entirely uncounted, which is where
 * getContents starts, is worse than an imperfect ceiling.
 */
const PROCESS_DAILY_CONTENT_USAGE = new Map<
  string,
  { date: string; calls: number }
>();

type ExaContentsClient = {
  getContents: (
    urls: string[],
    options?: Record<string, unknown>,
  ) => Promise<{
    results?: Array<{ url?: string; title?: string; text?: string }>;
  }>;
};

/**
 * Exa's content retrieval, behind the neutral port.
 *
 * Verified against the installed SDK rather than the documentation: exa-js
 * 2.18.1 exposes getContents. The Exa integration in this repository was once
 * written from memory of the API and reported a 404 from a wrong header and
 * method as a rejected key, so the SDK surface is checked, not recalled.
 *
 * The daily cap matters more here than it looks. The existing cap is enforced
 * inside the search wrapper only, so getContents starts out entirely
 * uncounted -- and this port is meant to be called for every article, against
 * a metered budget of roughly $10 a month.
 */
export function exaArticleContentPort(
  client: ExaContentsClient,
  {
    dailyCap,
    quotaKey,
    capStore = PROCESS_DAILY_CONTENT_USAGE,
    now = () => new Date(),
    minCharacters = 400,
  }: {
    dailyCap: number;
    quotaKey: string;
    capStore?: DailyCallStore;
    now?: () => Date;
    minCharacters?: number;
  },
): ArticleContentPort {
  const reserve = () => {
    const date = now().toISOString().slice(0, 10);
    const current = capStore.get(quotaKey);
    const calls = current?.date === date ? current.calls : 0;
    if (calls >= dailyCap) throw new ExaDailyContentCapError(dailyCap);
    capStore.set(quotaKey, { date, calls: calls + 1 });
  };

  return {
    async fetch(
      url: string,
      context: { signal?: AbortSignal } = {},
    ): Promise<ArticleContent | null> {
      reserve();
      const response = await client.getContents([url], {
        // An explicit ceiling, because `text: true` is not "the whole page".
        //
        // A live run retrieved exactly 1000 characters from a Guardian
        // article -- a round number is a default, not an article -- while the
        // HTML extractor had returned 12,579 characters from a comparable page
        // the run before. Making retrieval the primary path while silently
        // accepting a 1000-character cap gave the model LESS of the article
        // than the extractor it replaced, which is the opposite of the point.
        //
        // The shape is the one this repository already uses successfully
        // against the installed SDK (`contents: { text: { maxCharacters } }`
        // in src/exa-provider.js), not a recalled one.
        text: { maxCharacters: MAX_ARTICLE_CHARACTERS },
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const result = response?.results?.[0];
      const text = typeof result?.text === "string" ? result.text.trim() : "";
      // A near-empty body is a failure wearing a success's clothes: a cookie
      // wall or a JavaScript shell returns 200 and a few dozen characters.
      // Treating it as content would put a worse evidence text in front of the
      // model than the RSS summary it replaced.
      if (text.length < minCharacters) return null;
      return {
        url: result?.url ?? url,
        text,
        ...(result?.title ? { title: result.title } : {}),
        // Billed as one Exa call, the same way a search is, and recorded
        // through the same ledger so `AiByOperation` can show it beside
        // searchFact rather than leaving content retrieval invisible.
        usageEvents: [
          exaUsageEvent(response as never, {
            model: "contents",
            operation: "article_content",
          }),
        ],
      };
    },
  };
}
