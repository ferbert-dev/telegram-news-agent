import { fetchArticle } from "./article-extractor.js";
import { fetchFeed } from "./feed.js";
import { withRetry } from "./retry.js";

const HOUR_MS = 60 * 60 * 1000;

function keywordScore(candidate, keywords) {
  if (!keywords.length) {
    return 0;
  }

  const haystack = `${candidate.title} ${candidate.summary}`.toLowerCase();
  const matches = keywords.filter((keyword) =>
    haystack.includes(keyword.toLowerCase()),
  ).length;

  return Math.min(20, matches * 5);
}

export function scoreCandidate(
  candidate,
  source,
  { now = new Date(), keywords = [] } = {},
) {
  const reliability = source.reliability_score ?? 50;
  const publishedAt = candidate.publishedAt
    ? new Date(candidate.publishedAt)
    : null;
  const ageHours =
    publishedAt && !Number.isNaN(publishedAt.valueOf())
      ? Math.max(0, (now.valueOf() - publishedAt.valueOf()) / HOUR_MS)
      : 72;
  const recency = Math.max(0, 30 - Math.min(30, ageHours * 0.625));
  const primary = source.is_primary ? 30 : 0;

  return Number(
    (reliability * 0.2 + recency + primary + keywordScore(candidate, keywords)).toFixed(
      3,
    ),
  );
}

export function rankCandidates(
  candidates,
  { now = new Date(), keywords = [], windowHours = 48 } = {},
) {
  const cutoff = now.valueOf() - windowHours * HOUR_MS;
  const unique = new Map();

  for (const candidate of candidates) {
    const publishedAt = candidate.publishedAt
      ? new Date(candidate.publishedAt).valueOf()
      : Number.NaN;

    if (!Number.isNaN(publishedAt) && publishedAt < cutoff) {
      continue;
    }

    const existing = unique.get(candidate.canonicalUrl);
    const scored = {
      ...candidate,
      score: scoreCandidate(candidate, candidate.source, { now, keywords }),
    };

    if (!existing || scored.score > existing.score) {
      unique.set(candidate.canonicalUrl, scored);
    }
  }

  return [...unique.values()].sort(
    (left, right) =>
      right.score - left.score ||
      (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") ||
      left.canonicalUrl.localeCompare(right.canonicalUrl),
  );
}

export async function runResearch({
  repository,
  query,
  keywords = [],
  windowHours = 48,
  fetchFeedImpl = fetchFeed,
  fetchArticleImpl = fetchArticle,
  retryImpl = withRetry,
  now = new Date(),
}) {
  const run = await repository.startSearchRun({
    query,
    metadata: { keywords, window_hours: windowHours },
  });

  try {
    const sources = await repository.listEnabledSources();
    const primarySources = sources.filter(
      (source) => source.is_primary && source.source_type === "rss",
    );

    if (!primarySources.length) {
      throw new Error("No enabled primary RSS sources are configured");
    }

    const settled = await Promise.allSettled(
      primarySources.map(async (source) => {
        const entries = await retryImpl(
          () => fetchFeedImpl(source.feed_url),
          { attempts: 3, baseDelayMs: 300 },
        );
        await repository.markSourceChecked(source.id);
        return entries.map((entry) => ({ ...entry, source }));
      }),
    );
    const candidates = settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const feedErrors = settled
      .map((result, index) =>
        result.status === "rejected"
          ? {
              source_id: primarySources[index].id,
              error: result.reason?.message ?? String(result.reason),
            }
          : null,
      )
      .filter(Boolean);
    const ranked = rankCandidates(candidates, {
      now,
      keywords,
      windowHours,
    });

    if (!ranked.length) {
      throw new Error("No recent primary-source candidates were found");
    }

    const articles = [];
    for (const candidate of ranked) {
      const article = await repository.createOrResumeArticleCandidate({
        source_id: candidate.source.id,
        search_run_id: run.id,
        canonical_url: candidate.canonicalUrl,
        title: candidate.title,
        author: candidate.author,
        published_at: candidate.publishedAt,
        content_hash: candidate.contentHash,
        status: "discovered",
        metadata: {
          feed_summary: candidate.summary,
          research_score: candidate.score,
          primary_source: true,
        },
      });
      if (!article) {
        continue;
      }
      await repository.saveRawContent({
        article_id: article.id,
        content: candidate.summary || candidate.title,
        content_type: "text",
        language_code: "en",
        extractor: "rss",
        content_hash: candidate.contentHash,
        metadata: {
          source_url: candidate.canonicalUrl,
          extraction_kind: "feed_summary",
        },
      });
      articles.push({ ...candidate, article });
    }

    if (!articles.length) {
      throw new Error("No new primary-source articles were found");
    }

    const extractionErrors = [];
    let selected = null;
    for (const candidate of articles) {
      try {
        const extracted = await retryImpl(
          () => fetchArticleImpl(candidate.canonicalUrl),
          { attempts: 3, baseDelayMs: 300 },
        );
        await repository.saveRawContent({
          article_id: candidate.article.id,
          content: extracted.text,
          content_type: "text",
          language_code: "en",
          extractor: "primary-html",
          content_hash: extracted.contentHash,
          metadata: {
            source_url: candidate.canonicalUrl,
            final_url: extracted.finalUrl,
            extraction_kind: "primary_article_text",
          },
        });
        selected = { ...candidate, evidenceText: extracted.text };
        break;
      } catch (error) {
        extractionErrors.push({
          article_id: candidate.article.id,
          source_url: candidate.canonicalUrl,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!selected) {
      throw new Error("No ranked primary-source page could be extracted");
    }

    await repository.finishSearchRun(run.id, {
      resultCount: articles.length,
      metadata: {
        keywords,
        window_hours: windowHours,
        feed_errors: feedErrors,
        extraction_errors: extractionErrors,
        selected_article_id: selected.article.id,
      },
    });

    return {
      runId: run.id,
      selected,
      candidates: articles,
      feedErrors,
      extractionErrors,
    };
  } catch (error) {
    await repository.failSearchRun(run.id, error);
    throw error;
  }
}
