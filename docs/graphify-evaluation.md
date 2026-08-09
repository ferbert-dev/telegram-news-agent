# Graphify evaluation

Status: provisionally keep for the NestJS and Drizzle Epic; reevaluate at Epic retrospective.

## Setup

Graphify is installed project-locally in `.codex/skills/graphify/`. The lightweight `.codex/hooks.json` freshness check runs before tool use. The committed graph is code-only and AST-derived, so extraction does not call an LLM or consume OpenAI API tokens.

Evaluated version: Graphify 0.9.17.

Baseline commands:

```bash
graphify extract . --code-only
graphify cluster-only . --no-label
graphify benchmark graphify-out/graph.json
```

## Measurements on 2026-08-09

| Measure | Result |
| --- | ---: |
| Detected code files | 132, including 27 ordered SQL migrations |
| Represented source files | 131 |
| Graph nodes | 874 |
| Graph edges | 1,738 |
| Communities | 59 at benchmark; 60 after the portable-hook refresh |
| Structural health errors | 0 dangling, missing, self-loop or collapsed edges |
| Initial extraction | 1.95 seconds |
| Clustering | 1.07 seconds |
| Typical narrow Graphify command | 0.15-0.30 seconds |
| Equivalent targeted `rg` | 0.01-0.03 seconds |
| Generated directory | approximately 1.9 MB |
| Source corpus estimate | 43,700 words / approximately 58,266 naive tokens |
| Average benchmark query estimate | approximately 6,043 tokens |
| Estimated retrieval reduction | 9.6x |

The token figures are an estimator, not billed-token telemetry. Graphify derives
its corpus estimate as `node count * 50` words, while the original benchmark
snapshot contained approximately 65,587 whitespace-delimited words and 704,750
bytes. Its
generic benchmark matched only three of five sample questions. The result does
not prove that a model response costs 9.6x less, because prompt overhead, tool
output, follow-up source reads and cache behavior still matter.

## Observed usefulness

- Broad natural-language queries were noisy: a migration query returned 279
  nodes. `--context call` reduced it to 37, but still required source review.
- `graphify affected "NewsRepository" --depth 2 --relation imports` returned the
  same nine importers found by `rg` and exposed the persistence hub without
  reading the whole repository.
- Unfiltered inferred relationships produced false-looking AI-provider links.
  Relation-filtered `affected` reduced `SourcesRepository` to its two real
  consumers.
- `path` reports structural connectivity, not runtime control flow. A two-hop
  scheduler/publication path through `telegram-bot.js` meant that the file
  imported both symbols, not that one function directly called the other.
- Graphify is most useful after the question is narrowed with relation-filtered
  `affected`, `path`, or `explain`, and the returned files are then verified
  with `rg` and direct reads.
- Graphify does not replace PostgreSQL introspection. It cannot establish current function signatures, constraint semantics, grants, policies, live drift or transaction correctness.
- For example, explaining `public.update_news_settings()` selected an older SQL
  definition even though a later migration replaces it. Ordered migrations
  determine the current definition.
- The report contains 159 isolated nodes and several low-cohesion communities,
  so navigation quality is uneven.

## Operating rule

Use Graphify first for relationship and impact questions, with a bounded output
budget. Prefer `affected --relation imports` or `--relation calls` at depth one
or two. Use `query --context call` only for exploration. Save a result only
when it materially improves or misdirects navigation. Verify migration-critical
claims in source, ordered SQL, tests or the database.

After code changes, preserve the code-only corpus:

```bash
graphify extract . --code-only
```

The generic `graphify update .` also detects changed Markdown and can expand
this repository's graph beyond the evaluated code-only scope. A forced
code-only rebuild is permitted only after reviewing an intentional shrink.

Do not force-refresh after an unexpected graph shrink until the deletion is understood.

## Keep or remove criterion

Keep Graphify for the first three to five migration slices if it continues to:

- identify at least one verified dependency every several slices that a
  targeted `rg` search did not surface immediately;
- keep useful queries bounded enough to reduce source reads;
- update in a few seconds and require less than roughly one minute of
  maintenance per slice.

Remove it in a separately reviewed change if the retention gate fails,
relationships remain stale or misleading, or generated-file churn exceeds the
measured time saved. The Epic retrospective records the final decision.
