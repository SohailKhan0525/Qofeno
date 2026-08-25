/**
 * OpenAI-compatible adapter (#0043). Works against api.openai.com and any
 * compatible endpoint (vLLM, LM Studio, llama.cpp server, Groq, Together,
 * OpenRouter, Gemini's compatibility endpoint...). Supports streaming,
 * tool calls, structured output (json_schema) and embeddings.
 */
import {
  BASE_CAPABILITIES,
  ErrorCode,
  QofenoError,
  type AiProvider,
  type ChatChunk,
  type ChatRequest,
  type ModelRecord,
  type ProviderCapabilities,
  type ProviderDescriptor,
  type ProviderHealth,
} from "@agent-qofeno/core";
import { HttpClient } from "./http.js";

export interface OpenAiConfig {
  id: string;
  baseUrl: string;
  apiKey?: string;
  label?: string;
  /** Extra headers, e.g. for gateways. */
  headers?: Record<string, string>;
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly descriptor: ProviderDescriptor;
  private http: HttpClient;

  constructor(private cfg: OpenAiConfig, http?: HttpClient) {
    this.http = http ?? new HttpClient();
    const host = safeHost(cfg.baseUrl);
    this.descriptor = {
      id: cfg.id,
      kind: "openai-compatible",
      label: cfg.label ?? cfg.id,
      destination: isLocal(host) ? "local" : "external",
      streaming: true,
      authRequired: Boolean(cfg.apiKey),
    };
  }

  capabilities(): ProviderCapabilities {
    // Capabilities are refined per model after listModels().
    return { ...BASE_CAPABILITIES, models: true, chat: true, streaming: true };
  }

  async listModels(): Promise<ModelRecord[]> {
    const res = await this.http.request(`${trimSlash(this.cfg.baseUrl)}/models`, {
      headers: this.authHeaders(),
    });
    const json = JSON.parse(res.body) as { data?: Array<{ id: string; context_window?: number; owned_by?: string }> };
    return (json.data ?? []).map((m) => ({
      id: `${this.cfg.id}:${m.id}`,
      providerConfigId: this.cfg.id,
      modelId: m.id,
      displayName: m.id,
      contextWindowTokens: m.context_window,
      capabilities: {
        ...defaultModelCaps(),
        tools: true,
        vision: /vl|vision|4o|omni|gemini|claude-3|gpt-5/i.test(m.id),
        embeddings: false,
      },
      destination: this.descriptor.destination,
    }));
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls ? { tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.argsJson } })) } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools?.length) body.tools = request.tools.map((t) => ({ type: "function", function: t }));
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
    if (request.stopSequences?.length) body.stop = request.stopSequences;
    if (request.responseJsonSchema) body.response_format = { type: "json_schema", json_schema: { name: "response", schema: request.responseJsonSchema } };

    const url = `${trimSlash(this.cfg.baseUrl)}/chat/completions`;
    try {
      for await (const line of this.http.stream(url, {
        body: JSON.stringify(body),
        headers: this.authHeaders(),
        signal: request.signal,
      })) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") break;
        let evt: {
          choices?: Array<{
            delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } } | undefined> };
            finish_reason?: string | null;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          evt = JSON.parse(payload);
        } catch {
          continue; // tolerate keepalives/partial lines
        }
        if (evt.usage) {
          yield { type: "usage", usage: { inputTokens: evt.usage.prompt_tokens, outputTokens: evt.usage.completion_tokens } };
        }
        const choice = evt.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) yield { type: "delta", text: delta.content };
        for (const tc of delta?.tool_calls ?? []) {
          if (tc?.function?.name && tc.id !== undefined) {
            yield { type: "tool_call", call: { id: tc.id, name: tc.function.name, argsJson: tc.function.arguments ?? "{}" } };
          }
        }
        if (choice.finish_reason) {
          yield {
            type: "done",
            finishReason:
              choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "length" : choice.finish_reason === "stop" ? "stop" : "error",
          };
        }
      }
    } catch (e) {
      if ((e as QofenoError)?.code === ErrorCode.CANCELLED) {
        yield { type: "done", finishReason: "cancelled" };
        return;
      }
      throw e;
    }
  }

  async embed(texts: string[], model = "text-embedding-3-small"): Promise<number[][]> {
    const res = await this.http.request(`${trimSlash(this.cfg.baseUrl)}/embeddings`, {
      method: "POST",
      body: JSON.stringify({ model, input: texts }),
      headers: this.authHeaders(),
    });
    const json = JSON.parse(res.body) as { data?: Array<{ embedding: number[] }> };
    return (json.data ?? []).map((d) => d.embedding);
  }

  async health(): Promise<ProviderHealth> {
    try {
      await this.listModels();
      return { status: "healthy", checkedAtMs: Date.now() };
    } catch (e) {
      return { status: "unreachable", detail: String((e as Error).message ?? e), checkedAtMs: Date.now() };
    }
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...(this.cfg.headers ?? {}) };
    if (this.cfg.apiKey) h["Authorization"] = `Bearer ${this.cfg.apiKey}`;
    return h;
  }
}

export function defaultModelCaps() {
  return { chat: true, tools: false, vision: false, audioIn: false, audioOut: false, structuredOutput: true, embeddings: false };
}

export function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new QofenoError({ code: ErrorCode.VALIDATION_FAILED, message: `invalid provider base url` });
  }
}

export function isLocal(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/.test(host);
}
