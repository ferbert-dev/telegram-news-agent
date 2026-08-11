import { z } from "zod";

const HttpUrl = z.string().min(1).refine((value) => {
  if (!URL.canParse(value)) return false;
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Invalid HTTP evidence URL");

export const FactSearchEvidence = z
  .object({
    fact: z
      .object({
        claim: z.string().min(1).max(500),
        sourceUrl: HttpUrl,
        sourceTitle: z.string().min(1).max(300),
        sourceKind: z.enum([
          "official",
          "government",
          "academic",
          "reputable_news",
        ]),
        evidenceText: z.string().min(1).max(500),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const FACT_SEARCH_EVIDENCE_JSON_SCHEMA = {
  type: "object",
  properties: {
    fact: {
      anyOf: [
        {
          type: "object",
          properties: {
            claim: { type: "string" },
            sourceUrl: { type: "string" },
            sourceTitle: { type: "string" },
            sourceKind: {
              type: "string",
              enum: [
                "official",
                "government",
                "academic",
                "reputable_news",
              ],
            },
            evidenceText: { type: "string" },
          },
          required: [
            "claim",
            "sourceUrl",
            "sourceTitle",
            "sourceKind",
            "evidenceText",
          ],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
  },
  required: ["fact"],
  additionalProperties: false,
};

function normalizedHttpUrl(value) {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/, "");
  return url.href;
}

export function groundedFactEvidence(value, sourceUrls) {
  const parsed = FactSearchEvidence.safeParse(value);
  if (!parsed.success || !parsed.data.fact) return { fact: null };
  const allowed = new Set(
    sourceUrls.map(normalizedHttpUrl).filter((url) => url !== null),
  );
  const factUrl = normalizedHttpUrl(parsed.data.fact.sourceUrl);
  return factUrl && allowed.has(factUrl) ? parsed.data : { fact: null };
}
