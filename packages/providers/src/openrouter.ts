/**
 * OpenRouter provider adapter (#0043/#0044).
 * Connects to OpenRouter's unified API gateway (https://openrouter.ai/api/v1)
 * with dynamic model discovery, context window tracking, multimodal flags,
 * and streaming chat completions.
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

export interface OpenRouterConfig {
  id: string;
  apiKey?: string;
  baseUrl?: string;
  label?: string;
  headers?: Record<string, string>;
}

export class OpenRouterProvider implements AiProvider {
  readonly descriptor: ProviderDescriptor;
  private inner: OpenAiCompatibleProvider;
  private http: HttpClient;
  private baseUrl: string;

  constructor(private cfg: OpenRouterConfig, http?: HttpClient) {
    this.http = http ?? new HttpClient();
    this.baseUrl = trimSlash(cfg.baseUrl ?? "https://openrouter.ai/api/v1");
    this.descriptor = {
      id: cfg.id,
      kind: "openrouter",
      label: cfg.label ?? "OpenRouter",
      destination: "external",
      streaming: true,
      authRequired: true,
    };
    const openAiCfg: OpenAiConfig = {
      id: cfg.id,
      baseUrl: this.baseUrl,
      apiKey: cfg.apiKey,
      label: this.descriptor.label,
      headers: {
        "HTTP-Referer": "https://qofeno.dev",
        "X-Title": "Qofeno",
        ...(cfg.headers ?? {}),
      },
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
      const res = await this.http.request(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
      });
      const json = JSON.parse(res.body) as {
        data?: Array<{
          id: string;
          name?: string;
          description?: string;
          context_length?: number;
          architecture?: { modality?: string };
        }>;
      };
      return (json.data ?? []).map((m) => ({
        id: `${this.descriptor.id}:${m.id}`,
        providerConfigId: this.descriptor.id,
        modelId: m.id,
        displayName: m.name ?? m.id,
        contextWindowTokens: m.context_length ?? 128_000,
        capabilities: {
          chat: true,
          tools: true,
          vision: /vision|image|multimodal|vl/i.test(m.architecture?.modality ?? "") || /vl|vision|4o|gemini|claude/i.test(m.id),
          audioIn: false,
          audioOut: false,
          structuredOutput: true,
          embeddings: false,
        },
        destination: this.descriptor.destination,
      }));
    } catch {
      // Return popular default models if listing endpoint is unreachable or offline
      return [
        "anthropic/claude-3.5-sonnet",
        "openai/gpt-4o",
        "openai/gpt-4o-mini",
        "google/gemini-2.0-flash-001",
        "meta-llama/llama-3.3-70b-instruct",
        "deepseek/deepseek-chat",
      ].map((id) => ({
        id: `${this.descriptor.id}:${id}`,
        providerConfigId: this.descriptor.id,
        modelId: id,
        displayName: id,
        contextWindowTokens: 128_000,
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
  }

  chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    return this.inner.chat(request);
  }

  embed(texts: string[], model?: string): Promise<number[][]> {
    return this.inner.embed(texts, model);
  }

  async health(): Promise<ProviderHealth> {
    try {
      const models = await this.listModels();
      return {
        status: models.length ? "healthy" : "degraded",
        checkedAtMs: Date.now(),
      };
    } catch (e) {
      return {
        status: "unreachable",
        detail: String((e as Error).message ?? e),
        checkedAtMs: Date.now(),
      };
    }
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "HTTP-Referer": "https://qofeno.dev",
      "X-Title": "Qofeno",
      ...(this.cfg.headers ?? {}),
    };
    if (this.cfg.apiKey) h["Authorization"] = `Bearer ${this.cfg.apiKey}`;
    return h;
  }
}
