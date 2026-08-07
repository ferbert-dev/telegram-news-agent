import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { NewsDiscovery } from "./ai-news-discovery.js";

export function getOpenAiConfig(env = process.env) {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim() || "gpt-5.6";

  if (!apiKey) {
    return null;
  }

  return { apiKey, model };
}

export function createOpenAiProvider(
  config = getOpenAiConfig(),
  { client } = {},
) {
  if (!config) {
    return null;
  }
  const openai = client ?? new OpenAI({ apiKey: config.apiKey });

  return {
    name: "openai",
    model: config.model,

    async generateStructured({
      systemInstruction,
      input,
      zodSchema,
      schemaName,
    }) {
      const response = await openai.responses.parse({
        model: config.model,
        store: false,
        input: [
          { role: "system", content: systemInstruction },
          { role: "user", content: JSON.stringify(input) },
        ],
        text: {
          format: zodTextFormat(zodSchema, schemaName),
        },
      });
      if (!response.output_parsed) {
        throw new Error("OpenAI returned no structured response");
      }
      return {
        value: response.output_parsed,
        provider: "openai",
        model: config.model,
      };
    },

    async searchNews({ query, windowHours, allowedDomains, limit = 8 }) {
      const response = await openai.responses.parse({
        model: config.model,
        store: false,
        max_tool_calls: 4,
        tools: [{ type: "web_search" }],
        include: ["web_search_call.action.sources"],
        input: [
          {
            role: "system",
            content:
              "Search for recent news from the allowed official publisher domains only. Return direct article URLs, not search pages or aggregators. Do not invent dates, URLs, or claims.",
          },
          {
            role: "user",
            content: JSON.stringify({
              query,
              windowHours,
              allowedDomains,
              maximumItems: limit,
            }),
          },
        ],
        text: {
          format: zodTextFormat(NewsDiscovery, "recent_news_discovery"),
        },
      });
      if (!response.output_parsed) {
        throw new Error("OpenAI web search returned no structured response");
      }
      return {
        ...response.output_parsed,
        provider: "openai",
        model: config.model,
      };
    },
  };
}
