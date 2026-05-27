import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { safeResponseText, withTimeout } from "./http.ts";
import { AUTH_FILE } from "./paths.ts";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access";
const REFRESH_MARGIN_MS = 60_000;
const REFRESH_TIMEOUT_MS = 15_000;

export interface AuthFile {
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id?: string;
  };
  last_refresh?: string;
}

export interface AuthClaims {
  accessToken: string;
  chatgptAccountId: string;
  email: string | null;
  planType: string | null;
  expiresAt: number;
}

export class AuthError extends Error {
  constructor(message: string, public readonly code: "missing" | "malformed" | "refresh_failed") {
    super(message);
    this.name = "AuthError";
  }
}

interface Inflight {
  promise: Promise<AuthClaims>;
  isRefreshing: boolean;
}

let cached: AuthClaims | null = null;
let inflight: Inflight | null = null;

export async function getAuth(forceRefresh = false): Promise<AuthClaims> {
  if (!forceRefresh && cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cached;
  }
  // Reuse the inflight only if it can satisfy our request. A non-refreshing
  // inflight (one that may return the same on-disk token we already know is
  // bad) cannot satisfy a forceRefresh caller — otherwise the 401-retry path
  // would loop forever on the same dead token.
  if (inflight && (!forceRefresh || inflight.isRefreshing)) {
    return inflight.promise;
  }

  const promise = doAuthFetch(forceRefresh);
  inflight = { promise, isRefreshing: forceRefresh };
  void promise.catch(() => {}).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  return promise;
}

async function doAuthFetch(forceRefresh: boolean): Promise<AuthClaims> {
  const file = await loadFile();
  const fromDisk = parseAuth(file);
  if (!forceRefresh && fromDisk.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    cached = fromDisk;
    return fromDisk;
  }
  const refreshed = await refresh(file);
  cached = refreshed;
  return refreshed;
}

export function invalidateCache(): void {
  cached = null;
}

export function authFilePath(): string {
  return AUTH_FILE;
}

async function loadFile(): Promise<AuthFile> {
  let raw: string;
  try {
    raw = await readFile(AUTH_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AuthError(`Codex credentials not found at ${AUTH_FILE}`, "missing");
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as AuthFile;
  } catch {
    throw new AuthError(`Malformed auth file at ${AUTH_FILE}`, "malformed");
  }
}

function parseAuth(file: AuthFile): AuthClaims {
  const tokens = file.tokens;
  if (!tokens?.access_token || !tokens.refresh_token || !tokens.id_token) {
    throw new AuthError("auth.json missing required tokens", "malformed");
  }
  const access = decodeJwt(tokens.access_token);
  const id = decodeJwt(tokens.id_token);
  const authBlock = (id["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const chatgptAccountId =
    (authBlock.chatgpt_account_id as string | undefined) ?? tokens.account_id ?? "";
  if (!chatgptAccountId) {
    throw new AuthError("Could not derive chatgpt_account_id from id_token", "malformed");
  }
  const exp = typeof access.exp === "number" ? access.exp * 1000 : 0;
  return {
    accessToken: tokens.access_token,
    chatgptAccountId,
    email: (id.email as string | undefined) ?? null,
    planType: (authBlock.chatgpt_plan_type as string | undefined) ?? null,
    expiresAt: exp,
  };
}

async function refresh(current: AuthFile): Promise<AuthClaims> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.tokens.refresh_token,
    client_id: CLIENT_ID,
    scope: SCOPE,
  });

  const t = withTimeout(REFRESH_TIMEOUT_MS, "token refresh");
  let payload: { access_token?: string; id_token?: string; refresh_token?: string };
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: t.signal,
    });
    if (!res.ok) {
      const detail = await safeResponseText(res, { limit: 200, fallback: "<no body>" });
      throw new AuthError(`Token refresh failed (${res.status}): ${detail}`, "refresh_failed");
    }
    payload = (await res.json()) as {
      access_token?: string;
      id_token?: string;
      refresh_token?: string;
    };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new AuthError(`Token refresh failed: ${msg}`, "refresh_failed");
  } finally {
    t.clear();
  }

  if (!payload.access_token || !payload.id_token) {
    throw new AuthError("Token refresh response missing access_token or id_token", "refresh_failed");
  }

  const next: AuthFile = {
    ...current,
    tokens: {
      ...current.tokens,
      access_token: payload.access_token,
      id_token: payload.id_token,
      refresh_token: payload.refresh_token ?? current.tokens.refresh_token,
    },
    last_refresh: new Date().toISOString(),
  };

  await persist(next);
  return parseAuth(next);
}

async function persist(file: AuthFile): Promise<void> {
  await mkdir(dirname(AUTH_FILE), { recursive: true });
  // Atomic write: stage to a sibling temp file, then rename. On Windows and
  // POSIX a same-directory rename is atomic, so a crash mid-write leaves the
  // previous valid auth.json intact instead of a truncated file.
  const tmp = `${AUTH_FILE}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, AUTH_FILE);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) {
    throw new AuthError("Invalid JWT shape", "malformed");
  }
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
  const json = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}
