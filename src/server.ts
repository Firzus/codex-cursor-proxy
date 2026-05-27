import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AuthError, authFilePath, getAuth } from "./auth.ts";
import { PORT } from "./config.ts";
import { DEBUG_FILE } from "./paths.ts";
import { onShutdown } from "./shutdown.ts";
import { openTunnel } from "./tunnel.ts";
import { log, printBanner, printFatal, printMissingAuth } from "./ui.ts";
import {
  buildUpstreamBody,
  chatCompletionFromResponses,
  chatStreamFromResponses,
  isChatRequest,
  isResponsesRequest,
  passthroughResponsesBody,
  splitModelEffort,
  type ChatRequest,
  type ResponsesRequest,
  type UpstreamBody,
} from "./translate.ts";
import { UpstreamError, callUpstream } from "./upstream.ts";
export { PORT };

const KNOWN_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
];
const EXTRA_MODELS = (process.env.CODEX_MODELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const SUPPORTED_MODELS = Array.from(new Set([...KNOWN_MODELS, ...EXTRA_MODELS]));

const DEBUG = process.env.CODEX_DEBUG === "1";
let debugDirReady = false;
async function debugDump(direction: "in" | "out" | "sse", pathname: string, body: unknown): Promise<void> {
  if (!DEBUG) return;
  if (!debugDirReady) {
    try {
      await mkdir(dirname(DEBUG_FILE), { recursive: true });
    } catch {
      // ignore
    }
    debugDirReady = true;
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    direction,
    pathname,
    body,
  }) + "\n";
  try {
    await appendFile(DEBUG_FILE, line, "utf8");
  } catch {
    // ignore
  }
}

function teeStream(source: ReadableStream<Uint8Array>, pathname: string): ReadableStream<Uint8Array> {
  if (!DEBUG) return source;
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  // pipeThrough propagates cancellation from the downstream consumer back to
  // `source` automatically (the writable side errors → the pipe aborts →
  // source.cancel is invoked). That's how the upstream semaphore slot gets
  // released when a client disconnects mid-stream.
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      chunks.push(decoder.decode(chunk, { stream: true }));
    },
    flush() {
      void debugDump("sse", pathname, chunks.join("") + decoder.decode());
    },
  });
  return source.pipeThrough(transform);
}

export async function runServer(): Promise<void> {
  let auth;
  try {
    auth = await getAuth();
  } catch (err) {
    if (err instanceof AuthError && err.code === "missing") {
      printMissingAuth(authFilePath());
      process.exit(1);
    }
    printFatal(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: handleRequest,
  });
  onShutdown(async () => {
    await server.stop();
  });

  let tunnelUrl: string;
  try {
    const tunnel = await openTunnel(PORT);
    onShutdown(() => tunnel.close());
    tunnelUrl = tunnel.url;
  } catch (err) {
    printFatal(`Failed to open tunnel: ${err instanceof Error ? err.message : String(err)}`);
    await server.stop();
    process.exit(1);
  }

  printBanner({
    account: auth.email ?? auth.chatgptAccountId,
    plan: auth.planType,
    localUrl: `http://127.0.0.1:${PORT}`,
    tunnelUrl,
    models: SUPPORTED_MODELS,
  });
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const cors = corsHeaders();

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (url.pathname === "/health" || url.pathname === "/") {
    return Response.json({ status: "ok" }, { headers: cors });
  }

  if (url.pathname === "/v1/models" && req.method === "GET") {
    return Response.json(
      {
        object: "list",
        data: SUPPORTED_MODELS.map((id) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "codex-cursor-proxy",
        })),
      },
      { headers: cors },
    );
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses")
  ) {
    return handleChatCompletions(req, cors, url.pathname);
  }

  log.warn(`404 ${req.method} ${url.pathname}`);
  return Response.json({ error: { message: "Not found", type: "not_found" } }, { status: 404, headers: cors });
}

