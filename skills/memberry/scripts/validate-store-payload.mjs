#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const input = process.argv[2] ? await readFile(process.argv[2], 'utf8') : await new Promise((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
});
const value = JSON.parse(input);
const errors = [];
const types = new Set(['decision', 'pattern', 'convention', 'architecture', 'preference', 'fact', 'general']);
const outcomes = new Set(['approved', 'revised', 'rejected', 'abandoned']);
if (!/^session-\d{8}-\d{6}$/.test(value.session_id ?? '')) errors.push('session_id must match session-YYYYMMDD-HHMMSS');
if (typeof value.task !== 'string' || !value.task.trim()) errors.push('task is required');
if (typeof value.content !== 'string' || !value.content.trim()) errors.push('content is required');
if (!/^project:[a-z0-9][a-z0-9-]*$/.test(value.scope ?? '')) errors.push('scope must be project:<kebab-name>');
if (!Array.isArray(value.tags) || !value.tags.includes(value.scope)) errors.push('tags must include the exact project scope');
if (!types.has(value.memory_type)) errors.push(`memory_type must be one of: ${[...types].join(', ')}`);
if (value.outcome != null && !outcomes.has(value.outcome)) errors.push(`outcome must be one of: ${[...outcomes].join(', ')}`);
if (value.memory_type === 'decision' && value.outcome !== 'approved') errors.push('final decision stores require outcome=approved');
if (['pattern', 'convention'].includes(value.memory_type) && value.outcome != null) errors.push('pattern/convention evidence must not invent an outcome');
if (value.entities != null && (!Array.isArray(value.entities) || value.entities.some((id) => typeof id !== 'string' || !id.trim()))) errors.push('entities must be non-empty canonical Entity ID strings');
if (value.signals != null && (!Array.isArray(value.signals) || value.signals.some((signal) => !['reinforcement', 'correction', 'contradiction'].includes(signal?.type) || typeof signal?.target_id !== 'string'))) errors.push('signals require a valid type and existing Semantic target_id');
if (errors.length) throw new Error(errors.join('\n'));
console.log('Valid berry_store payload. Entity identity must still be verified against MemBerry.');
