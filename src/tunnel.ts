import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Tunnel as CfTunnel, bin, install } from "cloudflared";
import pc from "picocolors";
import { TUNNEL_CONFIG } from "./paths.ts";
import { log } from "./ui.ts";

const TUNNEL_READY_TIMEOUT_MS = 30_000;
const RECONNECT_DELAY_MS = 2_000;

export interface Tunnel {
  readonly url: string;
  readonly connected: boolean;
  close(): Promise<void>;
}

export async function openTunnel(port: number): Promise<Tunnel> {
  if (!existsSync(bin)) {
    process.stdout.write(`  ${pc.dim("Installing cloudflared binary (first run, ~25 MB)…")}\n`);
    await install(bin);
  }

  const localUrl = `http://127.0.0.1:${port}`;
  const token = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  const namedHostname = process.env.CLOUDFLARE_TUNNEL_HOSTNAME;

  if (!token || !namedHostname) {
    throw new Error(
      "A named Cloudflare tunnel is required. Set both CLOUDFLARE_TUNNEL_TOKEN " +
        "(from `cloudflared tunnel token <name>`) and CLOUDFLARE_TUNNEL_HOSTNAME " +
        "(the public hostname you configured for it, e.g. 'proxy.example.com'). " +
        "See .env.example.",
    );
  }

  // A named tunnel's public URL is fixed by its hostname, so it is known before
  // cloudflared finishes dialing the Cloudflare edge. That lets us keep the
  // local proxy up and treat the edge connection as best-effort + self-healing:
  // a slow or offline network at boot must never bring the proxy down.
  const url = namedHostname.startsWith("http") ? namedHostname : `https://${namedHostname}`;

  let cf: CfTunnel | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let connected = false;
  let signalFirstConnect: (() => void) | null = null;
  const firstConnect = new Promise<void>((resolve) => {
    signalFirstConnect = resolve;
  });

  const start = (): void => {
    const instance = CfTunnel.withToken(token, { "--url": localUrl });
    attachVerboseLogs(instance);
    // An "error" event with no listener crashes the whole process, which would
    // take the healthy local proxy down with it. Always absorb it; the "exit"
    // handler is what drives reconnection.
    instance.on("error", (err: Error) => log.warn(`cloudflared error: ${err.message}`));
    instance.on("connected", () => {
      connected = true;
      signalFirstConnect?.();
      signalFirstConnect = null;
    });
    instance.once("exit", () => {
      connected = false;
      if (closed) return;
      log.warn("cloudflared exited; reconnecting…");
      scheduleReconnect();
    });
    cf = instance;
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed) start();
    }, RECONNECT_DELAY_MS);
  };

  start();
  await persistUrl(url);

  // Best effort: give the edge a moment to come up so the banner is accurate,
  // but never fail. At boot the network/DNS is often not ready within the
  // window; the tunnel keeps retrying in the background while the proxy serves.
  await waitOrTimeout(firstConnect, TUNNEL_READY_TIMEOUT_MS);
  if (!connected) {
    log.warn(
      `Tunnel not connected within ${TUNNEL_READY_TIMEOUT_MS / 1000}s — ` +
        "retrying in the background; the local proxy stays up.",
    );
  }

  return {
    get url() {
      return url;
    },
    get connected() {
      return connected;
    },
    async close() {
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (cf) {
        try {
          cf.removeAllListeners();
        } catch {
          // ignore
        }
        try {
          cf.stop();
        } catch {
          // ignore
        }
      }
    },
  };
}

function waitOrTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function attachVerboseLogs(cf: CfTunnel): void {
  const debug = process.env.CODEX_DEBUG === "1";
  cf.on("disconnected", (conn) => {
    const detail = debug ? ` ${pc.dim(JSON.stringify(conn))}` : "";
    log.warn(`cloudflared disconnected${detail}`);
  });
  if (debug) {
    cf.on("connected", (conn) => log.info(`cloudflared connected ${pc.cyan(JSON.stringify(conn))}`));
    cf.on("stdout", (line: string) => log.info(`[cf-out] ${line}`));
    cf.on("stderr", (line: string) => log.info(`[cf-err] ${line}`));
  }
}

async function persistUrl(url: string): Promise<void> {
  await mkdir(dirname(TUNNEL_CONFIG), { recursive: true });
  await writeFile(
    TUNNEL_CONFIG,
    JSON.stringify({ url, persistedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}
