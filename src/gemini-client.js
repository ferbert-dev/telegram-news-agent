import { GoogleGenAI } from "@google/genai";

export function getGeminiConfig(env = process.env) {
  const apiKey = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required");
  }

  return { apiKey, model };
}

export function createGeminiClient(config = getGeminiConfig()) {
  return {
    client: new GoogleGenAI({ apiKey: config.apiKey }),
    model: config.model,
  };
}
