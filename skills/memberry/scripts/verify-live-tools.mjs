#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const url = valueAfter('--url', process.env.MEMBERRY_MCP_URL ?? 'http://192.168.0.25:3101/mcp');
const token = process.env[valueAfter('--token-env', 'MEMBERRY_API_TOKEN')];
if (!token) throw new Error('Set MEMBERRY_API_TOKEN or pass --token-env <name>. The token is never printed.');
const reference = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'reference', 'memberry-tool-reference.md'), 'utf8');
const expected = [...new Set(reference.match(/\bberry_[a-z0-9_]+\b/g) ?? [])].sort();
const domains = ['memory', 'temporal', 'admin', 'research', 'code', 'arch', 'wiki', 'retrieval', 'graph'];
let requestId = 0;

function parseBody(contentType, body) {
  if ((contentType ?? '').includes('text/event-stream')) {
    const data = body.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    return JSON.parse(data);
  }
  return JSON.parse(body);
}

async function post(body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 200)}`);
  return { response, envelope: text ? parseBody(response.headers.get('content-type'), text) : null };
}

const initialized = await post({
  jsonrpc: '2.0', id: ++requestId, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'memberry-guidance-validator', version: '1.0.0' } },
});
const sessionId = initialized.response.headers.get('mcp-session-id');
if (!sessionId) throw new Error('MCP initialize returned no session ID');
const protocolVersion = initialized.envelope?.result?.protocolVersion ?? '2025-03-26';
const sessionHeaders = { 'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion };
await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionHeaders);

async function call(method, params) {
  const { envelope } = await post({ jsonrpc: '2.0', id: ++requestId, method, params }, sessionHeaders);
  if (envelope?.error) throw new Error(`${method}: ${envelope.error.message}`);
  return envelope.result;
}

const actual = new Set((await call('tools/list', {})).tools.map((tool) => tool.name));
for (const domain of domains) {
  await call('tools/call', { name: 'berry_tools', arguments: { action: 'enable', domain } });
  for (const tool of (await call('tools/list', {})).tools) actual.add(tool.name);
}
const live = [...actual].sort();
const missing = expected.filter((name) => !actual.has(name));
const unknown = live.filter((name) => !expected.includes(name));
if (missing.length || unknown.length) throw new Error(`Tool catalog drift. Missing: ${missing.join(', ') || 'none'}. Unknown: ${unknown.join(', ') || 'none'}.`);
console.log(`Live MemBerry tool catalog matches guidance: ${live.length} tools across ${domains.length} domains.`);
