/**
 * OpenAI Chat Completions <-> OpenAI Responses API translation.
 * The upstream (chatgpt.com codex backend) speaks Responses; Cursor speaks Chat.
 */

const EFFORT_SUFFIX_RE = /^(.+?)-(low|medium|high|extra)$/;
const EFFORT_MAP: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  extra: "xhigh",
};

export function splitModelEffort(id: string): { model: string; effort: string | null } {
  const m = id.match(EFFORT_SUFFIX_RE);
  if (!m) return { model: id, effort: null };
  const model = m[1] ?? id;
  const suffix = m[2];
  return { model, effort: suffix ? EFFORT_MAP[suffix] ?? null : null };
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export function mapUsage(raw: unknown): ChatUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: u.total_tokens ?? input + output,
  };
}

export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | Array<{ type: string; text?: string }> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning_effort?: string;
  service_tier?: string;
}

export interface ResponsesRequest {
  model: string;
  input: Array<Record<string, unknown>>;
  instructions?: string;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  reasoning?: { effort: string };
  include?: unknown[];
  parallel_tool_calls?: boolean;
  service_tier?: string;
  [k: string]: unknown;
}

export function isResponsesRequest(body: unknown): body is ResponsesRequest {
  return !!body && typeof body === "object" && Array.isArray((body as { input?: unknown }).input);
}

export function isChatRequest(body: unknown): body is ChatRequest {
  return !!body && typeof body === "object" && Array.isArray((body as { messages?: unknown }).messages);
}

export function passthroughResponsesBody(req: ResponsesRequest): UpstreamBody {
  const instructionsParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const item of req.input) {
    const role = (item as { role?: string }).role;
    if (role === "system" || role === "developer") {
      const text = extractText((item as { content?: unknown }).content);
      if (text) instructionsParts.push(text);
      continue;
    }
    input.push(item);
  }

  const split = splitModelEffort(req.model);
  const body = baseUpstreamBody(req, input, split, req.instructions ?? defaultInstructions(instructionsParts));
  if (typeof req.max_output_tokens === "number") body.max_output_tokens = req.max_output_tokens;
  if (req.reasoning) body.reasoning = req.reasoning;
  else if (split.effort) body.reasoning = { effort: split.effort };
  if (req.include !== undefined) body.include = req.include;
  if (req.parallel_tool_calls !== undefined) body.parallel_tool_calls = req.parallel_tool_calls;
  if (req.service_tier) body.service_tier = req.service_tier;
  return body;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p || typeof p !== "object") return "";
        const text = (p as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

export interface UpstreamBody {
  model: string;
  instructions: string;
  input: Array<Record<string, unknown>>;
  stream: true;
  store: false;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  reasoning?: { effort: string };
  include?: unknown[];
  parallel_tool_calls?: boolean;
  service_tier?: string;
}

export function buildUpstreamBody(req: ChatRequest): UpstreamBody {
  const instructionsParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const msg of req.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = stringifyContent(msg.content);
      if (text) instructionsParts.push(text);
      continue;
    }
    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output: stringifyContent(msg.content) ?? "",
      });
      continue;
    }
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      const text = stringifyContent(msg.content);
      if (text) {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      continue;
    }
    const text = stringifyContent(msg.content) ?? "";
    input.push({
      role: msg.role,
      content: [
        {
          type: msg.role === "assistant" ? "output_text" : "input_text",
          text,
        },
      ],
    });
  }

  const split = splitModelEffort(req.model);
  const body = baseUpstreamBody(req, input, split, defaultInstructions(instructionsParts));
  const maxOut = req.max_completion_tokens ?? req.max_tokens;
  if (typeof maxOut === "number") body.max_output_tokens = maxOut;
  if (req.reasoning_effort) body.reasoning = { effort: req.reasoning_effort };
  else if (split.effort) body.reasoning = { effort: split.effort };
  if (req.service_tier) body.service_tier = req.service_tier;
  return body;
}

function defaultInstructions(parts: string[]): string {
  return parts.length ? parts.join("\n\n") : "You are a helpful coding assistant.";
}

function baseUpstreamBody(
  req: Pick<ResponsesRequest, "tools" | "tool_choice" | "temperature" | "top_p">,
  input: Array<Record<string, unknown>>,
  split: { model: string },
  instructions: string,
): UpstreamBody {
  const body: UpstreamBody = {
    model: split.model,
    input,
    stream: true,
    store: false,
    instructions,
  };
  if (req.tools) body.tools = req.tools;
  if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (typeof req.top_p === "number") body.top_p = req.top_p;
  return body;
}

