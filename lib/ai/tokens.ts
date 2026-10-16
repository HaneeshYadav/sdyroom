/**
 * Token accounting shared by chunking (size targets), the mock provider
 * (honest estimates) and the quota pre-check (bytes are counted in the
 * database; tokens ride alongside for reporting).
 *
 * The estimator is deliberately the same rule everywhere: ~4 characters per
 * token for English-ish study material. It is an estimate — the database
 * ledger stores whatever the real provider reports — so its only job is to
 * be predictable and cheap.
 */
export const CHARS_PER_TOKEN = 4;

/** Estimated tokens for a piece of text; at least 1 for any non-empty input. */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}
