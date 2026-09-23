# Improve article detail enrichment for RSS and Google News sources

- Status: In Progress
- Branch: `codex/article-detail-enrichment-v2`
- Recovery commit: `8d87a35`

## Objective

Resolve short Google News wrapper pages to a safe publisher URL and use the
resulting article text and effective URL as grounded draft evidence.

## Acceptance criteria

- Retry extraction once when a Google News page contains insufficient text.
- Resolve canonical publisher metadata without bypassing SSRF, redirect,
  content-type, timeout, or byte-size guards.
- Keep the discovery canonical URL unchanged for database deduplication.
- Persist the resolved URL in raw-content metadata and pass it to drafting.
- Add a short factual hook instruction without weakening citation validation.
- Add focused extractor coverage.
- Do not add a paid AI call or increase model-token usage.

## Verification

- Run the focused article-extractor test.
- Run the pipeline, research, and draft regression tests.
- Complete one independent closure review before merge.

## Rollback

Revert the bounded feature commit. The pipeline will return to extracting only
the originally discovered URL and falling back to existing summary behavior.
