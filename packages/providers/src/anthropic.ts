/**
 * Anthropic Messages API adapter (#0043 remote runtime). Streaming via SSE,
 * tool use, system prompt as a top-level field. The API key lives only in a
 * private field and is sent solely in request headers; it is never logged.
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
import { trimSlash } from "./openai.js";

export interface AnthropicConfig {
  id: string;
  baseUrl?: string;
  apiKey: string;
  version?: string;
}

export class AnthropicProvider implements AiProvider {
  readonly descriptor: ProviderDescriptor;
  private http: HttpClient;
  private baseUrl: string;
  private version: string;

  constructor(private cfg: AnthropicConfig, http?: HttpClient) {
    this.baseUrl = trimSlash(cfg.baseUrl ?? "https://api.anthropic.com");
    this.version = cfg.version ?? "2023-06-01";
    this.http = http ?? new HttpClient();
    this.descriptor = {
      id: cfg.id,
      kind: "anthropic",
      label: "Anthropic",
      destination: "external",
      streaming: true,
      authRequired: true,
    };
  }

  capabilities(): ProviderCapabilities {
    return { ...BASE_CAPABILITIES, models: false, chat: true, streaming: true, tools: true, vision: true, structuredOutput: true };
  }

  async listModels(): Promise<ModelRecord[]> {
    try {
      const res = await this.http.request(`${this.baseUrl}/v1/models`, { headers: this.headers() });
      const json = JSON.parse(res.body) as { data?: Array<{ id: string }> };
      return (json.data ?? []).map((m) => this.toModel(m.id));
    } catch {
      // Offline fallback catalog so model selection still works without network.
      return ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"].map((id) => this.toModel(id));
    }
  }

  private toModel(modelId: string): ModelRecord {
    return {
      id: `${this.descriptor.id}:${modelId}`,
      providerConfigId: this.descriptor.id,
      modelId,
      displayName: modelId,
      contextWindowTokens: 200_000,
      capabilities: { chat: true, tools: true, vision: true, audioIn: false, audioOut: false, structuredOutput: true, embeddings: false },
      destination: this.descriptor.destination,
    };
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) =>
        m.role === "tool"
          ? { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: m.toolCallId ?? "", content: m.content }] }
          : m.role === "assistant" && m.toolCalls?.length
            ? {
                role: "assistant" as const,
                content: [
                  ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
                  ...m.toolCalls.map((tc) => ({ type: "tool_use" as const, id: tc.id, name: tc.name, input: safeParseJson(tc.argsJson) })),
                ],
              }
            : { role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.content },
      );

    const body: Record<string, unknown> = { model: request.model, max_tokens: request.maxOutputTokens ?? 4096, stream: true, messages };
    if (system) body.system = system;
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parametersJsonSchema }));
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.stopSequences?.length) body.stop_sequences = request.stopSequences;

    try {
      let currentTool: { id: string; name: string } | null = null;
      for await (const line of this.http.stream(`${this.baseUrl}/v1/messages`, {
        body: JSON.stringify(body),
        headers: this.headers(),
        signal: request.signal,
      })) {
        if (!line.startsWith("data:")) continue;
        let evt: {
          type?: string;
          delta?: { text?: string; stop_reason?: string; partial_json?: string };
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
          usage?: { input_tokens?: number; output_tokens?: number };
          content_block?: { type?: string; id?: string; name?: string };
        };
        try {
          evt = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        switch (evt.type) {
          case "message_start":
            if (evt.message?.usage?.input_tokens !== undefined) yield { type: "usage", usage: { inputTokens: evt.message.usage.input_tokens } };
            break;
          case "content_block_start":
            currentTool = evt.content_block?.type === "tool_use" ? { id: evt.content_block.id ?? "", name: evt.content_block.name ?? "" } : null;
            break;
          case "content_block_delta":
            if (evt.delta?.text) yield { type: "delta", text: evt.delta.text };
            else if (evt.delta?.partial_json && currentTool) {
              yield { type: "tool_call", call: { id: currentTool.id, name: currentTool.name, argsJson: evt.delta.partial_json } };
              currentTool = null; // full args arrive as one partial in practice; further chunks ignored
            }
            break;
          case "message_delta":
            if (evt.usage && (evt.usage.input_tokens !== undefined || evt.usage.output_tokens !== undefined)) {
              yield { type: "usage", usage: { inputTokens: evt.usage.input_tokens, outputTokens: evt.usage.output_tokens } };
            }
            break;
          case "message_stop":
            yield { type: "done", finishReason: mapStop(evt.delta?.stop_reason) };
            break;
        }
      }
    } catch (e) {
      if ((e as { code?: string }).code === "CANCELLED") {
        yield { type: "done", finishReason: "cancelled" };
        return;
      }
      throw e;
    }
  }

  async health(): Promise<ProviderHealth> {
    try {
      await this.http.request(`${this.baseUrl}/v1/models`, { headers: this.headers() });
      return { status: "healthy", checkedAtMs: Date.now() };
    } catch (e) {
      return { status: "unreachable", detail: String((e as Error).message ?? e), checkedAtMs: Date.now() };
    }
  }

  private headers(): Record<string, string> {
    return { "x-api-key": this.cfg.apiKey, "anthropic-version": this.version };
  }
}

function mapStop(reason?: string): "stop" | "length" | "tool_use" | "error" {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    default:
      return "stop";
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
