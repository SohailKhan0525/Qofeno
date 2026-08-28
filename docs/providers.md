# Providers & Models

Qofeno is provider-neutral. Adapters implement a unified interface (`listModels`, `chat` streaming, optional `embed`, `health`); routing picks a target per request under strict privacy policies.

## Adding providers

```bash
qofeno setup                                          # hardware-scored local model pull wizard
qofeno provider add ollama http://localhost:11434     # local inference, no key needed
qofeno provider add openrouter                        # OpenRouter unified multi-model API
qofeno provider add gemini                            # Google Gemini (Gemini 2.0 Flash / Pro)
qofeno provider add anthropic                         # Anthropic Claude (Claude 3.5 Sonnet / Haiku / Opus)
qofeno provider add openai                            # OpenAI (GPT-4o, GPT-4o-mini)
qofeno provider add custom http://localhost:8000/v1   # Local/Self-hosted OpenAI-compatible server (vLLM, llama.cpp, LM Studio)
qofeno provider test                                  # discovery + live health check
```

Keys are stored in your OS credential store when available, else the AES-256-GCM vault. They never appear in logs, context, or output.

## Hardware-Aware Model Discovery & Recommendations

Run `qofeno models` to detect your machine's CPU cores, RAM, GPU/VRAM, and compute score. Qofeno matches your hardware against verified Hugging Face models (e.g. SmolLM2, Qwen2.5-Coder, Llama 3.2) and estimates memory footprint before downloading.

## Routing rules (deterministic)

1. Explicit model (`-m`, `/model`, config) wins **if** classification policy permits its destination.
2. Otherwise candidates are filtered by required capability and classification:
   - `local-only` content → local destinations only
   - `sensitive` → local or self-hosted only
   - `private`/`public` → any configured destination
3. Remaining candidates prefer local > self-hosted > external.
4. If the preferred model is unavailable and content is sensitive/local-only, routing **refuses** rather than silently switching providers.

Set `security.localOnly: true` to forbid external destinations entirely.
