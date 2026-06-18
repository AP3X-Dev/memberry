// packages/core/src/__tests__/configure.test.ts
import { describe, it, expect } from 'vitest';
import {
  resolveUrl,
  resolveToken,
  claudeMcpEntry,
  claudeAddJsonCommand,
  codexAddCommand,
  codexTomlBlock,
  bashEnvSnippet,
  powershellEnvSnippet,
  mergeClaudeConfig,
  mergeCodexToml,
} from '../cli/configure.js';

describe('configure: URL/token resolution', () => {
  it('prefers --url, then MEMBERRY_MCP_URL, then composes the /mcp default', () => {
    expect(resolveUrl({ url: 'http://x:9/mcp' }, {})).toBe('http://x:9/mcp');
    expect(resolveUrl({}, { MEMBERRY_MCP_URL: 'http://env:1/mcp' })).toBe('http://env:1/mcp');
    expect(resolveUrl({}, { MEMBERRY_PUBLIC_HOST: 'lan-host', MCP_PORT: '4000' })).toBe(
      'http://lan-host:4000/mcp',
    );
    expect(resolveUrl({}, {})).toBe('http://localhost:3101/mcp');
  });

  it('always terminates the composed URL in /mcp (not /sse)', () => {
    const url = resolveUrl({}, {});
    expect(url.endsWith('/mcp')).toBe(true);
    expect(url).not.toContain('/sse');
  });

  it('prefers --token, then MEMBERRY_API_TOKEN, else undefined', () => {
    expect(resolveToken({ token: 'tok-flag' }, {})).toBe('tok-flag');
    expect(resolveToken({}, { MEMBERRY_API_TOKEN: 'tok-env' })).toBe('tok-env');
    expect(resolveToken({}, {})).toBeUndefined();
  });
});

describe('configure: Claude config shape', () => {
  it('emits the load-bearing "type":"http" discriminator and a Bearer header', () => {
    const entry = claudeMcpEntry('http://localhost:3101/mcp', 'mbry_abc');
    expect(entry.type).toBe('http');
    expect(entry.url).toBe('http://localhost:3101/mcp');
    expect(entry.headers?.Authorization).toBe('Bearer mbry_abc');
  });

  it('omits the Authorization header when no token is present', () => {
    const entry = claudeMcpEntry('http://localhost:3101/mcp');
    expect(entry.type).toBe('http');
    expect(entry.headers).toBeUndefined();
  });

  it('produces a claude mcp add-json command whose JSON carries type:http + Bearer', () => {
    const cmd = claudeAddJsonCommand('http://localhost:3101/mcp', 'mbry_abc');
    expect(cmd).toContain('claude mcp add-json memberry');
    expect(cmd).toContain('"type":"http"');
    expect(cmd).toContain('"Authorization":"Bearer mbry_abc"');
    // The JSON payload is single-quoted so the shell passes it verbatim.
    const json = cmd.slice(cmd.indexOf("'") + 1, cmd.lastIndexOf("'"));
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json).type).toBe('http');
  });
});

describe('configure: Codex config shape', () => {
  it('produces the verified codex mcp add CLI form (env-var token)', () => {
    const cmd = codexAddCommand('http://localhost:3101/mcp');
    expect(cmd).toBe(
      'codex mcp add memberry --url http://localhost:3101/mcp --bearer-token-env-var MEMBERRY_API_TOKEN',
    );
  });

  it('produces a [mcp_servers.memberry] TOML block with url + bearer_token_env_var', () => {
    const block = codexTomlBlock('http://localhost:3101/mcp');
    expect(block).toContain('[mcp_servers.memberry]');
    expect(block).toContain('url = "http://localhost:3101/mcp"');
    expect(block).toContain('bearer_token_env_var = "MEMBERRY_API_TOKEN"');
  });
});

describe('configure: env snippets', () => {
  it('Bash snippet exports both the token and the URL', () => {
    const s = bashEnvSnippet('http://localhost:3101/mcp', 'mbry_abc');
    expect(s).toContain('export MEMBERRY_API_TOKEN=mbry_abc');
    expect(s).toContain('export MEMBERRY_MCP_URL=http://localhost:3101/mcp');
  });

  it('PowerShell snippet sets both User-scoped env vars', () => {
    const s = powershellEnvSnippet('http://localhost:3101/mcp', 'mbry_abc');
    expect(s).toContain("[Environment]::SetEnvironmentVariable('MEMBERRY_API_TOKEN','mbry_abc','User')");
    expect(s).toContain("[Environment]::SetEnvironmentVariable('MEMBERRY_MCP_URL','http://localhost:3101/mcp','User')");
  });
});

