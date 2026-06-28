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

const VERIFIED_SYSTEM_PROMPT = `You are the editor of a concise English AI news channel.
Use only the supplied primary-source evidence. Do not add facts from memory.
Write like one person explaining the news to another person. Use simple B1
English, short sentences, common words, and no marketing language or technical
jargon unless it is essential. Write 60-100 words and no more than five
sentences, excluding the source URL lines. Include:
- a plain-text headline
- what happened
- why it matters in everyday language
- one clear caveat about uncertainty or source limitations
- source URLs at the end
Do not use markdown tables. Do not claim independent verification when only one
primary source is supplied. Every factual claim must map to one supplied URL.`;

const UNVERIFIED_SYSTEM_PROMPT = `You are the editor of a concise English AI news channel.
The supplied evidence is an unverified community post or rumor. Do not add facts
from memory and do not present its claims as confirmed. Write like one person
explaining the discussion to another person. Use simple B1 English, short
sentences, and common words. Write 60-100 words and no more than five sentences,
excluding source URL lines. Explain what people are discussing, why it may
matter if true, and what proof is still missing. Attribute every claim to the
community source. Include a strong caveat and source URLs.`;

function proseMetrics(text) {
  const prose = text.split(/\n\s*Sources?:\s*\n/i, 1)[0].trim();
  const words = prose ? prose.split(/\s+/).length : 0;
  const sentences = prose
    ? Math.max(1, (prose.match(/[.!?]+(?=\s|$)/g) ?? []).length)
    : 0;
  return { words, sentences };
}

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
  const metrics = proseMetrics(normalized.telegramText);
  if (metrics.sentences > 5) {
    throw new Error("Draft exceeds the five-sentence limit");
  }
  if (metrics.words > 120) {
    throw new Error("Draft exceeds the 120-word safety limit");
  }

  validateMessage(normalized.telegramText);
  return normalized;
}

export async function generateDraft({
  client,
  model,
  repository,
  article,
  evidence,
  allowUnverified = false,
  lease,
}) {
  if (!article?.id) {
    throw new Error("Article is required for draft generation");
  }

  if (
    !evidence.length ||
    (!allowUnverified && evidence.some((item) => !item.primary))
  ) {
    throw new Error("Draft generation requires primary-source evidence");
  }
  const unverified = evidence.some((item) => !item.primary);

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
      systemInstruction: unverified
        ? UNVERIFIED_SYSTEM_PROMPT
        : VERIFIED_SYSTEM_PROMPT,
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

  const grounded = validateGroundedDraft(output, evidence);
  const draft = unverified
    ? TelegramDraft.parse({
        ...grounded,
        telegramText: grounded.telegramText.startsWith("UNVERIFIED TREND")
          ? grounded.telegramText
          : `UNVERIFIED TREND\n\n${grounded.telegramText}`,
      })
    : grounded;
  const saved = await repository.createReviewDraft({
    article_id: article.id,
    body: draft.telegramText,
    status: "review",
    model,
    prompt_version: unverified
      ? "telegram-unverified-trend-v2"
      : "telegram-grounded-v2",
    reviewer_notes: JSON.stringify({
      headline: draft.headline,
      claims: draft.claims,
      source_urls: draft.sourceUrls,
      caveat: draft.caveat,
      verification_status: unverified ? "unverified" : "primary_source",
    }),
    lease_name: lease?.name,
    lease_owner_id: lease?.ownerId,
  });

  return { draft, saved };
}