async function handleChatCompletions(
  req: Request,
  cors: Record<string, string>,
  pathname: string,
): Promise<Response> {
  const started = Date.now();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, "Invalid JSON body", cors);
  }

  const modelRaw = (raw as { model?: unknown })?.model;
  if (typeof modelRaw !== "string" || modelRaw.length === 0) {
    log.warn(`400 ${pathname} invalid model in body`);
    return errorResponse(400, "Missing or invalid required field: model (must be a non-empty string)", cors);
  }
  const model = modelRaw;

  await debugDump("in", pathname, raw);

  const split = splitModelEffort(model);
  if (!SUPPORTED_MODELS.includes(split.model)) {
    log.warn(`400 ${pathname} unknown model "${model}"`);
    return errorResponse(
      400,
      `Unknown model "${model}". Known: ${SUPPORTED_MODELS.join(", ")}. Add custom ids with CODEX_MODELS env var.`,
      cors,
    );
  }

  let upstreamBody: UpstreamBody;
  let format: "chat" | "responses";
  if (pathname === "/v1/responses" || isResponsesRequest(raw)) {
    format = "responses";
    if (!isResponsesRequest(raw)) {
      log.warn(`400 ${pathname} responses path without input array`);
      return errorResponse(400, "Missing required field: input", cors);
    }
    upstreamBody = passthroughResponsesBody(raw as ResponsesRequest);
  } else if (isChatRequest(raw)) {
    format = "chat";
    upstreamBody = buildUpstreamBody(raw as ChatRequest);
  } else {
    log.warn(`400 ${pathname} no messages/input`);
    return errorResponse(400, "Missing required field: messages or input", cors);
  }

  const isStream = (raw as { stream?: boolean }).stream === true;
  const cacheKey = (raw as { prompt_cache_key?: string }).prompt_cache_key;
  await debugDump("out", pathname, upstreamBody);

  try {
    const upstreamRaw = await callUpstream(upstreamBody, cacheKey);
    const upstream = {
      stream: teeStream(upstreamRaw.stream, pathname),
      abort: upstreamRaw.abort,
    };
    // Response format follows the ENDPOINT, not the request body format:
    //   /v1/responses          -> passthrough upstream SSE (Responses shape)
    //   /v1/chat/completions   -> translate to Chat Completions (chunks if stream, single object otherwise)
    const tags = requestTags(upstreamBody);
    if (pathname === "/v1/responses") {
      log.ok(`/v1/responses ${model} (${msElapsed(started)})${isStream ? " stream" : ""}${tags}`);
      return new Response(upstream.stream, { status: 200, headers: sseHeaders(cors) });
    }
    if (isStream) {
      const stream = teeStream(
        chatStreamFromResponses(upstream.stream, model, upstream.abort),
        "/v1/chat/completions:downstream",
      );
      log.ok(`/v1/chat/completions ${model} (${msElapsed(started)}) stream${format === "responses" ? " (input)" : ""}${tags}`);
      return new Response(stream, { status: 200, headers: sseHeaders(cors) });
    }
    const completion = await chatCompletionFromResponses(upstream.stream, model, upstream.abort);
    log.ok(`/v1/chat/completions ${model} (${msElapsed(started)})${format === "responses" ? " (input)" : ""}${tags}`);
    return Response.json(completion, { headers: cors });
  } catch (err) {
    if (err instanceof UpstreamError) {
      log.err(`upstream ${err.status} (${msElapsed(started)})`);
      // Don't relay upstream 401/403/429 verbatim — OpenAI clients (Cursor)
      // would treat those as their own API-key / quota errors. Surface them
      // as a generic 502 with the upstream detail in the message instead.
      const status = err.status >= 500 || err.status === 0 ? 502 : err.status === 401 || err.status === 403 || err.status === 429 ? 502 : err.status;
      return errorResponse(status, err.message, cors);
    }
    const message = err instanceof Error ? err.message : String(err);
    log.err(`proxy error: ${message}`);
    return errorResponse(500, message, cors);
  }
}

function requestTags(body: UpstreamBody): string {
  const effort = body.reasoning?.effort ?? "default";
  const fast = body.service_tier === "priority" ? "yes" : "no";
  return ` effort=${effort} fast=${fast}`;
}

function errorResponse(status: number, message: string, cors: Record<string, string>): Response {
  return Response.json(
    { error: { message, type: "proxy_error", code: status } },
    { status, headers: cors },
  );
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function sseHeaders(cors: Record<string, string>): Record<string, string> {
  return {
    ...cors,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    // Tells proxies (nginx, localtunnel, cloudflared) to NOT buffer the response.
    // Without this, intermediaries can hold chunks until they fill an internal
    // buffer, causing clients to time out waiting for the first byte.
    "X-Accel-Buffering": "no",
  };
}

function msElapsed(start: number): string {
  const ms = Date.now() - start;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
