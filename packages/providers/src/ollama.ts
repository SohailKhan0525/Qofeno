/**
 * Ollama adapter (#0042 local model runtime). First-class local AI: model
 * discovery via /api/tags, streaming chat via /api/chat (NDJSON), embeddings
 * via /api/embed. Never downloads or pulls models without an explicit,
 * user-approved action.
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
import { isLocal, trimSlash } from "./openai.js";

export interface OllamaConfig {
  id: string;
  baseUrl?: string;
}

export class OllamaProvider implements AiProvider {
  readonly descriptor: ProviderDescriptor;
  private http: HttpClient;
  private baseUrl: string;

  constructor(cfg: OllamaConfig, http?: HttpClient) {
    this.baseUrl = trimSlash(cfg.baseUrl ?? "http://localhost:11434");
    this.http = http ?? new HttpClient({ timeoutMs: 600_000 });
    this.descriptor = {
      id: cfg.id,
      kind: "ollama",
      label: `Ollama (${this.baseUrl})`,
      destination: isLocal(new URL(this.baseUrl).host) ? "local" : "selfhosted",
      streaming: true,
      authRequired: false,
    };
  }

  capabilities(): ProviderCapabilities {
    return { ...BASE_CAPABILITIES, streaming: true, tools: true, vision: true, embeddings: true, structuredOutput: true };
  }

  async listModels(): Promise<ModelRecord[]> {
    const res = await this.http.request(`${this.baseUrl}/api/tags`);
    const json = JSON.parse(res.body) as {
      models?: Array<{ name: string; details?: { parameter_size?: string; quantization_level?: string }; size?: number }>;
    };
    return (json.models ?? []).map((m) => ({
      id: `${this.descriptor.id}:${m.name}`,
      providerConfigId: this.descriptor.id,
      modelId: m.name,
      displayName: `${m.name}${m.details?.parameter_size ? ` · ${m.details.parameter_size}` : ""}`,
      contextWindowTokens: undefined,
      capabilities: { chat: true, tools: true, vision: /llava|vision|vl\b|minicpm-v/i.test(m.name), audioIn: false, audioOut: false, structuredOutput: true, embeddings: /embed/i.test(m.name) },
      destination: this.descriptor.destination,
      resourceHint: m.size ? `${Math.round(m.size / (1024 * 1024))} MB on disk` : undefined,
    }));
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: t,
      }));
    }
    const opts: Record<string, unknown> = {};
    if (request.temperature !== undefined) opts.temperature = request.temperature;
    if (request.topP !== undefined) opts.top_p = request.topP;
    if (Object.keys(opts).length) body.options = opts;
    if (request.responseJsonSchema) body.format = request.responseJsonSchema;

    try {
      for await (const line of this.http.stream(`${this.baseUrl}/api/chat`, {
        body: JSON.stringify(body),
        signal: request.signal,
      })) {
        if (!line.trim()) continue;
        let evt: {
          message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
          error?: string;
        };
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.error) {
          yield { type: "error", code: "provider_error", message: evt.error, retryable: false };
          continue;
        }
        const content = evt.message?.content;
        if (content) yield { type: "delta", text: content };
        for (const tc of evt.message?.tool_calls ?? []) {
          if (tc.function?.name) {
            yield {
              type: "tool_call",
              call: { id: `call_${Math.random().toString(36).slice(2)}`, name: tc.function.name, argsJson: JSON.stringify(tc.function.arguments ?? {}) },
            };
          }
        }
        if (evt.done) {
          if (evt.prompt_eval_count !== undefined || evt.eval_count !== undefined) {
            yield { type: "usage", usage: { inputTokens: evt.prompt_eval_count, outputTokens: evt.eval_count } };
          }
          yield { type: "done", finishReason: evt.message?.tool_calls?.length ? "tool_use" : "stop" };
        }
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "CANCELLED") {
        yield { type: "done", finishReason: "cancelled" };
        return;
      }
      throw e;
    }
  }

  async embed(texts: string[], model = "nomic-embed-text"): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) {
      const res = await this.http.request(`${this.baseUrl}/api/embed`, {
        method: "POST",
        body: JSON.stringify({ model, input: text }),
      });
      const json = JSON.parse(res.body) as { embeddings?: number[][] };
      out.push(json.embeddings?.[0] ?? []);
    }
    return out;
  }

  async health(): Promise<ProviderHealth> {
    try {
      await this.listModels();
      return { status: "healthy", checkedAtMs: Date.now() };
    } catch {
      return {
        status: "unreachable",
        detail: `No Ollama server at ${this.baseUrl}. Install from https://ollama.com and run \`ollama serve\`.`,
        checkedAtMs: Date.now(),
      };
    }
  }
}
