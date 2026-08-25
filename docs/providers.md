# Providers & Models

Qofeno is provider-neutral. Adapters implement a small interface (models, chat streaming, optional embeddings, health); routing picks a target per request under privacy rules.

## Adding providers

```bash
qofeno provider add ollama http://localhost:11434     # local, no key needed
qofeno provider add openai                            # prompts for key → OS credential store
qofeno provider add anthropic                         # uses ANTHROPIC_API_KEY if present
qofeno provider test                                  # discovery + health check
```

Keys are stored in your OS credential store when available, else the AES-256-GCM vault. They never appear in logs, context or output.

Any OpenAI-compatible server works with `add openai <baseUrl>`: vLLM, LM Studio, llama.cpp's server, Groq, Together, OpenRouter, Gemini's compatibility endpoint.

## Routing rules (deterministic)

1. Explicit model (`-m`, `/model`, config) wins **if** classification policy permits its destination.
2. Otherwise candidates are filtered by required capability and classification:
   - `local-only` content → local destinations only
   - `sensitive` → local or self-hosted only
   - `private`/`public` → any configured destination
3. Remaining candidates prefer local > self-hosted > external.
4. If the preferred model is unavailable and content is sensitive/local-only, routing **refuses** rather than silently switching providers.

Set `security.localOnly: true` to forbid external destinations entirely.

## Model downloads

Qofeno never pulls models on its own. Use your inference engine's tooling (`ollama pull …`) so size, license and disk choices remain yours.
