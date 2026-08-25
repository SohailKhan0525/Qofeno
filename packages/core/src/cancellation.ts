export class CancelledError extends Error {
  constructor(reason = "cancelled") {
    super(reason);
    this.name = "CancelledError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError(signal.reason ?? "cancelled");
}

/** Signal that aborts when the parent aborts or the timeout elapses. */
export function linkedSignal(
  signal: AbortSignal | undefined,
  timeoutMs?: number,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const abort = (reason: string) => {
    if (!controller.signal.aborted) controller.abort(new CancelledError(reason));
  };
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => abort("timeout"), timeoutMs);
    timer.unref?.();
  }
  if (signal) {
    if (signal.aborted) abort("parent cancelled");
    else signal.addEventListener("abort", () => abort("parent cancelled"), { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      abort("cancelled");
    },
  };
}
