# Add Exa AI provider module for controlled free-news search

## Type

Feature

## Status

In Progress

## Priority

P2

## Agent Role

Builder

## Context

Current discovery uses OpenAI/Gemini search/normalization paths. We want a separate Free/low-cost option for web search (including article-level detail lookup) with explicit guardrails.

## Objective

Build a dedicated Exa module that can be enabled as an optional provider and reused later for:

- topic discovery (`searchNews`)
- source maintenance (`searchFeeds`)
- article detail enrichment without forcing paid provider usage

## Acceptance Criteria

- Add `src/exa-provider.js` with:
  - `getExaProviderConfig(env)` reading `EXA_API_KEY`, `EXA_SEARCH_TYPE`, `EXA_MODEL` (usage label only), `EXA_DAILY_SEARCH_CAP`, `EXA_MAX_RESULTS`, and `EXA_ENABLED`.
  - `createExaProvider(config, { client })` that exposes:
    - `searchNews(input)` and `searchFeeds(input)` with output compatible with current contracts (`provider`, `model`, `usageEvents`, and data schema).
    - strict parsing to avoid passing unsupported provider fields into downstream pipelines.
  - usage event format mapped to existing pipeline usage tracking.
- Add Exa wiring in `src/ai-provider.js`:
  - allow `exa` in supported providers,
  - include in factories and order resolution,
  - keep current fallback behavior (`openai/gemini`) when Exa is missing or fails.
- Add environment/readme/config documentation for enabling Exa and ordering.
- Add lightweight cap mechanism (daily max searches/calls) in Exa provider or callsite so free quota is not accidentally overrun.
- Add test coverage for schema parsing, missing API key behavior, and successful provider contract conversion.
- Add a forward PostgreSQL migration and Drizzle parity update allowing `exa` as `discovered_by`, with integration coverage through both legacy and Drizzle repositories.

## Constraints

- No secrets in source control.
- Module must be additive and non-breaking to current fallback flow.
- Keep request payloads auditable and usage events recorded.
- Share the lightweight daily cap across every Exa provider instance in one process; restarts and multiple processes still require account-side monitoring.
- Store the production token as the GitHub `production` environment secret `EXA_API_KEY`; never place it in `PRODUCTION_ENV_FILE` or a tracked file.
- This ticket only creates the provider layer and integration hook; operational rollout is separate.

## Outputs

- New/updated files:
  - `src/exa-provider.js`
  - `src/ai-provider.js`
  - docs/config updates (env notes)
- Exa provider test(s)

## Branch

codex/exa-provider-module

## Pull Request

- PR URL:
- Reviewer:
- Review status: Not Started
- Verification:
- Follow-up work:

## Agent Run Audit

- Agent Runs entry:
- Started At:
- Finished At:
- Final status:
- Result/evidence:
- Error/blocker:

## Orchestrator Next-Step Loop

- What changed?
- Which usage classes moved away from paid providers first?
- Does Exa become the preferred source for web/news discovery and source maintenance, or only fallback?
- What is the next ticket: "Wire Exa detail search for unresolved primary extraction".

## Blockers

- Exa API quota terms and response schema details.
- Final decision on feature flags and allowed provider order.
