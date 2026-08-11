import { z } from "zod";

const Claim = z.object({
  text: z.string().min(1),
  sourceUrl: z.string().url(),
});

const TopicTagAssignment = z
  .object({
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const BaseTelegramDraft = z.object({
  headline: z.string().min(1).max(120),
  telegramText: z.string().min(1).max(4096),
  claims: z.array(Claim).min(1).max(12),
  sourceUrls: z.array(z.string().url()).min(1).max(6),
  caveat: z.string().min(1).max(500),
});

export const TelegramDraft = BaseTelegramDraft.extend({
  topicTags: z.array(TopicTagAssignment).max(3),
});

export const BASE_TELEGRAM_DRAFT_JSON_SCHEMA = {
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
  required: ["headline", "telegramText", "claims", "sourceUrls", "caveat"],
};

export const TELEGRAM_DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: {
    ...BASE_TELEGRAM_DRAFT_JSON_SCHEMA.properties,
    topicTags: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          code: {
            type: "string",
            pattern: "^[a-z0-9]+(?:[-_][a-z0-9]+)*$",
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["code", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: [...BASE_TELEGRAM_DRAFT_JSON_SCHEMA.required, "topicTags"],
};
