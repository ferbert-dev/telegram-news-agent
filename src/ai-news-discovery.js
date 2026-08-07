import { z } from "zod";

export const NewsDiscovery = z.object({
  items: z
    .array(
      z.object({
        title: z.string().min(1),
        url: z.string().url(),
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
