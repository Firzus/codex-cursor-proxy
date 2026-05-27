# AGENTS.md

## Overview & Scope
`codex-cursor-proxy` is a Bun/TypeScript CLI that exposes ChatGPT Plus/Pro Codex as an OpenAI-compatible endpoint for Cursor, with local HTTP routes, Chat/Responses translation, Cloudflare tunnel support, and Windows scheduled-task service helpers. Applies to the entire repo unless a nested `AGENTS.md` says otherwise; closest `AGENTS.md` to the edited file wins.

## Agent Role
- Act as an experienced TypeScript/Bun backend engineer maintaining a small CLI/proxy.
- Allowed: edit `src/**/*.ts`, root config/docs, and focused tests/config if added later.
- Must preserve OpenAI-compatible API behavior for `/health`, `/v1/models`, `/v1/chat/completions`, and `/v1/responses`.
- Must not read, print, commit, or modify real credentials in `~/.codex/auth.json`, `.env`, `.env.local`, or generated service files under `~/.codex/cursor-proxy`.
- Must not set up/tear down Windows scheduled tasks, start long-running tunnels, or launch the proxy unless explicitly requested.

## Build, Test & Validation Commands

```bash
bun --version
```

```bash
bun run typecheck
```

```bash
bun run src/index.ts help
```

```bash
bun run src/index.ts usage  # (verified only when explicitly requested; calls ChatGPT/Codex usage endpoint)
```

```bash
bun run src/index.ts start  # (unverified; starts local server and Cloudflare tunnel)
```

```bash
bun --watch run src/index.ts  # (unverified; long-running dev watcher)
```

```bash
bun run src/index.ts up  # (unverified; Windows scheduled-task side effects)
bun run src/index.ts down  # (unverified; Windows scheduled-task side effects)
```

- The service `up` command is not listed as verified because dependency setup is not run during agent setup; use the Bun lockfile already present.
- No test, lint, format, or build scripts are defined in `package.json`.

## Conventions & Patterns
- Runtime: Bun, ESM TypeScript, strict `tsconfig.json`, `moduleResolution: "bundler"`, `.ts` import extensions.
- Source layout: all implementation files live in `src/`; CLI entrypoint is `src/index.ts`; command dispatch is `src/cli.ts`; HTTP proxy is `src/server.ts`.
- Auth: `src/auth.ts` reads and refreshes Codex credentials from `~/.codex/auth.json`; keep token handling bounded and never log token values.
- Upstream calls: `src/upstream.ts` sends streaming requests to ChatGPT Codex backend with concurrency limiting and retry handling.
- Usage calls: `src/usage.ts` may call ChatGPT/Codex `backend-api/wham/usage` to show 5h/weekly limits and reset times; treat it as a non-official endpoint and never print auth tokens or raw credential files.
- Translation: `src/translate.ts` owns OpenAI Chat Completions <-> Responses API shape conversion; keep protocol mapping changes localized there when possible.
- Tunnels: `src/tunnel.ts` owns the (mandatory) named Cloudflare tunnel behavior and persists tunnel URL metadata under `~/.codex/cursor-proxy`. Both `CLOUDFLARE_TUNNEL_TOKEN` and `CLOUDFLARE_TUNNEL_HOSTNAME` are required; startup throws if either is missing.
- Services: `src/service.ts` is Windows-only scheduled-task integration using `schtasks`; gate platform-specific behavior with `process.platform`.
- Env vars currently used: `PORT`, `CODEX_MODELS`, `CODEX_DEBUG`, `CODEX_MAX_CONCURRENCY`, `CLOUDFLARE_TUNNEL_TOKEN`, `CLOUDFLARE_TUNNEL_HOSTNAME`.
- Prefer small exported functions and explicit interfaces near the code that consumes them.
- Prefer `safeResponseText`/`withTimeout` from `src/http.ts` for bounded HTTP body reads and cancellable network operations.
- Search with `rg` and exclude `node_modules/`, `.git/`, `bun.lock`, and generated `~/.codex/cursor-proxy` files.

## Dos and Don'ts
- Do run `bun run typecheck` after TypeScript changes.
- Do keep errors user-facing but avoid leaking upstream auth/quota details as Cursor API-key failures.
- Do keep SSE streams cancellable; preserve release/abort paths around upstream streams.
- Do keep debug output behind `CODEX_DEBUG === "1"`.
- Don't add dependencies without approval; this repo currently has a minimal dependency set.
- Don't introduce a second runtime/package manager path; default to Bun.
- Don't add broad framework abstractions for this small CLI.
- Don't change public command names (`start`, `up`, `down`, `status`, `usage`, `logs`, `help`) without updating CLI help and docs.
- Don't edit `bun.lock` manually.

## Safety & Guardrails
- Off-limits unless explicitly requested: real auth files, `.env*` secrets, Windows scheduled-task up/down, Cloudflare tunnel credentials, generated files in `~/.codex/cursor-proxy`.
- Safe to automate: static reads, focused source edits, `bun --version`, `bun run typecheck`, and `bun run src/index.ts help`.
- Avoid commands that start servers, watchers, tunnels, or Windows service mutations unless the user asks.
- Never commit secrets, logs, local tunnel URLs, or generated debug dumps.
- Debug log files created by agents must live under project `.cursor/`, never at repo root.

## Git & PR Rules
- Branching model is not documented in this repo; use the current branch unless the user asks for a new one.
- Commit message format is not documented; match recent project history when committing.
- Before PR/commit, run `git status`, review staged and unstaged diffs, and run `bun run typecheck`.
- PR descriptions should state behavior changes, validation performed, and any unverified runtime paths such as tunnel startup or Windows service commands.
