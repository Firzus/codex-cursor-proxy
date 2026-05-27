import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(homedir(), ".codex");

export const AUTH_FILE = join(ROOT, "auth.json");
export const PROXY_DIR = join(ROOT, "cursor-proxy");
export const TUNNEL_CONFIG = join(PROXY_DIR, "config.json");
export const LOG_FILE = join(PROXY_DIR, "proxy.log");
export const LAUNCHER_VBS = join(PROXY_DIR, "launcher.vbs");
export const DEBUG_FILE = join(PROXY_DIR, "debug.jsonl");

export const SERVICE_NAME = "CodexCursorProxy";
