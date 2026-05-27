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

  let cf: CfTunnel | null = null;
  let url = "";
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const spawn = async (): Promise<string> => {
    cf = CfTunnel.withToken(token, { "--url": localUrl });
    attachVerboseLogs(cf);
    attachExitHandler(cf);
    return await waitForNamedTunnelReady(cf, namedHostname);
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (closed) return;
      try {
        url = await spawn();
        await persistUrl(url);
      } catch {
        scheduleReconnect();
      }
    }, RECONNECT_DELAY_MS);
  };

  const attachExitHandler = (instance: CfTunnel): void => {
    instance.once("exit", () => {
      if (closed) return;
      scheduleReconnect();
    });
  };

  url = await spawn();
  await persistUrl(url);

  return {
    get url() {
      return url;
    },
    async close() {
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (cf) {
        try {
          cf.removeAllListeners("exit");
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

function waitForNamedTunnelReady(cf: CfTunnel, hostname: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`cloudflared did not connect within ${TUNNEL_READY_TIMEOUT_MS / 1000}s`));
    }, TUNNEL_READY_TIMEOUT_MS);
    const onConnected = (): void => {
      cleanup();
      resolve(hostname.startsWith("http") ? hostname : `https://${hostname}`);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      cf.off("connected", onConnected);
      cf.off("error", onError);
    };
    cf.once("connected", onConnected);
    cf.once("error", onError);
  });
}

async function persistUrl(url: string): Promise<void> {
  await mkdir(dirname(TUNNEL_CONFIG), { recursive: true });
  await writeFile(
    TUNNEL_CONFIG,
    JSON.stringify({ url, persistedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}
