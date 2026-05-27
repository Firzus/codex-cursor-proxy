import { ulid } from "ulid";
import { getAuth, invalidateCache } from "./auth.ts";
import { parsePositiveIntEnv } from "./config.ts";
import { safeResponseText, withTimeout } from "./http.ts";
import type { UpstreamBody } from "./translate.ts";

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const ORIGINATOR = "codex_cli_rs";
const VERSION = "0.150.0";
const USER_AGENT = `codex_cli_rs/${VERSION} (codex-cursor-proxy)`;

// Cap at 10 in-flight requests by default to stay friendly to the ChatGPT
// Plus/Pro account quota while leaving plenty of room for Cursor
// multi-subagent workflows. Lower it (CODEX_MAX_CONCURRENCY=2) if you hit
// account-side rate limits.
const MAX_CONCURRENCY = parsePositiveIntEnv("CODEX_MAX_CONCURRENCY", 10);
const RETRY_MAX = 3;
const HEADERS_TIMEOUT_MS = 60_000;

export interface UpstreamResponse {
  stream: ReadableStream<Uint8Array>;
  abort(reason?: unknown): void;
}

export class UpstreamError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENCY) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  // release() handed the slot directly to us without decrementing inFlight,
  // so we must NOT increment here — otherwise a fast-path acquire that ran
  // between release()'s next() and our wake-up would push inFlight above
  // MAX_CONCURRENCY.
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  inFlight--;
}

interface UpstreamRaw {
  stream: ReadableStream<Uint8Array>;
  abort: (reason?: unknown) => void;
}

export async function callUpstream(
  body: UpstreamBody,
  cacheKey?: string,
): Promise<UpstreamResponse> {
  const sessionId = cacheKey ?? ulid().toLowerCase();
  await acquire();
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    release();
  };
  try {
    const raw = await performRequestWithRetry(body, sessionId);
    return {
      stream: wrapReleaseStream(raw.stream, releaseOnce, raw.abort),
      abort: raw.abort,
    };
  } catch (err) {
    releaseOnce();
    throw err;
  }
}

function wrapReleaseStream(
  source: ReadableStream<Uint8Array>,
  release: () => void,
  abortUpstream: (reason?: unknown) => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        try {
          controller.close();
        } catch {
          // already closed by a cancel
        }
      } catch (err) {
        try {
          controller.error(err);
        } catch {
          // already closed
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
        release();
      }
    },
    cancel(reason) {
      // The source is locked by the reader started above, so source.cancel()
      // would reject. Abort the underlying fetch instead — that surfaces in
      // the reader.read() loop as a rejection, which routes through the
      // catch/finally and releases the semaphore slot exactly once.
      try {
        abortUpstream(reason);
      } catch {
        // ignore
      }
    },
  });
}

async function performRequestWithRetry(
  body: UpstreamBody,
  sessionId: string,
  attempt = 0,
): Promise<UpstreamRaw> {
  try {
    return await performRequest(body, sessionId, true);
  } catch (err) {
    if (
      err instanceof UpstreamError &&
      (err.status === 429 || err.status === 503) &&
      attempt < RETRY_MAX
    ) {
      const delay = 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
      return performRequestWithRetry(body, sessionId, attempt + 1);
    }
    throw err;
  }
}

async function performRequest(
  body: UpstreamBody,
  sessionId: string,
  allowRetry: boolean,
): Promise<UpstreamRaw> {
  const auth = await getAuth();
  const t = withTimeout(HEADERS_TIMEOUT_MS, "upstream headers");
  let res: Response;
  try {
    res = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "Chatgpt-Account-Id": auth.chatgptAccountId,
        Originator: ORIGINATOR,
        Version: VERSION,
        Session_id: sessionId,
        Conversation_id: sessionId,
        "User-Agent": USER_AGENT,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: t.signal,
    });
  } catch (err) {
    t.clear();
    const msg = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`Upstream fetch failed: ${msg}`, 0, msg);
  }
  // The headers are in; clear the timer but keep the AbortController so the
  // body stream can still be aborted on client disconnect via t.abort().
  t.clear();

  if (res.status === 401 && allowRetry) {
    // Drain the 401 body so the underlying connection isn't held open.
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }
    invalidateCache();
    await getAuth(true);
    return performRequest(body, sessionId, false);
  }

  if (!res.ok || !res.body) {
    const text = res.body
      ? await safeResponseText(res, { limit: 500, fallback: "<unreadable>" })
      : "<no body>";
    throw new UpstreamError(`Upstream ${res.status}: ${text}`, res.status, text);
  }

  return {
    stream: res.body,
    abort: (reason?: unknown) => t.abort(reason),
  };
}
