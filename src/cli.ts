import { readFile } from "node:fs/promises";
import { AuthError, authFilePath, getAuth } from "./auth.ts";
import { withTimeout } from "./http.ts";
import { readTail } from "./logs.ts";
import { SERVICE_NAME, TUNNEL_CONFIG } from "./paths.ts";
import { PORT, SUPPORTED_MODELS, runServer } from "./server.ts";
import {
  ServiceError,
  assertWindows,
  downService,
  queryService,
  upService,
} from "./service.ts";
import {
  log,
  printFatal,
  printHelp,
  printMissingAuth,
  printServiceDown,
  printServiceUp,
  printStatus,
  printUsage,
  printVersion,
} from "./ui.ts";
import { fetchCodexUsage, UsageError } from "./usage.ts";

export async function run(argv: string[]): Promise<void> {
  const command = (argv[2] ?? "start").toLowerCase();
  switch (command) {
    case "start":
      return runServer();
    case "up":
      return runUp(argv);
    case "down":
      return runDown();
    case "status":
      return runStatus();
    case "usage":
      return runUsage(argv);
    case "logs":
      return runLogs();
    case "version":
    case "-v":
    case "--version":
      return runVersion();
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return;
    default:
      printFatal(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

async function runVersion(): Promise<void> {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = (await Bun.file(pkgUrl).json()) as { name?: string; version?: string };
  printVersion(pkg.name ?? "codex-cursor-proxy", pkg.version ?? "0.0.0");
}

async function runUp(argv: string[]): Promise<void> {
  try {
    const scriptPath = argv[1];
    if (!scriptPath) {
      throw new ServiceError("Cannot resolve script path from argv[1].");
    }
    const state = await upService(scriptPath);
    printServiceUp(SERVICE_NAME, state.logPath);
    if (!state.started) {
      log.warn(`Task created but failed to start now: ${state.startError ?? "unknown"}`);
      log.info(`It will start on next logon. Run manually: schtasks /Run /TN ${SERVICE_NAME}`);
    }
  } catch (err) {
    if (err instanceof ServiceError) {
      printFatal(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function runDown(): Promise<void> {
  try {
    await downService();
    printServiceDown();
  } catch (err) {
    if (err instanceof ServiceError) {
      printFatal(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function runStatus(): Promise<void> {
  let auth: Awaited<ReturnType<typeof getAuth>>;
  try {
    auth = await getAuth();
  } catch (err) {
    if (err instanceof AuthError && err.code === "missing") {
      printMissingAuth(authFilePath());
      process.exit(1);
    }
    throw err;
  }
  const account = auth.email ?? auth.chatgptAccountId;
  const plan = auth.planType;

  const svc = queryService();
  const service: "set-up" | "absent" | "n/a" =
    process.platform !== "win32" ? "n/a" : svc.setUp ? "set-up" : "absent";

  const localUrl = `http://127.0.0.1:${PORT}`;
  const proxyReachable = await pingHealth(localUrl);

  let tunnelUrl: string | null = null;
  let tunnelRaw: string | null = null;
  try {
    tunnelRaw = await readFile(TUNNEL_CONFIG, "utf8");
  } catch (err) {
    if (!hasErrorCode(err, "ENOENT")) throw err;
  }
  if (tunnelRaw) {
    const cfg = JSON.parse(tunnelRaw) as { url?: unknown };
    if (typeof cfg.url === "string") tunnelUrl = cfg.url;
  }

  printStatus({
    account,
    plan,
    service,
    proxyReachable,
    localUrl,
    tunnelUrl,
    models: SUPPORTED_MODELS,
  });
}

async function runUsage(argv: string[]): Promise<void> {
  const json = argv.slice(3).includes("--json");
  try {
    const usage = await fetchCodexUsage();
    if (json) {
      process.stdout.write(`${JSON.stringify(usage, null, 2)}\n`);
      return;
    }
    printUsage(usage);
  } catch (err) {
    if (err instanceof AuthError && err.code === "missing") {
      printMissingAuth(authFilePath());
      process.exit(1);
    }
    if (err instanceof UsageError) {
      printFatal(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function runLogs(): Promise<void> {
  try {
    assertWindows("logs");
  } catch (err) {
    if (err instanceof ServiceError) {
      printFatal(err.message);
      process.exit(1);
    }
    throw err;
  }
  const { exists, lines, path } = await readTail();
  if (!exists) {
    log.warn(`No log file at ${path}`);
    log.info("Logs are written when the proxy runs as a set-up service.");
    return;
  }
  process.stdout.write(lines.join("\n"));
  if (!lines.at(-1)?.endsWith("\n")) process.stdout.write("\n");
}

async function pingHealth(localUrl: string): Promise<boolean> {
  const t = withTimeout(1000, "health check");
  try {
    const res = await fetch(`${localUrl}/health`, { signal: t.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    t.clear();
  }
}

function hasErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