function stringifyContent(content: ChatMessage["content"]): string | null {
  if (content == null) return null;
  if (typeof content === "string") return content;
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("");
}

interface ToolCallState {
  index: number;
  id: string;
  name: string;
}

interface StreamState {
  id: string;
  model: string;
  created: number;
  roleEmitted: boolean;
  toolCalls: Map<string, ToolCallState>;
  finishReason: string | null;
}

export function chatStreamFromResponses(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  abortUpstream: (reason?: unknown) => void,
): ReadableStream<Uint8Array> {
  const state: StreamState = {
    id: `chatcmpl-${cryptoRandom()}`,
    model,
    created: Math.floor(Date.now() / 1000),
    roleEmitted: false,
    toolCalls: new Map(),
    finishReason: null,
  };
  const encoder = new TextEncoder();
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;

  const clearKeepalive = (): void => {
    if (keepaliveTimer !== null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  };

  return new ReadableStream({
    async start(controller) {
      const KEEPALIVE_INTERVAL_MS = 5_000;
      let lastEmit = Date.now();
      const safeEnqueue = (bytes: Uint8Array): void => {
        try {
          controller.enqueue(bytes);
          lastEmit = Date.now();
        } catch {
          // controller closed
        }
      };
      keepaliveTimer = setInterval(() => {
        if (Date.now() - lastEmit >= KEEPALIVE_INTERVAL_MS) {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
            lastEmit = Date.now();
          } catch {
            // controller closed
          }
        }
      }, KEEPALIVE_INTERVAL_MS);

      try {
        let finalUsage: ChatUsage | null = null;
        for await (const event of parseSSE(upstream)) {
          if (cancelled) break;
          const chunks = translateEvent(event, state);
          for (const chunk of chunks) {
            safeEnqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          if (event.event === "response.completed") {
            finalUsage = mapUsage((event.data as { response?: { usage?: unknown } }).response?.usage);
          }
        }
        if (!cancelled) {
          if (finalUsage) {
            const usageChunk = {
              id: state.id,
              object: "chat.completion.chunk",
              created: state.created,
              model: state.model,
              choices: [],
              usage: finalUsage,
            };
            safeEnqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
          }
          safeEnqueue(encoder.encode("data: [DONE]\n\n"));
        }
        clearKeepalive();
        try {
          controller.close();
        } catch {
          // already cancelled
        }
      } catch (err) {
        clearKeepalive();
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        // Keep strict Chat Completions clients on the standard chunk shape.
        try {
          if (!state.roleEmitted) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(baseChunk(state, { role: "assistant" }))}\n\n`),
            );
            state.roleEmitted = true;
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify(baseChunk(state, { content: `\n\n[proxy] upstream error: ${message}` }))}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(baseChunk(state, {}, "stop"))}\n\n`),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          // already cancelled — nothing to deliver
        }
      }
    },
    cancel(reason) {
      cancelled = true;
      clearKeepalive();
      try {
        abortUpstream(reason);
      } catch {
        // ignore
      }
    },
  });
}

