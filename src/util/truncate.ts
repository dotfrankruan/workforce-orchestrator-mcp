const TRUNCATED_MARKER = '\n[output truncated]';

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

/**
 * Truncate a UTF-8 string to at most maxBytes bytes (including the marker
 * when truncation happens), without splitting multi-byte characters.
 */
export function truncateUtf8(input: string, maxBytes: number): TruncateResult {
  const buf = Buffer.from(input, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return { text: input, truncated: false };
  }
  const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATED_MARKER, 'utf8'));
  const slice = buf.subarray(0, budget);
  // Find a clean UTF-8 boundary: locate the lead byte of the last sequence
  // and drop it if its continuation bytes are missing.
  let end = slice.length;
  if (end > 0) {
    let i = end - 1;
    let steps = 0;
    while (i > 0 && steps < 3 && (slice[i]! & 0xc0) === 0x80) {
      i--;
      steps++;
    }
    const lead = slice[i]!;
    const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (i + needed > slice.length) end = i;
  }
  return { text: slice.subarray(0, end).toString('utf8') + TRUNCATED_MARKER, truncated: true };
}

/** Keep only the last `n` lines of a string. */
export function tailLines(input: string, n: number): string {
  if (n <= 0) return '';
  const lines = input.split('\n');
  if (lines.length <= n) return input;
  return lines.slice(lines.length - n).join('\n');
}
