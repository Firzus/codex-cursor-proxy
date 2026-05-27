#!/usr/bin/env bun
import { run } from "./cli.ts";
import { runShutdownHandlers } from "./shutdown.ts";
import { printFatal, printShutdown } from "./ui.ts";

let exiting = false;
function gracefulExit(code: number, signal?: NodeJS.Signals): void {
  if (exiting) return;
  exiting = true;
  if (signal) printShutdown();
  void (async () => {
    try {
      await runShutdownHandlers();
    } finally {
      process.exit(code);
    }
  })();
}

process.on("SIGINT", () => gracefulExit(0, "SIGINT"));
process.on("SIGTERM", () => gracefulExit(0, "SIGTERM"));

run(process.argv).catch((err) => {
  printFatal(err instanceof Error ? err.message : String(err));
  gracefulExit(1);
});
