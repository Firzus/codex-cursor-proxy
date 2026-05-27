import { LOG_FILE } from "./paths.ts";

const TAIL_LINES = 200;
const TAIL_CHUNK_BYTES = 64 * 1024;

export async function readTail(): Promise<{ exists: boolean; lines: string[]; path: string }> {
  const file = Bun.file(LOG_FILE);
  if (!(await file.exists())) {
    return { exists: false, lines: [], path: LOG_FILE };
  }
  const text = await readTailText(file);
  const allLines = text.split(/\r?\n/);
  const tail = allLines.length > TAIL_LINES ? allLines.slice(-TAIL_LINES) : allLines;
  return { exists: true, lines: tail, path: LOG_FILE };
}

async function readTailText(file: Bun.BunFile): Promise<string> {
  let bytes = TAIL_CHUNK_BYTES;
  for (;;) {
    const start = Math.max(0, file.size - bytes);
    const text = await file.slice(start).text();
    const lines = text.split(/\r?\n/);
    if (start === 0 || lines.length > TAIL_LINES) {
      return text;
    }
    bytes *= 2;
  }
}