describe('configure: idempotent Claude merge', () => {
  it('inserts mcpServers.memberry without disturbing other settings', () => {
    const merged = mergeClaudeConfig({ model: 'opus', mcpServers: { other: { url: 'x' } } } as any, 'http://localhost:3101/mcp', 'mbry_abc');
    expect((merged as any).model).toBe('opus');
    expect((merged as any).mcpServers.other).toEqual({ url: 'x' });
    expect((merged as any).mcpServers.memberry.type).toBe('http');
    expect((merged as any).mcpServers.memberry.headers.Authorization).toBe('Bearer mbry_abc');
  });

  it('is idempotent: a second merge yields a deep-equal object (no duplication)', () => {
    const once = mergeClaudeConfig({}, 'http://localhost:3101/mcp', 'mbry_abc');
    const twice = mergeClaudeConfig(once, 'http://localhost:3101/mcp', 'mbry_abc');
    expect(twice).toEqual(once);
    expect(Object.keys((twice as any).mcpServers)).toEqual(['memberry']);
  });
});

describe('configure: idempotent Codex TOML merge', () => {
  it('appends the block to existing config, preserving other tables', () => {
    const existing = '[mcp_servers.amp]\ncommand = "npx"\n';
    const merged = mergeCodexToml(existing, 'http://localhost:3101/mcp');
    expect(merged).toContain('[mcp_servers.amp]');
    expect(merged).toContain('[mcp_servers.memberry]');
    expect(merged).toContain('url = "http://localhost:3101/mcp"');
  });

  it('is idempotent: a second merge does not duplicate the block', () => {
    const once = mergeCodexToml('', 'http://localhost:3101/mcp');
    const twice = mergeCodexToml(once, 'http://localhost:3101/mcp');
    const occurrences = twice.split('[mcp_servers.memberry]').length - 1;
    expect(occurrences).toBe(1);
    expect(twice).toEqual(once);
  });

  it('replaces an existing block in place when the URL changes (still single block)', () => {
    const first = mergeCodexToml('', 'http://localhost:3101/mcp');
    const updated = mergeCodexToml(first, 'http://lan:4000/mcp');
    expect(updated.split('[mcp_servers.memberry]').length - 1).toBe(1);
    expect(updated).toContain('url = "http://lan:4000/mcp"');
    expect(updated).not.toContain('url = "http://localhost:3101/mcp"');
  });

  it('replaces a block that sits in the MIDDLE, preserving the following table + blank separator', () => {
    const existing = [
      '[mcp_servers.amp]',
      'command = "npx"',
      '',
      '[mcp_servers.memberry]',
      'url = "http://old:3101/mcp"',
      'bearer_token_env_var = "MEMBERRY_API_TOKEN"',
      '',
      '[other_table]',
      'key = "value"',
      '',
    ].join('\n');
    const merged = mergeCodexToml(existing, 'http://lan:4000/mcp');
    expect(merged.split('[mcp_servers.memberry]').length - 1).toBe(1); // still a single block
    expect(merged).toContain('url = "http://lan:4000/mcp"');
    expect(merged).not.toContain('url = "http://old:3101/mcp"');
    expect(merged).toContain('[mcp_servers.amp]'); // preceding table intact
    expect(merged).toContain('[other_table]'); // following table intact
    expect(merged).toContain('key = "value"');
    // the next table is not glued to our block — the blank separator survives
    expect(merged).toContain('MEMBERRY_API_TOKEN"\n\n[other_table]');
  });

  it('does NOT treat a comment line as an existing block (appends the real block instead)', () => {
    const existing = '# [mcp_servers.memberry] (note)\n[mcp_servers.amp]\ncommand = "npx"\n';
    const merged = mergeCodexToml(existing, 'http://localhost:3101/mcp');
    expect(merged).toContain('# [mcp_servers.memberry] (note)'); // comment preserved
    // the block was actually written (would be absent if the comment falsely triggered the replace path)
    expect(merged).toContain('url = "http://localhost:3101/mcp"');
    expect(merged).toContain('bearer_token_env_var = "MEMBERRY_API_TOKEN"');
  });
});
