/**
 * The application's only logger: one JSON object per line on stdout, so any
 * log shipper (or `grep`) can read it without a parser. There is no level
 * filtering and no sampling — the operator's pipeline decides what to keep;
 * the app's job is to emit complete, redacted lines.
 *
 * Every line carries `ts`, `level`, `event`, and — whenever the call runs
 * inside a `withLogging`-wrapped route — `request_id`, which is what makes a
 * user-visible error envelope correlatable with the server-side line that
 * explains it.
 *
 * Redaction is enforced here, once, rather than trusted to each call site:
 * any field whose *key* looks sensitive is replaced before serialization,
 * and JWT-shaped or signed-URL-shaped *values* are scrubbed even under
 * innocent keys. The table-driven test in `tests/unit/lib/server/log.test.ts`
 * is the control for Security §2.
 */

import { currentRequestId } from "./request-context";

export type LogFields = Record<string, unknown>;

export type LogLine = {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  request_id?: string;
} & LogFields;

export type LogStream = { write(chunk: string): void };

const stdoutStream: LogStream = {
  write(chunk: string) {
    // `console.log` is the one sink supported by both runtimes this file is
    // bundled into — Node's stdout and the Edge runtime (instrumentation is
    // compiled for both when middleware exists) — and it appends the newline
    // that `write` would otherwise have to add itself.
    console.log(chunk.replace(/\n$/, ""));
  },
};

let stream: LogStream = stdoutStream;

/**
 * Swaps the destination (tests capture lines; production is stdout).
 * Passing `null` restores stdout.
 */
export function setLogStream(next: LogStream | null): void {
  stream = next ?? stdoutStream;
}

/**
 * Keys whose values never belong in a log line. Matching is on a normalized
 * form of the key (lowercased, `_`/`-` removed) so `token_hash`, `tokenHash`
 * and `TOKEN-HASH` all collapse onto the same entry. Adding a field here is
 * a one-line change and the table-driven test picks it up automatically.
 */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "token",
  "tokens",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "tokenhash",
  "signedurl",
  "signedurls",
  "password",
  "passwordhash",
  "apikey",
  "apisecret",
  "secret",
  "clientsecret",
  "privatekey",
  "reporterid",
  "content",
  "jwt",
  "bearer",
  "credentials",
  "sessiontoken",
]);

const REDACTED = "<redacted>";

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/** True when a field name must never have its value logged. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

const JWT_LIKE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;
const TOKEN_IN_URL = /([?&](?:token|signature|sig|jwt|access_token)=)[^&\s]+/gi;
const BEARER_LIKE = /Bearer\s+\S+/gi;

/**
 * Last-line-of-defense scrubbing for values that look like credentials even
 * when the key was innocent (`url`, `message`, `detail`…). Signed URLs are
 * rewritten to their path only, so an operator can still see *which* object
 * was involved without the signature that would grant access to it; bearer
 * tokens embedded mid-string keep their surrounding context.
 */
function scrubValue(value: string): string {
  if (JWT_LIKE.test(value)) {
    return REDACTED;
  }
  return value
    .replace(BEARER_LIKE, "Bearer <redacted>")
    .replace(TOKEN_IN_URL, `$1${REDACTED}`);
}

function redact(value: unknown, depth: number): unknown {
  if (depth > 6) {
    return "<truncated>";
  }
  if (typeof value === "string") {
    return scrubValue(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(entry, depth + 1);
  }
  return out;
}

/**
 * Normalizes an `Error` (or anything else thrown) into loggable fields.
 * The stack is included — these lines go to stdout only, never to a
 * response body (the API boundary answers with the standard envelope).
 */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      stack: error.stack,
    };
  }
  return { error_message: String(error) };
}

function write(level: LogLine["level"], event: string, fields: LogFields): void {
  const requestId = currentRequestId();
  const line: LogLine = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(requestId ? { request_id: requestId } : {}),
    ...(redact(fields, 0) as LogFields),
  };
  stream.write(`${JSON.stringify(line)}\n`);
}

/** Emits an informational line (access logs, lifecycle events). */
export function logInfo(event: string, fields: LogFields = {}): void {
  write("info", event, fields);
}

/** Emits a warning line (limiter fallback, degraded behaviour). */
export function logWarn(event: string, fields: LogFields = {}): void {
  write("warn", event, fields);
}

/** Emits an error line (failed requests, dependency failures). */
export function logError(event: string, fields: LogFields = {}): void {
  write("error", event, fields);
}
