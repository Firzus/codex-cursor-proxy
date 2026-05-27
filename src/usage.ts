import { getAuth, invalidateCache, type AuthClaims } from "./auth.ts";
import { safeResponseText, withTimeout } from "./http.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ORIGINATOR = "codex_cli_rs";
const VERSION = "0.150.0";
const USER_AGENT = `codex_cli_rs/${VERSION} (codex-cursor-proxy)`;
const USAGE_TIMEOUT_MS = 15_000;

export interface CodexUsageWindow {
  usedPercent: number | null;
  resetAt: number | null;
  resetAfterSeconds: number | null;
  limitWindowSeconds: number | null;
}

export interface CodexUsageCredits {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: string | number | null;
}

export interface CodexUsageSnapshot {
  source: "chatgpt-wham";
  fetchedAt: string;
  account: string;
  plan: string | null;
  allowed: boolean | null;
  limitReached: boolean | null;
  primaryWindow: CodexUsageWindow | null;
  secondaryWindow: CodexUsageWindow | null;
  credits: CodexUsageCredits | null;
}

export class UsageError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "UsageError";
  }
}

export async function fetchCodexUsage(): Promise<CodexUsageSnapshot> {
  const auth = await getAuth();
  return fetchCodexUsageWithAuth(auth, true);
}

async function fetchCodexUsageWithAuth(
  auth: AuthClaims,
  allowRefresh: boolean,
): Promise<CodexUsageSnapshot> {
  const t = withTimeout(USAGE_TIMEOUT_MS, "usage");
  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "Chatgpt-Account-Id": auth.chatgptAccountId,
        Originator: ORIGINATOR,
        Version: VERSION,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: t.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Codex usage request failed: ${msg}`);
  } finally {
    t.clear();
  }

  if (res.status === 401 && allowRefresh) {
    await res.body?.cancel().catch(() => {});
    invalidateCache();
    return fetchCodexUsageWithAuth(await getAuth(true), false);
  }

  if (!res.ok) {
    const detail = res.body
      ? await safeResponseText(res, { limit: 500, fallback: "<unreadable>" })
      : "<no body>";
    throw new UsageError(`Codex usage request failed (${res.status}): ${detail}`, res.status);
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Codex usage response was not valid JSON: ${msg}`, res.status);
  }

  return normalizeUsage(raw, auth);
}

function normalizeUsage(raw: unknown, auth: AuthClaims): CodexUsageSnapshot {
  const root = asRecord(raw);
  if (!root) {
    throw new UsageError("Codex usage response had an unexpected shape.");
  }

  const rateLimit = asRecord(root.rate_limit);
  const plan = optionalString(root.plan_type) ?? auth.planType;

  return {
    source: "chatgpt-wham",
    fetchedAt: new Date().toISOString(),
    account: auth.email ?? auth.chatgptAccountId,
    plan,
    allowed: rateLimit ? optionalBoolean(rateLimit.allowed) : null,
    limitReached: rateLimit ? optionalBoolean(rateLimit.limit_reached) : null,
    primaryWindow: rateLimit ? normalizeWindow(rateLimit.primary_window) : null,
    secondaryWindow: rateLimit ? normalizeWindow(rateLimit.secondary_window) : null,
    credits: normalizeCredits(root.credits),
  };
}

function normalizeWindow(raw: unknown): CodexUsageWindow | null {
  const window = asRecord(raw);
  if (!window) return null;
  return {
    usedPercent: optionalNumber(window.used_percent),
    resetAt: optionalNumber(window.reset_at),
    resetAfterSeconds: optionalNumber(window.reset_after_seconds),
    limitWindowSeconds: optionalNumber(window.limit_window_seconds),
  };
}

function normalizeCredits(raw: unknown): CodexUsageCredits | null {
  const credits = asRecord(raw);
  if (!credits) return null;
  return {
    hasCredits: optionalBoolean(credits.has_credits),
    unlimited: optionalBoolean(credits.unlimited),
    balance: optionalString(credits.balance) ?? optionalNumber(credits.balance),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
