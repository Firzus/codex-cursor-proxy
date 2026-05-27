type ShutdownHandler = () => Promise<void> | void;

const handlers: ShutdownHandler[] = [];

export function onShutdown(handler: ShutdownHandler): void {
  handlers.unshift(handler);
}

export async function runShutdownHandlers(): Promise<void> {
  while (handlers.length > 0) {
    const handler = handlers.shift();
    if (!handler) continue;
    try {
      await handler();
    } catch {
      // best-effort
    }
  }
}
