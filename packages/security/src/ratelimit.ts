/**
 * Token-bucket rate limiter (#0150) used by provider calls, network fetches
 * and extension hosts. Independent instances per resource.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  tryConsume(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  async consume(n = 1): Promise<void> {
    for (;;) {
      if (this.tryConsume(n)) return;
      const deficit = n - this.tokens;
      const waitMs = Math.ceil((deficit / this.refillPerSecond) * 1000);
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 500)));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillMs) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefillMs = now;
  }
}
