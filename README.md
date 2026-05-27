# codex-cursor-proxy

> Use your ChatGPT Plus/Pro Codex subscription from Cursor through an OpenAI-compatible local proxy.

[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.1-000000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Overview](#overview) | [Features](#features) | [Setup](#setup) | [Usage](#usage) | [Configuration](#configuration) | [Development](#development)

## Overview

`codex-cursor-proxy` is a Bun CLI that starts a local OpenAI-compatible HTTP endpoint for Cursor, forwards requests to ChatGPT Codex, and exposes the local server through a **named Cloudflare Tunnel** you control (token + hostname required). It supports both Chat Completions and Responses-style requests, translates streaming responses for Cursor, and can set itself up as a Windows scheduled task.

> [!WARNING]
> The tunnel URL points to a proxy backed by your Codex session. Keep it private and do not commit real auth files, `.env` files, service logs, or generated tunnel config.

## Features

- **OpenAI-compatible routes** - serves `/health`, `/v1/models`, `/v1/chat/completions`, and `/v1/responses`.
- **Cursor-friendly streaming** - converts upstream Responses SSE into Chat Completions chunks when needed.
- **Codex auth reuse** - reads and refreshes the Codex CLI credentials from `~/.codex/auth.json`.
- **Codex usage status** - shows ChatGPT/Codex 5h and weekly usage windows with reset times.
- **Named Cloudflare Tunnel** - exposes the proxy at the stable HTTPS hostname you configure in Cloudflare (no quick/`*.trycloudflare.com` fallback).
- **Windows service mode** - sets up or tears down an auto-start scheduled task with `schtasks`.
- **Concurrency control** - caps upstream in-flight requests with `CODEX_MAX_CONCURRENCY`.

## Setup

Prerequisites:

- [Bun](https://bun.sh) `>=1.1`
- Official Codex CLI login:

```bash
npm i -g @openai/codex
codex login
```

Fetch project dependencies from the repository root:

```bash
bun install
```

Verify the TypeScript sources:

```bash
bun run typecheck
```

## Usage

Set both `CLOUDFLARE_TUNNEL_TOKEN` and `CLOUDFLARE_TUNNEL_HOSTNAME` first (see [Configuration](#configuration) and `.env.example`). The proxy refuses to start without them — there is no quick-tunnel fallback. See the [Cloudflare named tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/) to create the tunnel and grab its token.

Start the proxy in the foreground:

```bash
bun start
```

When the banner prints a tunnel URL, configure Cursor (the model is picked in Cursor's UI):

```text
Base URL : https://<your-tunnel-url>/v1
API Key  : any-non-empty-string
```

Supported model ids (default set): `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`. Add your own via `CODEX_MODELS=foo,bar`.

### Reasoning effort suffix

Append `-low`, `-medium`, `-high`, or `-extra` to any supported model id to set the reasoning effort sent upstream. The proxy strips the suffix, sends the base model + `reasoning.effort` to Codex, and accepts the suffixed id transparently from Cursor.

```text
gpt-5.4-high   →  model=gpt-5.4   reasoning.effort=high
gpt-5.4-extra  →  model=gpt-5.4   reasoning.effort=xhigh
```

The start/status banner shows the available ids; each request log line prints the resolved `effort=` and whether `fast=` (service tier `priority`) was negotiated.

### Command line help

```text
codex-cursor-proxy - ChatGPT Plus/Pro Codex as an OpenAI-compatible endpoint

Usage: codex-cursor-proxy [command]

Commands:
  start      (default) Run the proxy in the foreground
  up         Set up a Windows scheduled task (auto-start on logon)
  down       Tear down the auto-start scheduled task
  status     Show auth, service and tunnel state
  usage      Show ChatGPT/Codex usage limits and reset times
  logs       Print the last lines of the service log
  version    Print the package version
  help       Show this help

Env:
  PORT                        Local HTTP port (default 8787)
  CODEX_MODELS                Extra model ids exposed via /v1/models (comma-separated)
  CODEX_MAX_CONCURRENCY       Max concurrent upstream requests (default 10)
  CODEX_DEBUG                 Set to 1 to dump SSE traffic and tunnel logs
  CLOUDFLARE_TUNNEL_TOKEN     Named Cloudflare tunnel token (required)
  CLOUDFLARE_TUNNEL_HOSTNAME  Public hostname for the named tunnel (required)
```

### Windows auto-start

Set up the scheduled task:

```bash
bun run up
```

Check status and logs:

```bash
bun run status
bun run usage
bun run logs
```

Tear down the scheduled task:

```bash
bun run down
```

> [!IMPORTANT]
> `up`, `down`, and `logs` are Windows-only. Run service setup from an elevated shell if `schtasks` reports access denied.

### Codex usage

Show the current ChatGPT/Codex usage windows:

```bash
bun run usage
```

The command displays the 5h and weekly limits returned by ChatGPT/Codex, including percentage used, percentage remaining, and reset time, for example `Réinitialisation : 19:56` or `Réinitialisation : 31 mai 2026 18:58`. It uses the same Codex login as the proxy and calls the ChatGPT/Codex `backend-api/wham/usage` endpoint. That endpoint is not an official OpenAI Platform API and may change; it is different from the official organization usage/costs endpoints for API keys.

For scripts:

```bash
bun run usage -- --json
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Local HTTP port bound to `127.0.0.1`. |
| `CODEX_MODELS` | empty | Comma-separated extra model IDs returned by `/v1/models`. |
| `CODEX_MAX_CONCURRENCY` | `10` | Maximum concurrent upstream Codex requests. |
| `CODEX_DEBUG` | empty | Set to `1` to write debug JSONL and verbose tunnel logs. |
| `CLOUDFLARE_TUNNEL_TOKEN` | **required** | Token for the named Cloudflare tunnel that fronts this proxy. |
| `CLOUDFLARE_TUNNEL_HOSTNAME` | **required** | Public hostname configured for that tunnel. |

Example tunnel env:

```bash
CLOUDFLARE_TUNNEL_TOKEN=...
CLOUDFLARE_TUNNEL_HOSTNAME=proxy.example.com
```

Generated runtime files live under `~/.codex/cursor-proxy/`.

## Development

Run the watcher:

```bash
bun run dev
```

Run the type checker:

```bash
bun run typecheck
```

Project layout:

```text
src/index.ts      CLI entrypoint and shutdown wiring
src/cli.ts        command dispatch
src/server.ts     local OpenAI-compatible HTTP server
src/translate.ts  Chat Completions <-> Responses translation
src/upstream.ts   ChatGPT Codex backend calls
src/tunnel.ts     Cloudflare tunnel lifecycle
src/service.ts    Windows scheduled-task integration
src/auth.ts       Codex credential loading and refresh
```
