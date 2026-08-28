/**
 * Runtime bundle assembly: builds the full engine graph from configuration
 * and storage. Single place where implementations are bound to interfaces.
 */
import { join } from "node:path";
import { SqliteStorage } from "@agent-qofeno/storage";
import type { AiProvider } from "@agent-qofeno/core";
import { qofenoPaths, ensurePaths, detectCapabilities } from "@agent-qofeno/runtime";
import { detectSecretStore } from "@agent-qofeno/security";
import { ConfigLoader, WorkspaceTrust } from "@agent-qofeno/config";
import { SessionEngine } from "@agent-qofeno/session";
import { KnowledgeEngine, MemoryEngine } from "@agent-qofeno/knowledge";
import { ContextManager } from "@agent-qofeno/ctx";
import { ToolRegistry, registerBuiltins } from "@agent-qofeno/tools";
import {
  ProviderRegistry,
  OllamaProvider,
  OpenAiCompatibleProvider,
  OpenRouterProvider,
  GeminiProvider,
  createAnthropicProvider,
} from "@agent-qofeno/providers";
import type { LoadedConfig } from "@agent-qofeno/config";

export interface Bundle {
  paths: ReturnType<typeof qofenoPaths>;
  store: SqliteStorage;
  config: LoadedConfig;
  trust: WorkspaceTrust;
  sessions: SessionEngine;
  memory: MemoryEngine;
  knowledge: KnowledgeEngine;
  context: ContextManager;
  tools: ToolRegistry;
  providers: ProviderRegistry;
  capabilities: ReturnType<typeof detectCapabilities>;
}

export interface BundleOptions {
  projectRoot?: string;
  profile?: string;
  homeOverride?: string;
  modelOverride?: string;
}

export async function buildBundle(opts: BundleOptions = {}): Promise<Bundle> {
  const paths = qofenoPaths(opts.homeOverride ? { QOFENO_HOME: opts.homeOverride } : undefined);
  ensurePaths(paths);

  const config = new ConfigLoader({ rootDir: paths.config }, { projectRoot: opts.projectRoot, profile: opts.profile }).load();
  const merged = { ...config.merged };
  if (opts.modelOverride) merged.model = opts.modelOverride;

  const store = new SqliteStorage({ dataDir: paths.root });
  await store.init();

  const trust = new WorkspaceTrust(join(paths.config, "trust.json"));
  const sessions = new SessionEngine(store);
  const memory = new MemoryEngine(store);
  const knowledge = new KnowledgeEngine(store);
  const context = new ContextManager(merged.contextTokenBudget ?? 100_000);
  const tools = new ToolRegistry();
  registerBuiltins(tools);

  const providers = new ProviderRegistry();
  const secrets = detectSecretStore(paths.credentials);
  for (const p of merged.providers ?? []) {
    try {
      let provider: AiProvider | null = null;
      if (p.kind === "ollama") {
        provider = new OllamaProvider({ id: p.id, baseUrl: p.baseUrl });
      } else if (p.kind === "openai") {
        const key = p.credentialRef ? ((await secrets.get(p.credentialRef)) ?? undefined) : process.env.OPENAI_API_KEY;
        provider = new OpenAiCompatibleProvider({ id: p.id, baseUrl: p.baseUrl ?? "https://api.openai.com/v1", apiKey: key });
      } else if (p.kind === "openrouter") {
        const key = p.credentialRef ? ((await secrets.get(p.credentialRef)) ?? undefined) : process.env.OPENROUTER_API_KEY;
        provider = new OpenRouterProvider({ id: p.id, baseUrl: p.baseUrl, apiKey: key });
      } else if (p.kind === "gemini") {
        const key = p.credentialRef ? ((await secrets.get(p.credentialRef)) ?? undefined) : process.env.GEMINI_API_KEY;
        provider = new GeminiProvider({ id: p.id, baseUrl: p.baseUrl, apiKey: key });
      } else if (p.kind === "anthropic") {
        const key = p.credentialRef ? await secrets.get(p.credentialRef) : process.env.ANTHROPIC_API_KEY;
        if (key) provider = createAnthropicProvider({ id: p.id, apiKey: key });
      } else if (p.kind === "openai-compatible" || p.kind === "custom") {
        const key = p.credentialRef ? ((await secrets.get(p.credentialRef)) ?? undefined) : undefined;
        provider = new OpenAiCompatibleProvider({ id: p.id, baseUrl: p.baseUrl ?? "http://localhost:8000/v1", apiKey: key });
      }
      if (provider) providers.register(provider);
    } catch {
      /* a broken provider config must not prevent startup (#0294) */
    }
  }

  // Auto-detect environment API keys if provider is not explicitly listed in config
  if (!providers.get("openrouter") && process.env.OPENROUTER_API_KEY) {
    providers.register(new OpenRouterProvider({ id: "openrouter", apiKey: process.env.OPENROUTER_API_KEY }));
  }
  if (!providers.get("gemini") && process.env.GEMINI_API_KEY) {
    providers.register(new GeminiProvider({ id: "gemini", apiKey: process.env.GEMINI_API_KEY }));
  }
  if (!providers.get("anthropic") && process.env.ANTHROPIC_API_KEY) {
    providers.register(createAnthropicProvider({ id: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY }));
  }
  if (!providers.get("openai") && process.env.OPENAI_API_KEY) {
    providers.register(new OpenAiCompatibleProvider({ id: "openai", baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }));
  }

  // Default local provider is always attempted so local AI is first-class.
  if (!providers.get("ollama")) {
    providers.register(new OllamaProvider({ id: "ollama", baseUrl: "http://localhost:11434" }));
    void defaultOllamaGuard(providers);
  }

  // Wire semantic retrieval when any provider supports embeddings.
  const embedProvider = providers.list().find((p) => typeof p.embed === "function");
  if (embedProvider?.embed) {
    const fn = embedProvider.embed.bind(embedProvider);
    knowledge.setEmbedFunction(async (texts: string[]) => fn(texts));
  }

  return {
    paths,
    store,
    config,
    trust,
    sessions,
    memory,
    knowledge,
    context,
    tools,
    providers,
    capabilities: detectCapabilities(),
  };
}

async function defaultOllamaGuard(registry: ProviderRegistry): Promise<void> {
  void registry;
}
