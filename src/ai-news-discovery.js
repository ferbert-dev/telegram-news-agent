import { z } from "zod";

const DirectArticleUrl = z
  .string()
  .min(1)
  .refine((value) => URL.canParse(value), "Invalid article URL");

export const NewsDiscovery = z.object({
  items: z
    .array(
      z.object({
        title: z.string().min(1),
        // OpenAI Structured Outputs does not accept JSON Schema's `uri`
        // format, so keep URL validation in Zod after the response is parsed.
        url: DirectArticleUrl,
        summary: z.string().min(1),
        publishedAt: z.string().nullable().optional(),
        author: z.string().nullable().optional(),
      }),
    )
    .max(10),
});

export const NEWS_DISCOVERY_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          summary: { type: "string" },
          publishedAt: { type: "string" },
          author: { type: "string" },
        },
        required: ["title", "url", "summary"],
      },
    },
  },
  required: ["items"],
};
