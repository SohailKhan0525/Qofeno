export * from "./http.js";
export * from "./openai.js";
export * from "./ollama.js";
export * from "./openrouter.js";
export * from "./gemini.js";
export { AnthropicProvider } from "./anthropic.js";
export * from "./registry.js";
export * from "./setup.js";

import { AnthropicProvider, type AnthropicConfig } from "./anthropic.js";
import { OpenRouterProvider, type OpenRouterConfig } from "./openrouter.js";
import { GeminiProvider, type GeminiConfig } from "./gemini.js";
import { OpenAiCompatibleProvider, type OpenAiConfig } from "./openai.js";
import type { AiProvider } from "@agent-qofeno/core";

export function createAnthropicProvider(cfg: AnthropicConfig): AiProvider {
  return new AnthropicProvider(cfg);
}

export function createOpenRouterProvider(cfg: OpenRouterConfig): AiProvider {
  return new OpenRouterProvider(cfg);
}

export function createGeminiProvider(cfg: GeminiConfig): AiProvider {
  return new GeminiProvider(cfg);
}

export function createOpenAiProvider(cfg: OpenAiConfig): AiProvider {
  return new OpenAiCompatibleProvider(cfg);
}
