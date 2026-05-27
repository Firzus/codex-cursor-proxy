import { readFile } from "node:fs/promises";
import { AuthError, authFilePath, getAuth } from "./auth.ts";
import { TUNNEL_CONFIG } from "./paths.ts";
import { readTail } from "./logs.ts";
import { PORT, SUPPORTED_MODELS, runServer } from "./server.ts";
import {
  ServiceError,
  assertWindows,
  installService,
  queryService,
  uninstallService,
} from "./service.ts";
import {
  log,
  printFatal,
  printHelp,
  printMissingAuth,
  printServiceInstalled,
  printServiceUninstalled,
  printStatus,
  printVersion,
} from "./ui.ts";

export async function run(argv: string[]): Promise<void> {
  const command = (argv[2] ?? "start").toLowerCase();
  switch (command) {
    case "start":
      return runServer();
    case "install":
      return runInstall(argv);
    case "uninstall":
      return runUninstall();
    case "status":
      return runStatus();
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

async function runInstall(argv: string[]): Promise<void> {
  try {
    const scriptPath = argv[1];
    if (!scriptPath) {
      throw new ServiceError("Cannot resolve script path from argv[1].");
    }
    const state = await installService(scriptPath);
    printServiceInstalled("CodexCursorProxy", state.logPath);
    if (!state.started) {
      log.warn(`Task created but failed to start now: ${state.startError ?? "unknown"}`);
      log.info(`It will start on next logon. Run manually: schtasks /Run /TN CodexCursorProxy`);
    }
  } catch (err) {
    if (err instanceof ServiceError) {
      printFatal(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function runUninstall(): Promise<void> {
  try {
    await uninstallService();
    printServiceUninstalled();
  } catch (err) {
    if (err instanceof ServiceError) {
      printFatal(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function runStatus(): Promise<void> {
  let account = "<unknown>";
  let plan: string | null = null;
  try {
    const auth = await getAuth();
    account = auth.email ?? auth.chatgptAccountId;
    plan = auth.planType;
  } catch (err) {
    if (err instanceof AuthError && err.code === "missing") {
      printMissingAuth(authFilePath());
      process.exit(1);
    }
    throw err;
  }

  const svc = queryService();
  const service: "installed" | "absent" | "n/a" =
    process.platform !== "win32" ? "n/a" : svc.installed ? "installed" : "absent";

  const localUrl = `http://127.0.0.1:${PORT}`;
  const proxyReachable = await pingHealth(localUrl);

  let tunnelUrl: string | null = null;
  try {
    const raw = await readFile(TUNNEL_CONFIG, "utf8");
    const cfg = JSON.parse(raw) as { url?: string };
    if (cfg.url) tunnelUrl = cfg.url;
  } catch {
    // no tunnel config yet
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
    log.info("Logs are written when the proxy runs as an installed service.");
    return;
  }
  process.stdout.write(lines.join("\n"));
  if (!lines.at(-1)?.endsWith("\n")) process.stdout.write("\n");
}

async function pingHealth(localUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const res = await fetch(`${localUrl}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
