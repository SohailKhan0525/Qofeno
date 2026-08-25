/**
 * Provider registry + routing (#0040/#0044).
 * Routing honors: data classification (never silently moves protected data to
 * another destination — rule #38), capability needs, user preference, health.
 */
import { ErrorCode, QofenoError, classificationRank, defaultMaxClassificationFor, type AiProvider, type ChatChunk, type ChatRequest, type ModelRecord } from "@agent-qofeno/core";
import type { DataClassification, DataDestination } from "@agent-qofeno/core";
import type { OpenAiConfig } from "./openai.js";
import type { OllamaConfig } from "./ollama.js";
import type { AnthropicConfig } from "./anthropic.js";

export interface ProviderConfigs {
  openai?: OpenAiConfig[];
  ollama?: OllamaConfig[];
  anthropic?: AnthropicConfig[];
}

export class ProviderRegistry {
  private providers = new Map<string, AiProvider>();
  private modelCache = new Map<string, { models: ModelRecord[]; atMs: number }>();
  private readonly cacheTtlMs = 60_000;

  register(provider: AiProvider): void {
    this.providers.set(provider.descriptor.id, provider);
  }

  get(id: string): AiProvider | undefined {
    return this.providers.get(id);
  }

  require(id: string): AiProvider {
    const p = this.providers.get(id);
    if (!p) throw new QofenoError({ code: ErrorCode.NOT_FOUND, message: `provider ${id} not configured` });
    return p;
  }

  list(): AiProvider[] {
    return [...this.providers.values()];
  }

  async allModels(): Promise<ModelRecord[]> {
    const out: ModelRecord[] = [];
    for (const p of this.providers.values()) {
      try {
        const cached = this.modelCache.get(p.descriptor.id);
        if (cached && Date.now() - cached.atMs < this.cacheTtlMs) {
          out.push(...cached.models);
          continue;
        }
        const models = await p.listModels();
        this.modelCache.set(p.descriptor.id, { models, atMs: Date.now() });
        out.push(...models);
      } catch {
        // A broken provider must not break the catalog for others (#0094-style isolation).
      }
    }
    return out;
  }

  async findModel(globalModelId: string): Promise<{ provider: AiProvider; model: ModelRecord }> {
    const providerId = globalModelId.split(":")[0]!;
    const provider = this.require(providerId);
    const model = (await this.allModels()).find((m) => m.id === globalModelId);
    if (!model) {
      throw new QofenoError({
        code: ErrorCode.MODEL_UNAVAILABLE,
        message: `model ${globalModelId} not found`,
        userMessage: "That model is no longer available on its provider. Pick another with /model.",
      });
    }
    return { provider, model };
  }
}

export interface RouteRequest {
  classification: DataClassification;
  needs?: Partial<Record<"tools" | "vision" | "structuredOutput" | "embeddings", boolean>>;
  preferredModelId?: string;
  interactive: boolean;
}

export interface RoutedTarget {
  providerId: string;
  modelId: string;
  destination: DataDestination;
  reason: string;
}

/**
 * Deterministic router. Order:
 *   1. explicit preferredModelId if it satisfies classification policy,
 *   2. local providers first when classification is sensitive/local-only,
 *   3. otherwise the first healthy capable provider in registration order.
 */
export async function route(
  registry: ProviderRegistry,
  req: RouteRequest,
): Promise<RoutedTarget> {
  const models = await registry.allModels();
  const capOk = (m: ModelRecord) =>
    (!req.needs?.tools || m.capabilities.tools) &&
    (!req.needs?.vision || m.capabilities.vision) &&
    (!req.needs?.structuredOutput || m.capabilities.structuredOutput);

  const allowedByClassification = (m: ModelRecord): string | null => {
    const max = defaultMaxClassificationFor(m.destination);
    if (max === "none") return null;
    return classificationRank(req.classification) <= classificationRank(max) ? null : `classification ${req.classification} may not go to ${m.destination}`;
  };

  if (req.preferredModelId) {
    const found = models.find((m) => m.id === req.preferredModelId);
    if (!found) {
      if (classificationRank(req.classification) >= classificationRank("sensitive")) {
        throw new QofenoError({
          code: ErrorCode.POLICY_DENIED,
          message: "preferred model unavailable and data is sensitive; refusing silent provider switch",
          userMessage: "The selected model is unavailable and your data is protected — Qofeno will not silently switch providers.",
        });
      }
      // Non-sensitive: fall through to automatic routing.
    } else {
      const block = allowedByClassification(found);
      if (block) {
        throw new QofenoError({
          code: ErrorCode.POLICY_DENIED,
          message: `preferred model rejected: ${block}`,
          userMessage: `Your selected model cannot receive ${req.classification}-classified content (${found.destination} destination). Choose a local model or lower the classification.`,
        });
      }
      if (capOk(found)) {
        return { providerId: found.providerConfigId, modelId: found.modelId, destination: found.destination, reason: "user-selected model" };
      }
      // Capability gap: fall through only when policy permits.
      if (classificationRank(req.classification) >= classificationRank("sensitive")) {
        throw new QofenoError({
          code: ErrorCode.POLICY_DENIED,
          message: "preferred model lacks required capability and data is sensitive",
          userMessage: "The selected model cannot handle this request type, and Qofeno will not silently switch providers for protected data.",
        });
      }
    }
  }

  const candidates = models.filter(capOk).filter((m) => !allowedByClassification(m));
  const rankDestination = (d: DataDestination) => (d === "local" ? 0 : d === "selfhosted" ? 1 : 2);
  candidates.sort(
    (a, b) => rankDestination(a.destination) - rankDestination(b.destination),
  );
  if (candidates.length === 0) {
    throw new QofenoError({
      code: ErrorCode.MODEL_UNAVAILABLE,
      message: "no capable provider satisfies classification policy",
      userMessage: "No available model may receive this content under current policy. Configure a local model with `qofeno provider add ollama`.",
    });
  }
  const chosen = candidates[0]!;
  return {
    providerId: chosen.providerConfigId,
    modelId: chosen.modelId,
    destination: chosen.destination,
    reason: chosen.destination === "local" ? "local-first routing" : `first allowed ${chosen.destination} provider`,
  };
}

/** Execute a chat against a routed target, streaming chunks through. */
export function streamChat(provider: AiProvider, request: ChatRequest): AsyncIterable<ChatChunk> {
  return provider.chat(request);
}
