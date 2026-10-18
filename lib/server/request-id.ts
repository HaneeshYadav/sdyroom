/**
 * Request correlation ids.
 *
 * A request id travels in the `x-request-id` header: the proxy accepts a
 * client-supplied value only when it is well-formed, otherwise it mints a
 * fresh one, and every log line and error envelope for that request carries
 * the same id. The format is deliberately narrow — `[A-Za-z0-9_-]{8,128}` —
 * so an id is safe to echo into a response header, grep in logs, and paste
 * into a support ticket without further escaping, and so a hostile client
 * cannot use the header as a log-injection vector (no spaces, no newlines,
 * bounded length).
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** True when `value` is a well-formed request id. */
export function isValidRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}

/**
 * Mints a new request id. A UUID is used because it is collision-proof
 * across instances and already matches the accepted character set.
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Returns the caller's id when it is well-formed, otherwise a fresh one.
 * An absent, malformed, or absurdly long header never fails the request —
 * it is replaced.
 */
export function resolveRequestId(header: string | null | undefined): string {
  if (header !== null && header !== undefined && isValidRequestId(header)) {
    return header;
  }
  return generateRequestId();
}
