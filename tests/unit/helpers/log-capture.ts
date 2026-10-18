import { setLogStream, type LogLine } from "@/lib/server/log";

/**
 * The stream unit tests run against by default: a black hole. The app logs
 * one JSON line per request through `lib/server/log`; without this the
 * vitest reporter would drown in it. Tests that assert on logging swap in
 * `captureLogs()` for the duration of the call under test.
 */
const silentStream = { write() {} };

/** Installs the silent stream (used by `tests/setup.ts`). */
export function silenceLogs(): void {
  setLogStream(silentStream);
}

/**
 * Captures every line the logger emits until `restore()` is called.
 * `restore()` returns to the silent default, never to stdout.
 */
export function captureLogs(): { lines: LogLine[]; restore: () => void } {
  const lines: LogLine[] = [];
  setLogStream({
    write(chunk: string) {
      lines.push(JSON.parse(chunk) as LogLine);
    },
  });
  return { lines, restore: () => silenceLogs() };
}

/** Convenience: error-level lines captured so far, optionally by event. */
export function errorLines(
  lines: LogLine[],
  event?: string,
): LogLine[] {
  return lines.filter(
    (line) => line.level === "error" && (event === undefined || line.event === event),
  );
}
