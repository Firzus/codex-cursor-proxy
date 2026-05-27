import { log } from "./ui.ts";

export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    log.warn(`Invalid ${name}="${raw}"; falling back to ${fallback}`);
    return fallback;
  }
  return n;
}

export const PORT = parsePositiveIntEnv("PORT", 8787);
