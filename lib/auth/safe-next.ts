/**
 * Post-auth redirect allow-list (PR 21).
 *
 * `next=` style parameters are attacker-controlled: an email-confirmation
 * link with `next=https://evil.example` must never bounce a freshly
 * verified session to another origin (open redirect — the phishing
 * primitive named in docs/SECURITY.md).
 *
 * A target is safe only when it is a *site-internal path*:
 * - it starts with a single `/` (so `https:`, `javascript:` and bare
 *   `evil.com` are out, and protocol-relative `//host` is out),
 * - it contains no backslash (browsers normalise `\` to `/`, turning
 *   `/\evil.com` into a protocol-relative URL),
 * - it contains no control characters or newlines (header/query
 *   smuggling and display spoofing).
 *
 * Anything else returns `null` so the caller falls back to its default
 * in-app destination instead of trusting the input.
 */
export function safeInternalPath(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return raw;
}
