// packages/core/src/__tests__/redact.test.ts
import { describe, it, expect } from 'vitest';
import { redactSecrets, redactValue } from '../redact.js';

describe('redactSecrets', () => {
  it('redacts OpenAI-style keys', () => {
    expect(redactSecrets('key is sk-abcdEFGH1234567890 ok')).toBe('key is [REDACTED] ok');
  });

  it('redacts AWS access key ids', () => {
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED]');
  });

  it('redacts GitHub tokens (classic + fine-grained)', () => {
    expect(redactSecrets('ghp_' + 'a'.repeat(36))).toBe('[REDACTED]');
    expect(redactSecrets('github_pat_' + 'b'.repeat(30))).toBe('[REDACTED]');
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4';
    expect(redactSecrets(`token=${jwt}`)).toContain('[REDACTED]');
    expect(redactSecrets(jwt)).not.toContain('eyJ');
  });

  it('redacts PEM private keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(pem)).toBe('[REDACTED]');
  });

  it('redacts credential assignments by key name', () => {
    expect(redactSecrets('password: hunter2')).toBe('password: [REDACTED]');
    // The value (and any surrounding quotes) is replaced wholesale.
    expect(redactSecrets('API_KEY="superlongsecretvalue"')).toBe('API_KEY=[REDACTED]');
    expect(redactSecrets('client_secret=abc123def')).toBe('client_secret=[REDACTED]');
  });

  it('redacts JSON-quoted credential keys (the dominant secret shape)', () => {
    // Quoted key + quoted value — the key stays visible, only the value is masked.
    expect(redactSecrets('"password":"hunter2"')).toBe('"password":[REDACTED]');
    expect(redactSecrets('"api_key": "sk-shortvalue"')).toBe('"api_key": [REDACTED]');
    // Single-quoted key with spaced `=` separator.
    expect(redactSecrets("'secret' = 'x'")).toBe("'secret' = [REDACTED]");
  });

  it('masks only the secret value inside a JSON object, leaving siblings intact', () => {
    expect(redactSecrets('{"a":"1","password":"hunter2","b":"2"}')).toBe(
      '{"a":"1","password":[REDACTED],"b":"2"}',
    );
  });

  it('redacts credentials embedded in connection strings', () => {
    expect(redactSecrets('redis://user:p4ssw0rd@host:6379')).toBe('redis://user:[REDACTED]@host:6379');
    expect(redactSecrets('postgres://admin:secretpw@db/app')).toBe('postgres://admin:[REDACTED]@db/app');
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'The auth module uses JWT tokens for sessions and decays confidence over time.';
    expect(redactSecrets(prose)).toBe(prose);
  });

  it('redactValue passes through non-strings', () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBe(null);
    expect(redactValue('sk-abcdEFGH1234567890')).toBe('[REDACTED]');
  });
});

// ─── OPT-33: broadened coverage + OPT-05 review residuals ─────────────────────
describe('redactSecrets — OPT-33 broadened coverage', () => {
  it('redacts Stripe secret / restricted keys', () => {
    expect(redactSecrets('sk_live_' + 'a'.repeat(24))).toBe('[REDACTED]');
    expect(redactSecrets('sk_test_' + 'b'.repeat(24))).toBe('[REDACTED]');
    expect(redactSecrets('rk_live_' + 'c'.repeat(24))).toBe('[REDACTED]');
  });

  it('redacts the token after Bearer, keeping the scheme word', () => {
    expect(redactSecrets('Authorization: Bearer abcdef0123456789XYZ')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    // opaque (non-JWT) bearer token is still caught
    expect(redactSecrets('bearer ' + 'z'.repeat(20))).toBe('bearer [REDACTED]');
    // too-short trailing word is NOT a token (prose-safety)
    expect(redactSecrets('Bearer token')).toBe('Bearer token');
  });

  it('handles escaped quotes in a JSON value without leaking the tail or the adjacent key (OPT-05 residual)', () => {
    // The password value contains an escaped quote; the WHOLE value must be
    // masked, and the adjacent key/value must NOT be re-exposed.
    expect(redactSecrets('"password":"a\\"b","next":"LEAKED"')).toBe(
      '"password":[REDACTED],"next":"LEAKED"',
    );
  });

  it('covers the additional credential keywords', () => {
    expect(redactSecrets('pwd=hunter2trustno1')).toBe('pwd=[REDACTED]');
    expect(redactSecrets('passphrase: correct-horse')).toBe('passphrase: [REDACTED]');
    expect(redactSecrets('private_key="-----inline-----"')).toBe('private_key=[REDACTED]');
    expect(redactSecrets('credential: abc123def')).toBe('credential: [REDACTED]');
    expect(redactSecrets('"secret_key":"topsecretvalue"')).toBe('"secret_key":[REDACTED]');
    expect(redactSecrets('aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCY')).toBe(
      'aws_secret_access_key=[REDACTED]',
    );
  });

  it('still leaves ordinary prose untouched (no new false positives)', () => {
    const prose = 'The auth module uses JWT tokens for sessions; the bearer of bad news.';
    expect(redactSecrets(prose)).toBe(prose);
  });
});
