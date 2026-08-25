export * from "./http.js";
export * from "./openai.js";
export * from "./ollama.js";
export { AnthropicProvider } from "./anthropic.js";
export * from "./registry.js";

import { AnthropicProvider } from "./anthropic.js";
import type { AiProvider } from "@agent-qofeno/core";
import type { AnthropicConfig } from "./anthropic.js";

export function createAnthropicProvider(cfg: AnthropicConfig): AiProvider {
  return new AnthropicProvider(cfg);
}
