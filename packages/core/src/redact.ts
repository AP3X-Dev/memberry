// packages/core/src/redact.ts
//
// Secret redaction applied at the INGEST boundary (berry_store), gated by
// MEMBERRY_REDACT_ON_INGEST. The graph package already redacts at export time,
// but that is the last line of defense — by then the plaintext secret is already
// persisted in Neo4j and leaks via raw DB access / backups. Redacting here keeps
// credentials out of the store entirely.
//
// Kept deliberately in @memberry/core (not imported from @memberry/graph) to
// avoid a dependency cycle. The pattern set is intentionally conservative to
// avoid mangling legitimate prose.

const SECRET_REPLACEMENT = '[REDACTED]';

/** Conservative high-signal secret shapes (no look-behind, broad runtime compat). */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style secret keys
  /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/g, // Stripe secret / restricted keys
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /ghp_[A-Za-z0-9]{30,}/g, // GitHub personal access token
  /gho_[A-Za-z0-9]{30,}/g, // GitHub OAuth token
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack token
  /AIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, // JWT
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, // PEM
];

/**
 * `KEY = "value"` / `secret: value` / `token=value` assignments where the key
 * name signals a credential. Captures the key prefix (incl. any quotes around
 * the key and the separator), redacts the value.
 *
 * Handles bare (`password=hunter2`), spaced (`password: hunter2`), AND
 * JSON-quoted (`"password":"hunter2"`, `"api_key": "sk-..."`, `'secret' = 'x'`)
 * shapes — JSON is the dominant form for secrets flowing in from API responses,
 * config dumps and tool outputs. The value capture is bounded: a quoted value
 * spans to its FIRST UNESCAPED closing quote (`(?:\\.|(?!\2)[^\\])*` handles
 * embedded `\"` escapes — OPT-33: previously `[^"']*` stopped at the escaped
 * quote and leaked the value's tail plus the adjacent key), a bare value stops
 * at whitespace / `,` / `;` / `}` — so `{"a":"1","password":"hunter2","b":"2"}`
 * masks only the password value and leaves the sibling keys intact.
 *
 * Keyword list (OPT-33) covers pwd/passphrase/private_key/credential(s)/
 * secret_key and the AWS secret/session keys in addition to the originals.
 * `Authorization: Bearer …` is handled separately by BEARER_TOKEN below (the
 * `\bauth\b` keyword can't match the longer word "Authorization", and a bare
 * value capture would stop at the space after "Bearer" and leak the token).
 */
const SECRET_ASSIGNMENT =
  /(["']?\b(?:api[_-]?key|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|secret[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|passphrase|password|passwd|pwd|credentials?|secret|token|auth)\b["']?\s*[:=]\s*)(?:(["'])(?:\\.|(?!\2)[^\\])*\2|[^"'\s,;}]+)/gi;

/**
 * `Bearer <token>` (e.g. inside an `Authorization: Bearer …` header). Redacts
 * the token, keeps the scheme word. Min length 8 avoids matching prose like
 * "Bearer token". OPT-33: closes the OPT-05 review residual where
 * `Authorization: Bearer xxx` slipped through entirely.
 */
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Credentials embedded in connection strings, e.g.
 * `redis://user:p4ss@host`, `postgres://u:p@h`. Redacts the password component.
 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@/\s]+@/gi;

/** Redact common secret shapes from a free-text string. */
export function redactSecrets(value: string): string {
  let out = value;
  for (const re of SECRET_PATTERNS) out = out.replace(re, SECRET_REPLACEMENT);
  out = out.replace(SECRET_ASSIGNMENT, (_m, prefix) => `${prefix}${SECRET_REPLACEMENT}`);
  out = out.replace(BEARER_TOKEN, (_m, prefix) => `${prefix}${SECRET_REPLACEMENT}`);
  out = out.replace(URL_CREDENTIALS, (_m, prefix) => `${prefix}${SECRET_REPLACEMENT}@`);
  return out;
}

/** Redact secrets from a value only when it is a string; pass everything else through. */
export function redactValue(value: unknown): unknown {
  return typeof value === 'string' ? redactSecrets(value) : value;
}
