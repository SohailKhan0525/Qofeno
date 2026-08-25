/**
 * Provider-neutral AI abstraction (#0040-#0044). Core logic depends only on
 * these interfaces; adapters live in @agent-qofeno/providers.
 */
import type { DataDestination } from "./classification.js";
import { s } from "./schema.js";

export interface ToolSpec {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; argsJson: string }[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  responseJsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export type ChatChunk =
  | { type: "delta"; text: string }
  | { type: "tool_call"; call: { id: string; name: string; argsJson: string } }
  | { type: "usage"; usage: { inputTokens?: number; outputTokens?: number } }
  | { type: "done"; finishReason: "stop" | "length" | "tool_use" | "cancelled" | "error" }
  | { type: "error"; code: string; message: string; retryable: boolean };

export interface ProviderHealth {
  status: "healthy" | "degraded" | "unreachable";
  detail?: string;
  checkedAtMs: number;
}

export interface ProviderDescriptor {
  id: string;
  kind: string;
  label: string;
  destination: DataDestination;
  streaming: boolean;
  authRequired: boolean;
}

export interface ModelCapabilities {
  chat: boolean;
  tools: boolean;
  vision: boolean;
  audioIn: boolean;
  audioOut: boolean;
  structuredOutput: boolean;
  embeddings: boolean;
}

export interface ProviderCapabilities {
  models: boolean;
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  audioIn: boolean;
  audioOut: boolean;
  structuredOutput: boolean;
  embeddings: boolean;
}

export const BASE_CAPABILITIES: ProviderCapabilities = {
  models: false,
  chat: true,
  streaming: false,
  tools: false,
  structuredOutput: false,
  vision: false,
  audioIn: false,
  audioOut: false,
  embeddings: false,
};

export interface ModelRecord {
  id: string;
  providerConfigId: string;
  modelId: string;
  displayName: string;
  contextWindowTokens?: number;
  capabilities: ModelCapabilities;
  destination: DataDestination;
  resourceHint?: string;
  pricing?: { inputUsdPerMTok?: number; outputUsdPerMTok?: number };
}

export interface AiProvider {
  readonly descriptor: ProviderDescriptor;
  listModels(): Promise<ModelRecord[]>;
  chat(request: ChatRequest): AsyncIterable<ChatChunk>;
  embed?(texts: string[], model?: string): Promise<number[][]>;
  health(): Promise<ProviderHealth>;
}

// ---- Validation ------------------------------------------------------------

export const chatRequestSchema = s.object(
  {
    model: s.string({ min: 1, max: 256 }),
    temperature: s.number({ min: 0, max: 2 }).optional(),
    topP: s.number({ min: 0, max: 1 }).optional(),
    maxOutputTokens: s.number({ min: 1, max: 1_000_000 }).optional(),
  },
  { strict: false },
);
