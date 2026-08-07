import { GoogleGenAI } from "@google/genai";
import {
  NEWS_DISCOVERY_JSON_SCHEMA,
  NewsDiscovery,
} from "./ai-news-discovery.js";

export function getGeminiProviderConfig(env = process.env) {
  const apiKey = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";

  if (!apiKey) {
    return null;
  }

  return { apiKey, model };
}

function parseJsonText(text) {
  const normalized = String(text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(normalized);
}

export function createGeminiProvider(
  config = getGeminiProviderConfig(),
  { client } = {},
) {
  if (!config) {
    return null;
  }
  const gemini = client ?? new GoogleGenAI({ apiKey: config.apiKey });

  const generateStructured = async ({
    systemInstruction,
    input,
    zodSchema,
    jsonSchema,
  }) => {
    const response = await gemini.models.generateContent({
      model: config.model,
      contents: JSON.stringify(input),
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema,
      },
    });
    if (!response.text) {
      throw new Error("Gemini returned no structured response");
    }
    return {
      value: zodSchema.parse(parseJsonText(response.text)),
      provider: "gemini",
      model: config.model,
    };
  };

  return {
    name: "gemini",
    model: config.model,
    generateStructured,

    async searchNews({ query, windowHours, limit = 8 }) {
      const response = await gemini.models.generateContent({
        model: config.model,
        contents: JSON.stringify({
          query,
          windowHours,
          maximumItems: limit,
        }),
        config: {
          systemInstruction:
            "Use Google Search to find the most important recent AI news across the public internet. Prioritize original reporting, publicly readable direct publisher pages, reputable newsrooms, research organizations, and company announcements. Return diverse results from different publishers when available. Exclude search-result pages, social posts, newsletters, and aggregator pages. Return direct article URLs. Output one JSON object with an items array and no markdown. Each item must contain title, url, summary, and, when available, publishedAt and author. Do not invent dates, URLs, or claims.",
          tools: [{ googleSearch: {} }],
        },
      });
      if (!response.text) {
        throw new Error("Gemini web search returned no response");
      }

      let parsed;
      try {
        parsed = NewsDiscovery.parse(parseJsonText(response.text));
      } catch {
        const normalized = await generateStructured({
          systemInstruction:
            "Convert the supplied web-search answer into the requested schema. Preserve only explicit article titles, direct URLs, summaries, dates, and authors. Do not add facts.",
          input: { searchAnswer: response.text },
          zodSchema: NewsDiscovery,
          jsonSchema: NEWS_DISCOVERY_JSON_SCHEMA,
        });
        parsed = normalized.value;
      }

      return {
        ...parsed,
        provider: "gemini",
        model: config.model,
      };
    },
  };
}