export async function chatCompletionFromResponses(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  abortUpstream: (reason?: unknown) => void,
): Promise<Record<string, unknown>> {
  const state: StreamState = {
    id: `chatcmpl-${cryptoRandom()}`,
    model,
    created: Math.floor(Date.now() / 1000),
    roleEmitted: false,
    toolCalls: new Map(),
    finishReason: null,
  };

  let content = "";
  let reasoning = "";
  const toolCallsBuffer = new Map<string, { id: string; name: string; arguments: string }>();
  let usage: Record<string, unknown> | undefined;

  try {
    for await (const event of parseSSE(upstream)) {
      for (const chunk of translateEvent(event, state)) {
        const choice = (chunk as { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }> }).choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string") content += delta.content;
        if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
        const toolCalls = delta.tool_calls as
          | Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
          | undefined;
        if (toolCalls) {
          for (const tc of toolCalls) {
            const key = String(tc.index);
            const existing = toolCallsBuffer.get(key) ?? { id: tc.id ?? "", name: "", arguments: "" };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            toolCallsBuffer.set(key, existing);
          }
        }
      }
      if (event.event === "response.completed") {
        const data = event.data as { response?: { usage?: Record<string, unknown> } };
        usage = data.response?.usage;
      }
    }
  } catch (err) {
    try {
      abortUpstream(err);
    } catch {
      // ignore
    }
    throw err;
  }

  const message: Record<string, unknown> = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCallsBuffer.size) {
    message.tool_calls = Array.from(toolCallsBuffer.values()).map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  return {
    id: state.id,
    object: "chat.completion",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: state.finishReason ?? "stop",
      },
    ],
    usage: mapUsage(usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function translateEvent(
  event: SSEEvent,
  state: StreamState,
): Array<Record<string, unknown>> {
  const chunks: Array<Record<string, unknown>> = [];
  const emit = (delta: Record<string, unknown>, finishReason: string | null = null): void => {
    if (!state.roleEmitted) {
      chunks.push(baseChunk(state, { role: "assistant" }));
      state.roleEmitted = true;
    }
    chunks.push(baseChunk(state, delta, finishReason));
  };

  switch (event.event) {
    case "response.output_text.delta": {
      const delta = (event.data as { delta?: string }).delta ?? "";
      if (delta) emit({ content: delta });
      break;
    }
    case "response.reasoning_text.delta":
    case "response.reasoning.delta":
    case "response.reasoning_summary_text.delta": {
      const delta = (event.data as { delta?: string }).delta ?? "";
      if (delta) emit({ reasoning_content: delta });
      break;
    }
    case "response.output_item.added": {
      const item = (event.data as { item?: { type?: string; id?: string; call_id?: string; name?: string } }).item;
      if (item?.type === "function_call" || item?.type === "custom_tool_call") {
        const callId = item.call_id ?? item.id ?? `call_${cryptoRandom()}`;
        const index = state.toolCalls.size;
        const tc = { index, id: callId, name: item.name ?? "" };
        state.toolCalls.set(callId, tc);
        if (item.id && item.id !== callId) state.toolCalls.set(item.id, tc);
        emit({
          tool_calls: [
            {
              index,
              id: callId,
              type: "function",
              function: { name: item.name ?? "", arguments: "" },
            },
          ],
        });
      }
      break;
    }
    case "response.function_call_arguments.delta":
    case "response.custom_tool_call_input.delta": {
      const data = event.data as { delta?: string; item_id?: string; call_id?: string };
      const key = data.call_id ?? data.item_id ?? "";
      const tc = key ? state.toolCalls.get(key) : undefined;
      const target = tc ?? Array.from(state.toolCalls.values()).at(-1);
      if (!target || !data.delta) break;
      emit({
        tool_calls: [
          {
            index: target.index,
            function: { arguments: data.delta },
          },
        ],
      });
      break;
    }
    case "response.completed": {
      const data = event.data as { response?: { status?: string; incomplete_details?: { reason?: string } } };
      const status = data.response?.status;
      const reason = data.response?.incomplete_details?.reason;
      if (status === "incomplete" || reason === "max_output_tokens") {
        state.finishReason = "length";
      } else if (state.toolCalls.size) {
        state.finishReason = "tool_calls";
      } else {
        state.finishReason = "stop";
      }
      emit({}, state.finishReason);
      break;
    }
    case "response.failed":
    case "error": {
      const data = event.data as { error?: { message?: string }; message?: string };
      const msg = data.error?.message ?? data.message ?? "upstream error";
      throw new Error(msg);
    }
    default:
      break;
  }
  return chunks;
}

function baseChunk(
  state: StreamState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

export interface SSEEvent {
  event: string;
  data: unknown;
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = findEventBoundary(buffer);
        if (!boundary) break;
        const raw = buffer.slice(0, boundary.end);
        buffer = buffer.slice(boundary.end + boundary.sepLen);
        const event = parseBlock(raw);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseBlock(buffer);
      if (event) yield event;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function findEventBoundary(buffer: string): { end: number; sepLen: number } | null {
  let best: { end: number; sepLen: number } | null = null;
  for (const sep of ["\r\n\r\n", "\n\n", "\r\r"]) {
    const idx = buffer.indexOf(sep);
    if (idx === -1) continue;
    if (best === null || idx < best.end) best = { end: idx, sepLen: sep.length };
  }
  return best;
}

function parseBlock(block: string): SSEEvent | null {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return null;
  const dataStr = dataLines.join("\n");
  if (dataStr === "[DONE]") return null;
  try {
    return { event: eventName, data: JSON.parse(dataStr) };
  } catch {
    return { event: eventName, data: dataStr };
  }
}

function cryptoRandom(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}
