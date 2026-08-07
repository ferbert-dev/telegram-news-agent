import { z } from "zod";

const HttpUrl = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Invalid HTTP URL");

export const FeedDiscovery = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(2).max(160),
        feedUrl: HttpUrl,
        homepageUrl: HttpUrl.nullable().optional(),
      }),
    )
    .max(8),
});

export const FEED_DISCOVERY_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          feedUrl: { type: "string" },
          homepageUrl: { type: ["string", "null"] },
        },
        required: ["name", "feedUrl", "homepageUrl"],
      },
    },
  },
  required: ["items"],
};
