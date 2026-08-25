/**
 * Secret detection (#0046): scan text before it leaves the machine or is
 * persisted into shared artifacts. Used by export, sync and web tools.
 */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { name: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*\b/g },
  { name: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: "generic-api-key", re: /\b(api[_-]?key|secret[_-]?key|access[_-]?token)['":= ]{1,4}['"][A-Za-z0-9_\-./+]{16,}['"]/gi },
];

export interface SecretFinding {
  kind: string;
  start: number;
  end: number;
}

/** Find likely secrets. Returns match spans so callers can redact or block. */
export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      findings.push({ kind: name, start: m.index, end: m.index + m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return findings;
}

export function containsSecret(text: string): boolean {
  return scanForSecrets(text).length > 0;
}

/** Mask any detected secret substrings. */
export function maskSecrets(text: string): string {
  let out = "";
  let cursor = 0;
  for (const f of scanForSecrets(text).sort((a, b) => a.start - b.start)) {
    if (f.start < cursor) continue;
    out += text.slice(cursor, f.start) + `[REDACTED:${f.kind}]`;
    cursor = f.end;
  }
  return out + text.slice(cursor);
}
