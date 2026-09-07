/** Text retrieved for one article URL. Plain data, no provider's envelope. */
export type ArticleContent = {
  url: string;
  text: string;
  title?: string;
  /**
   * What the call cost, in the shape the AI provider results already use.
   *
   * Opaque here on purpose -- this port does not know what a token is. It
   * exists because the first version of this port recorded nothing at all: a
   * live run showed `searchFact provider=exa` in the ledger and absolutely
   * nothing for content retrieval, so the question "did we load the full
   * article?" had no answer anywhere on the stage. An adapter that spends
   * metered budget and leaves no trace is not observable, and an unobservable
   * dependency is one nobody can tell is broken.
   */
  usageEvents?: readonly unknown[];
};

/**
 * Retrieving the body of an article, whoever does it.
 *
 * Provider-neutral on purpose, the same way the corroboration search port is:
 * a request in, plain records out. Exa reaches this through an adapter; the
 * existing HTML extractor reaches it through another; a third would be a third
 * adapter and no change here or in the gateway.
 *
 * Returns null rather than throwing when the content simply is not available.
 * A page that cannot be read is an ordinary outcome in this pipeline -- the
 * candidate is skipped -- and making it an exception would push that decision
 * into a catch block far from where it belongs.
 */
export type ArticleContentPort = {
  fetch(
    url: string,
    context?: { signal?: AbortSignal },
  ): Promise<ArticleContent | null>;
};
