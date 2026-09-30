/**
 * Redact secret-looking material from any text that may leave the process
 * (MCP responses, CLI output). We never read ~/.dsh/.env, but worker output
 * could in principle echo credentials, so everything outbound passes through
 * this filter.
 */
const REDACTION_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // KEY=value / KEY: value style for common secret variable names
  {
    re: /\b([A-Z][A-Z0-9_]*(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)(\s*[=:]\s*)("?)[^\s"']+\4/g,
    replacement: '$1$3[REDACTED]',
  },
  // Authorization headers
  {
    re: /\b(authorization\s*:\s*bearer\s+)[^\s"']+/gi,
    replacement: '$1[REDACTED]',
  },
  // Common API key shapes (sk-..., long base64-ish tokens after "key"/"token")
  {
    re: /\bsk-[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED]',
  },
  {
    re: /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*)("?)[^\s"']+\2/gi,
    replacement: '$1[REDACTED]',
  },
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const { re, replacement } of REDACTION_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}
