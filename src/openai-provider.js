import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { NewsDiscovery } from "./ai-news-discovery.js";

const OPENAI_REASONING_EFFORTS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export function getOpenAiConfig(env = process.env) {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim() || "gpt-5.4-2026-03-05";
  const reasoningEffort =
    env.OPENAI_REASONING_EFFORT?.trim().toLowerCase() || "medium";

  if (!apiKey) {
    return null;
  }
  if (!OPENAI_REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(
      "OPENAI_REASONING_EFFORT must be one of none, low, medium, high, xhigh",
    );
  }

  return { apiKey, model, reasoningEffort };
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
        reasoning: { effort: config.reasoningEffort },
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

    async searchNews({ query, windowHours, limit = 8 }) {
      const response = await openai.responses.parse({
        model: config.model,
        store: false,
        reasoning: { effort: config.reasoningEffort },
        max_tool_calls: 4,
        tools: [
          {
            type: "web_search",
            search_context_size: "medium",
            external_web_access: true,
          },
        ],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
        input: [
          {
            role: "system",
            content:
              "Search the live public internet for the most important recent AI news. Prioritize original reporting, publicly readable direct publisher pages, reputable newsrooms, research organizations, and company announcements. Return diverse results from different publishers when available. Return direct article URLs, not search-result pages, social posts, newsletters, or aggregator pages. Do not invent dates, URLs, or claims.",
          },
          {
            role: "user",
            content: JSON.stringify({
              query,
              windowHours,
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
