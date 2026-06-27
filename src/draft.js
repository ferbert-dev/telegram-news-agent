import { z } from "zod";
import { validateMessage } from "./telegram.js";

const Claim = z.object({
  text: z.string().min(1),
  sourceUrl: z.string().url(),
});

export const TelegramDraft = z.object({
  headline: z.string().min(1).max(120),
  telegramText: z.string().min(1).max(4096),
  claims: z.array(Claim).min(1).max(12),
  sourceUrls: z.array(z.string().url()).min(1).max(6),
  caveat: z.string().min(1).max(500),
});

const SYSTEM_PROMPT = `You are the editor of a concise English AI news channel.
Use only the supplied primary-source evidence. Do not add facts from memory.
Write a 150-250 word Telegram article with:
- a plain-text headline
- a concise explanation of what happened
- why it matters
- a clear caveat about uncertainty or source limitations
- source URLs at the end
Do not use markdown tables. Do not claim independent verification when only one
primary source is supplied. Every factual claim must map to one supplied URL.`;

export function validateGroundedDraft(draft, evidence) {
  const parsed = TelegramDraft.parse(draft);
  const allowedUrls = new Set(evidence.map((item) => item.url));

  for (const claim of parsed.claims) {
    if (!allowedUrls.has(claim.sourceUrl)) {
      throw new Error(`Draft cites unsupported source: ${claim.sourceUrl}`);
    }
  }

  for (const sourceUrl of parsed.sourceUrls) {
    if (!allowedUrls.has(sourceUrl)) {
      throw new Error(`Draft lists unsupported source: ${sourceUrl}`);
    }
  }

  const sourceUrls = [
    ...new Set([
      ...parsed.sourceUrls,
      ...parsed.claims.map((claim) => claim.sourceUrl),
    ]),
  ];
  const missingUrls = sourceUrls.filter(
    (sourceUrl) => !parsed.telegramText.includes(sourceUrl),
  );
  const telegramText = missingUrls.length
    ? `${parsed.telegramText.trim()}\n\nSources:\n${missingUrls.join("\n")}`
    : parsed.telegramText;
  const normalized = TelegramDraft.parse({
    ...parsed,
    telegramText,
    sourceUrls,
  });

  validateMessage(normalized.telegramText);
  return normalized;
}

export async function generateDraft({
  client,
  model,
  repository,
  article,
  evidence,
}) {
  if (!article?.id) {
    throw new Error("Article is required for draft generation");
  }

  if (!evidence.length || evidence.some((item) => !item.primary)) {
    throw new Error("Draft generation requires primary-source evidence");
  }

  const response = await client.models.generateContent({
    model,
    contents: JSON.stringify({
      task: "Create one review-ready Telegram article.",
      article: {
        title: article.title,
        url: article.canonical_url,
        publishedAt: article.published_at,
      },
      evidence,
    }),
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          headline: { type: "string" },
          telegramText: { type: "string" },
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                sourceUrl: { type: "string" },
              },
              required: ["text", "sourceUrl"],
            },
          },
          sourceUrls: {
            type: "array",
            items: { type: "string" },
          },
          caveat: { type: "string" },
        },
        required: [
          "headline",
          "telegramText",
          "claims",
          "sourceUrls",
          "caveat",
        ],
      },
    },
  });

  if (!response.text) {
    throw new Error("Gemini returned no structured draft");
  }

  let output;
  try {
    output = JSON.parse(response.text);
  } catch {
    throw new Error("Gemini returned invalid JSON");
  }

  const draft = validateGroundedDraft(output, evidence);
  await repository.transitionArticle(article.id, "discovered", "extracted");
  await repository.transitionArticle(article.id, "extracted", "reviewed");
  const saved = await repository.createDraft({
    article_id: article.id,
    body: draft.telegramText,
    status: "review",
    model,
    prompt_version: "telegram-grounded-v1",
    reviewer_notes: JSON.stringify({
      headline: draft.headline,
      claims: draft.claims,
      source_urls: draft.sourceUrls,
      caveat: draft.caveat,
    }),
  });
  await repository.transitionArticle(article.id, "reviewed", "drafted");

  return { draft, saved };
}
