import pc from "picocolors";

const ANSI_RE = /\[[0-9;]*m/g;

export interface BannerInfo {
  account: string;
  plan: string | null;
  localUrl: string;
  tunnelUrl: string;
  models: string[];
}

export function printBanner(info: BannerInfo): void {
  const title = pc.bold(pc.cyan("codex-cursor-proxy"));
  const arrow = pc.dim("▸");
  const planSuffix = info.plan ? pc.dim(`  (${info.plan})`) : "";

  const lines: string[] = [
    "",
    `  ${title}  ${arrow}  ${pc.green("running")}`,
    "",
    `  ${pc.green("✓")} ${pc.dim("Auth   ")}  ${info.account}${planSuffix}`,
    `  ${pc.green("✓")} ${pc.dim("Local  ")}  ${info.localUrl}`,
    `  ${pc.green("✓")} ${pc.dim("Tunnel ")}  ${pc.cyan(info.tunnelUrl)}`,
    "",
    cursorSetupBox(info.tunnelUrl),
    "",
    ...modelsHint(info.models),
    pc.dim("  Press Ctrl+C to stop."),
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

function modelsHint(models: string[]): string[] {
  if (models.length === 0) return [];
  const list = models.join(pc.dim(", "));
  return [
    `  ${pc.dim("Models")}    ${list}`,
    `  ${pc.dim("Effort")}    append ${pc.cyan("-low")} / ${pc.cyan("-medium")} / ${pc.cyan("-high")} / ${pc.cyan("-extra")} to the model id`,
    "",
  ];
}

export function printMissingAuth(authPath: string): void {
  const lines = [
    "",
    `  ${pc.red("✗")} ${pc.bold("No Codex credentials found.")}`,
    `    ${pc.dim(authPath)}`,
    "",
    `    ${pc.dim("Install the official Codex CLI then log in:")}`,
    `      ${pc.cyan("npm i -g @openai/codex")}`,
    `      ${pc.cyan("codex login")}`,
    "",
  ];
  process.stderr.write(lines.join("\n") + "\n");
}

export function printFatal(message: string): void {
  process.stderr.write(`\n  ${pc.red("✗")} ${pc.bold("Fatal:")} ${message}\n\n`);
}

export function printShutdown(): void {
  process.stdout.write(`\n  ${pc.dim("·")} ${pc.dim("Shutting down…")}\n`);
}

export function printVersion(name: string, version: string): void {
  process.stdout.write(`${name} ${version}\n`);
}

export interface StatusInfo {
  account: string;
  plan: string | null;
  service: "installed" | "absent" | "n/a";
  proxyReachable: boolean;
  localUrl: string;
  tunnelUrl: string | null;
  models: string[];
}

export function printStatus(info: StatusInfo): void {
  const title = pc.bold(pc.cyan("codex-cursor-proxy"));
  const arrow = pc.dim("▸");
  const planSuffix = info.plan ? pc.dim(`  (${info.plan})`) : "";

  const serviceLine =
    info.service === "installed"
      ? `${pc.green("✓")} ${pc.dim("Service")}  installed${info.proxyReachable ? pc.dim(" (running)") : pc.yellow(" (not reachable)")}`
      : info.service === "absent"
        ? `${pc.dim("·")} ${pc.dim("Service")}  not installed`
        : `${pc.dim("·")} ${pc.dim("Service")}  ${pc.dim("(Windows only)")}`;

  const proxyLine = info.proxyReachable
    ? `${pc.green("✓")} ${pc.dim("Proxy  ")}  ${info.localUrl}`
    : `${pc.red("✗")} ${pc.dim("Proxy  ")}  not running on ${info.localUrl}`;

  const tunnelLine = info.tunnelUrl
    ? `${pc.green("✓")} ${pc.dim("Tunnel ")}  ${pc.cyan(info.tunnelUrl)}`
    : `${pc.dim("·")} ${pc.dim("Tunnel ")}  unknown (start the proxy to populate)`;

  const lines: string[] = [
    "",
    `  ${title}  ${arrow}  ${pc.bold("status")}`,
    "",
    `  ${pc.green("✓")} ${pc.dim("Auth   ")}  ${info.account}${planSuffix}`,
    `  ${serviceLine}`,
    `  ${proxyLine}`,
    `  ${tunnelLine}`,
    `  ${pc.dim("·")} ${pc.dim("Models ")}  ${info.models.join(pc.dim(", "))}`,
    "",
  ];

  if (info.tunnelUrl) {
    lines.push(
      cursorSetupBox(info.tunnelUrl),
      "",
    );
  }

  if (info.service === "installed" && !info.proxyReachable) {
    lines.push(
      pc.yellow("  Service is installed but proxy isn't reachable."),
      pc.dim("  Check logs with: ") + pc.cyan("codex-cursor-proxy logs"),
      "",
    );
  }

  process.stdout.write(lines.join("\n") + "\n");
}

export function printServiceInstalled(taskName: string, logPath: string): void {
  const lines = [
    "",
    `  ${pc.green("✓")} ${pc.bold("Service installed")} ${pc.dim(`(${taskName})`)}`,
    `    ${pc.dim("Trigger :")}  on Windows logon`,
    `    ${pc.dim("Logs    :")}  ${logPath}`,
    "",
    `    ${pc.dim("Started in background. Verify with: ")}${pc.cyan("codex-cursor-proxy status")}`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

export function printServiceUninstalled(): void {
  const lines = [
    "",
    `  ${pc.green("✓")} ${pc.bold("Service removed")}`,
    `    ${pc.dim("Logs preserved under ~/.codex/cursor-proxy/proxy.log")}`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

export function printHelp(): void {
  const title = pc.bold(pc.cyan("codex-cursor-proxy"));
  const lines = [
    "",
    `  ${title} ${pc.dim("— ChatGPT Plus/Pro Codex as an OpenAI-compatible endpoint")}`,
    "",
    `  ${pc.bold("Usage:")}  codex-cursor-proxy ${pc.dim("[command]")}`,
    "",
    `  ${pc.bold("Commands:")}`,
    `    ${pc.cyan("start")}      ${pc.dim("(default)")} Run the proxy in the foreground`,
    `    ${pc.cyan("install")}    Install as a Windows scheduled task (auto-start on logon)`,
    `    ${pc.cyan("uninstall")}  Remove the auto-start scheduled task`,
    `    ${pc.cyan("status")}     Show auth, service and tunnel state`,
    `    ${pc.cyan("logs")}       Print the last lines of the service log`,
    `    ${pc.cyan("version")}    Print the installed version`,
    `    ${pc.cyan("help")}       Show this help`,
    "",
    `  ${pc.bold("Environment variables:")}`,
    `    ${pc.dim("PORT")}                       Local HTTP port ${pc.dim("(default 8787)")}`,
    `    ${pc.dim("CODEX_MODELS")}               Extra model ids exposed via /v1/models ${pc.dim("(comma-separated)")}`,
    `    ${pc.dim("CODEX_MAX_CONCURRENCY")}      Max concurrent upstream requests ${pc.dim("(default 10)")}`,
    `    ${pc.dim("CODEX_DEBUG")}                Set to ${pc.cyan("1")} to dump SSE traffic and tunnel logs`,
    `    ${pc.dim("CLOUDFLARE_TUNNEL_TOKEN")}    Named Cloudflare tunnel token ${pc.dim("(required)")}`,
    `    ${pc.dim("CLOUDFLARE_TUNNEL_HOSTNAME")} Public hostname for the named tunnel ${pc.dim("(required)")}`,
    "",
    `  ${pc.bold("Examples:")}`,
    `    ${pc.dim("$")} codex-cursor-proxy           ${pc.dim("# start in the foreground")}`,
    `    ${pc.dim("$")} PORT=9000 codex-cursor-proxy ${pc.dim("# bind to a custom port")}`,
    `    ${pc.dim("$")} codex-cursor-proxy status    ${pc.dim("# check service / tunnel state")}`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

export const log = {
  ok(msg: string): void {
    process.stdout.write(`  ${pc.green("✓")}  ${msg}\n`);
  },
  info(msg: string): void {
    process.stdout.write(`  ${pc.dim("·")}  ${msg}\n`);
  },
  warn(msg: string): void {
    process.stderr.write(`  ${pc.yellow("!")}  ${msg}\n`);
  },
  err(msg: string): void {
    process.stderr.write(`  ${pc.red("✗")}  ${msg}\n`);
  },
};

function cursorSetupBox(tunnelUrl: string): string {
  return boxed("Cursor setup", [
    pc.dim("Settings → Models → OpenAI API Key"),
    "",
    `${pc.dim("Base URL :")}  ${pc.bold(`${tunnelUrl}/v1`)}`,
    `${pc.dim("API Key  :")}  any-non-empty-string`,
  ]);
}

function boxed(title: string, lines: string[]): string {
  const visualWidths = lines.map((l) => visibleLength(l));
  const inner = Math.max(title.length + 4, ...visualWidths) + 2;
  const top = `  ${pc.dim(`┌─ ${title} ${"─".repeat(Math.max(0, inner - title.length - 4))}┐`)}`;
  const body = lines.map((l) => {
    const pad = " ".repeat(Math.max(0, inner - visibleLength(l) - 2));
    return `  ${pc.dim("│")}  ${l}${pad}${pc.dim("│")}`;
  });
  const bottom = `  ${pc.dim(`└${"─".repeat(inner)}┘`)}`;
  return [top, ...body, bottom].join("\n");
}

function visibleLength(input: string): number {
  return input.replace(ANSI_RE, "").length;
}
