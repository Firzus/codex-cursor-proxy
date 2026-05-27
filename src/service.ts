import { spawnSync } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LAUNCHER_VBS, LOG_FILE, PROXY_DIR, SERVICE_NAME } from "./paths.ts";

const RUNNER_CMD = join(PROXY_DIR, "runner.cmd");

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface ServiceState {
  setUp: boolean;
  started: boolean;
  startError: string | null;
  logPath: string;
}

export function assertWindows(action: string): void {
  if (process.platform !== "win32") {
    throw new ServiceError(`Service ${action} is Windows-only for now.`);
  }
}

export async function upService(scriptPath: string): Promise<ServiceState> {
  assertWindows("up");
  await mkdir(PROXY_DIR, { recursive: true });

  const bunPath = process.execPath;
  // Scheduled tasks start from System32; run from the project root so Bun can load `.env`.
  const absoluteScript = resolve(scriptPath);
  const projectRoot = resolve(dirname(absoluteScript), "..");
  const runnerContent =
    `@echo off\r\n` +
    `cd /D "${projectRoot}"\r\n` +
    `"${bunPath}" run "${absoluteScript}" start >> "${LOG_FILE}" 2>&1\r\n`;
  await writeFile(RUNNER_CMD, runnerContent, "utf8");

  const vbsContent =
    `Set WshShell = CreateObject("WScript.Shell")\r\n` +
    `WshShell.Run """${RUNNER_CMD}""", 0, False\r\n`;
  await writeFile(LAUNCHER_VBS, vbsContent, "utf8");

  const taskAction = `wscript.exe "${LAUNCHER_VBS}"`;
  const create = spawnSync(
    "schtasks",
    [
      "/Create",
      "/TN",
      SERVICE_NAME,
      "/TR",
      taskAction,
      "/SC",
      "ONLOGON",
      "/F",
    ],
    { encoding: "utf8" },
  );

  if (create.status !== 0) {
    throw new ServiceError(formatSchtasksError("/Create", create.stderr || create.stdout));
  }

  const run = spawnSync("schtasks", ["/Run", "/TN", SERVICE_NAME], { encoding: "utf8" });
  const started = run.status === 0;
  const startError = started
    ? null
    : trimOutput(run.stderr || run.stdout || "unknown error");

  return {
    setUp: true,
    started,
    startError,
    logPath: LOG_FILE,
  };
}

export async function downService(): Promise<void> {
  assertWindows("down");

  spawnSync("schtasks", ["/End", "/TN", SERVICE_NAME], { encoding: "utf8" });
  const del = spawnSync(
    "schtasks",
    ["/Delete", "/TN", SERVICE_NAME, "/F"],
    { encoding: "utf8" },
  );

  if (del.status !== 0) {
    const out = (del.stderr || del.stdout || "").toLowerCase();
    const notFound =
      out.includes("does not exist") ||
      out.includes("cannot find") ||
      out.includes("the system cannot find");
    if (!notFound) {
      throw new ServiceError(formatSchtasksError("/Delete", del.stderr || del.stdout));
    }
  }

  await safeUnlink(LAUNCHER_VBS);
  await safeUnlink(RUNNER_CMD);
}

export function queryService(): ServiceState {
  if (process.platform !== "win32") {
    return { setUp: false, started: false, startError: null, logPath: LOG_FILE };
  }
  const result = spawnSync(
    "schtasks",
    ["/Query", "/TN", SERVICE_NAME],
    { encoding: "utf8" },
  );
  return {
    setUp: result.status === 0,
    started: result.status === 0,
    startError: null,
    logPath: LOG_FILE,
  };
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function trimOutput(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function formatSchtasksError(op: string, raw: string): string {
  const trimmed = trimOutput(raw);
  const lower = trimmed.toLowerCase();
  const denied =
    lower.includes("access is denied") ||
    lower.includes("access denied") ||
    trimmed.includes("Accès refusé") ||
    trimmed.includes("acces refuse");
  if (denied) {
    return `schtasks ${op} refused (Access denied). Re-run this command in a PowerShell launched as Administrator.`;
  }
  return `schtasks ${op} failed: ${trimmed}`;
}
