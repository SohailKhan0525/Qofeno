/**
 * Hardened HTTP layer for provider calls: timeouts, bounded retries with
 * exponential backoff + jitter, and a per-host circuit breaker (#0174-#0176).
 */
import { RateLimiter } from "@agent-qofeno/security";
import { ErrorCode, QofenoError } from "@agent-qofeno/core";

export interface HttpResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export class CircuitOpenError extends QofenoError {
  constructor(host: string) {
    super({
      code: ErrorCode.PROVIDER_UNAVAILABLE,
      message: `circuit open for ${host}`,
      userMessage: `${host} is temporarily marked unavailable after repeated failures. Retry soon.`,
      retryable: true,
    });
  }
}

interface BreakerState {
  failures: number;
  openedAtMs?: number;
}

export class HttpClient {
  private breakers = new Map<string, BreakerState>();
  private limiters = new Map<string, RateLimiter>();

  constructor(
    private readonly defaults: {
      timeoutMs?: number;
      maxRetries?: number;
      breakerThreshold?: number;
      breakerCooldownMs?: number;
      requestsPerMinute?: number;
      userAgent?: string;
    } = {},
  ) {}

  private limiterFor(host: string): RateLimiter {
    let l = this.limiters.get(host);
    if (!l) {
      l = new RateLimiter(this.defaults.requestsPerMinute ?? 120, (this.defaults.requestsPerMinute ?? 120) / 60);
      this.limiters.set(host, l);
    }
    return l;
  }

  private breakerFor(host: string): BreakerState {
    let b = this.breakers.get(host);
    if (!b) {
      b = { failures: 0 };
      this.breakers.set(host, b);
    }
    return b;
  }

  private breakerCheck(host: string): void {
    const b = this.breakerFor(host);
    if (b.openedAtMs !== undefined) {
      const cooldown = this.defaults.breakerCooldownMs ?? 30_000;
      if (Date.now() - b.openedAtMs < cooldown) throw new CircuitOpenError(host);
      b.openedAtMs = undefined;
      b.failures = 0;
    }
  }

  private recordFailure(host: string): void {
    const b = this.breakerFor(host);
    b.failures++;
    if (b.failures >= (this.defaults.breakerThreshold ?? 5)) b.openedAtMs = Date.now();
  }

  async request(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      /** Retries apply only to idempotent verbs by default. */
      idempotent?: boolean;
    } = {},
  ): Promise<HttpResult> {
    const host = new URL(url).host;
    await this.limiterFor(host).consume();
    this.breakerCheck(host);

    const method = init.method ?? "GET";
    const canRetry = init.idempotent ?? method === "GET";
    const maxRetries = canRetry ? this.defaults.maxRetries ?? 2 : 0;
    const timeoutMs = init.timeoutMs ?? this.defaults.timeoutMs ?? 120_000;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(init.signal?.reason);
      if (init.signal) {
        if (init.signal.aborted) throw abortError();
        init.signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers: {
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            "User-Agent": this.defaults.userAgent ?? "qofeno/0.1 (+https://github.com/SohailKhan0525/qofeno)",
            ...init.headers,
          },
          body: init.body,
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.status >= 500 && canRetry) {
          lastError = new QofenoError({
            code: ErrorCode.PROVIDER_UNAVAILABLE,
            message: `provider ${res.status}`,
            retryable: true,
          });
          continue;
        }
        if (res.status >= 400) {
          // Client errors are not the host's fault; do not trip the breaker.
          throw new QofenoError({
            code: res.status === 401 || res.status === 403 ? ErrorCode.AUTH_FAILED : ErrorCode.PROVIDER_ERROR,
            message: `provider ${res.status}: ${text.slice(0, 300)}`,
            userMessage:
              res.status === 401 || res.status === 403
                ? "The provider rejected the credentials. Check the configured key."
                : "The provider rejected the request.",
            retryable: false,
          });
        }
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k] = v));
        this.breakerFor(host).failures = 0;
        return { status: res.status, body: text, headers };
      } catch (e) {
        lastError = e;
        if (init.signal?.aborted) throw abortError();
        if (!canRetry) break;
        // Backoff with jitter before next attempt.
        const base = Math.min(8000, 250 * 2 ** attempt);
        const jittered = base / 2 + Math.random() * (base / 2);
        await new Promise((r) => setTimeout(r, jittered));
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", onAbort);
      }
    }
    this.recordFailure(host);
    if (lastError instanceof QofenoError) throw lastError;
    throw new QofenoError({
      code: ErrorCode.PROVIDER_UNAVAILABLE,
      message: `request failed: ${String(lastError)}`,
      retryable: true,
      cause: lastError,
    });
  }

  /**
   * Streaming request yielding decoded chunks (lines) as they arrive.
   * Cancellation propagates immediately to the socket.
   */
  async *stream(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): AsyncGenerator<string> {
    const host = new URL(url).host;
    await this.limiterFor(host).consume();
    this.breakerCheck(host);
    const controller = new AbortController();
    if (init.signal) {
      if (init.signal.aborted) throw abortError();
      init.signal.addEventListener("abort", () => controller.abort(init.signal!.reason), { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error("timeout")), init.timeoutMs ?? this.defaults.timeoutMs ?? 300_000);
    try {
      const res = await fetch(url, {
        method: init.method ?? "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(init.headers ?? {}) },
        body: init.body,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new QofenoError({
          code: res.status === 401 || res.status === 403 ? ErrorCode.AUTH_FAILED : ErrorCode.PROVIDER_ERROR,
          message: `stream ${res.status}: ${text.slice(0, 300)}`,
          retryable: false,
        });
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          yield line;
        }
      }
      if (buffer.length > 0) yield buffer;
      this.breakerFor(host).failures = 0;
    } catch (e) {
      this.recordFailure(host);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

function abortError(): QofenoError {
  return new QofenoError({ code: ErrorCode.CANCELLED, message: "aborted by caller" });
}
