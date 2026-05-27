export async function safeResponseText(
  res: Response,
  options: { limit: number; fallback: string },
): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, options.limit);
  } catch {
    return options.fallback;
  }
}

export interface TimeoutHandle {
  readonly signal: AbortSignal;
  readonly controller: AbortController;
  clear(): void;
  abort(reason?: unknown): void;
}

export function withTimeout(timeoutMs: number, label: string): TimeoutHandle {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  let cleared = false;
  return {
    controller,
    signal: controller.signal,
    clear() {
      if (cleared) return;
      cleared = true;
      clearTimeout(timer);
    },
    abort(reason?: unknown) {
      if (cleared) controller.abort(reason);
      else {
        cleared = true;
        clearTimeout(timer);
        controller.abort(reason);
      }
    },
  };
}
