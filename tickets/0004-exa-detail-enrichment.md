# Use Exa for grounded article-detail research

- Notion: https://app.notion.com/p/3c2d78850eab81659e54fc89a3fbeeba
- Parent Epic: https://app.notion.com/p/3b7d78850eab81348bcbec541f1c23bb
- Depends on: `0002-exa-search-module.md`
- Status: In Progress

## Objective

Use Exa as a bounded research layer for article details, not as a feed-only
provider. The existing editorial enrichment flow calls Exa only when it
identifies one material missing fact or context question.

## Acceptance criteria

- Reuse the released editorial enrichment `searchFact` contract.
- Allow at most three sequential Exa API requests per article.
- Permit the next search only after the previous fact is used by a valid draft.
- Share the daily cap with Exa feed and topic searches.
- Return at most one fact with a direct URL and exact Exa highlight.
- Reject sources outside the conservative trusted-domain classification.
- Reject deceptive suffixes such as `nasa.gov.attacker.com`.
- Never fall through from failed/capped Exa detail search to paid web search.
- Require every regeneration to retain all previously accepted search sources.
- Preserve evidence-map validation and fail closed to the baseline draft.
- Record one web-search call, zero model tokens, and no invented Exa cost.
- Document the research flow, Oracle egress, and portfolio architecture.
- Keep behavior behind the existing `editorial_enrichment` Labs flag.
- Do not deploy or enable the production flag.

## Verification

- Provider contract tests cover grounded evidence and weak-source rejection.
- Editorial tests retain the one-search and baseline-fallback contract.
- A local live Exa smoke test uses the ignored `.env` key without printing it.
- An iterative test proves three facts are used and a fourth search is blocked.
- Existing focused and full project checks pass before closure review.

## Rollback

Disable Exa or remove it from provider order. Existing editorial enrichment
continues with its baseline and provider fallback behavior.
