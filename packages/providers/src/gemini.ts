/**
 * Google Gemini provider adapter (#0043/#0044).
 * Connects to Google Gemini API via the OpenAI-compatible endpoint or REST.
 * Supports streaming, function calling, multimodal input, and structured output.
 */
import {
  BASE_CAPABILITIES,
  type AiProvider,
  type ChatChunk,
  type ChatRequest,
  type ModelRecord,
  type ProviderCapabilities,
  type ProviderDescriptor,
  type ProviderHealth,
} from "@agent-qofeno/core";
import { HttpClient } from "./http.js";
import { OpenAiCompatibleProvider, type OpenAiConfig, trimSlash } from "./openai.js";

export interface GeminiConfig {
  id: string;
  apiKey?: string;
  baseUrl?: string;
  label?: string;
}

export class GeminiProvider implements AiProvider {
  readonly descriptor: ProviderDescriptor;
  private inner: OpenAiCompatibleProvider;
  private http: HttpClient;
  private baseUrl: string;

  constructor(private cfg: GeminiConfig, http?: HttpClient) {
    this.http = http ?? new HttpClient();
    this.baseUrl = trimSlash(cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta/openai");
    this.descriptor = {
      id: cfg.id,
      kind: "gemini",
      label: cfg.label ?? "Google Gemini",
      destination: "external",
      streaming: true,
      authRequired: true,
    };
    const openAiCfg: OpenAiConfig = {
      id: cfg.id,
      baseUrl: this.baseUrl,
      apiKey: cfg.apiKey,
      label: this.descriptor.label,
    };
    this.inner = new OpenAiCompatibleProvider(openAiCfg, this.http);
  }

  capabilities(): ProviderCapabilities {
    return {
      ...BASE_CAPABILITIES,
      models: true,
      chat: true,
      streaming: true,
      tools: true,
      vision: true,
      structuredOutput: true,
    };
  }

  async listModels(): Promise<ModelRecord[]> {
    try {
      const models = await this.inner.listModels();
      if (models.length > 0) return models;
    } catch {
      // fallback
    }
    return [
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ].map((id) => ({
      id: `${this.descriptor.id}:${id}`,
      providerConfigId: this.descriptor.id,
      modelId: id,
      displayName: id,
      contextWindowTokens: id.includes("1.5") || id.includes("2.0") ? 1_000_000 : 128_000,
      capabilities: {
        chat: true,
        tools: true,
        vision: true,
        audioIn: false,
        audioOut: false,
        structuredOutput: true,
        embeddings: false,
      },
      destination: this.descriptor.destination,
    }));
  }

  chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    return this.inner.chat(request);
  }

  embed(texts: string[], model?: string): Promise<number[][]> {
    return this.inner.embed(texts, model ?? "text-embedding-004");
  }

  health(): Promise<ProviderHealth> {
    return this.inner.health();
  }
}
