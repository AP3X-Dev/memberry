#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const path = process.argv[2];
if (!path) throw new Error('Usage: validate-project-config.mjs <AGENTS.md|CLAUDE.md>');
const text = await readFile(path, 'utf8');
const start = text.indexOf('## MemBerry Memory');
if (start < 0) throw new Error('Missing ## MemBerry Memory section');
const next = text.indexOf('\n## ', start + 3);
const section = text.slice(start, next < 0 ? undefined : next);
const required = ['Project:', 'Description:', 'Domain:', 'Project Tag:', 'Workload Profile:', 'Entities:', 'Canonical Entity IDs:', 'Stable Tags:', 'Recall Priorities:', 'Store Policy:', 'Data Exclusions:', 'Agent Coordination:'];
const missing = required.filter((field) => !section.includes(field));
if (missing.length) throw new Error(`Missing fields: ${missing.join(', ')}`);
const projectTag = section.match(/^Project Tag:\s*(project:[a-z0-9][a-z0-9-]*)\s*$/m)?.[1];
if (!projectTag) throw new Error('Project Tag must be project:<kebab-name>');
const workloadProfile = section.match(/^Workload Profile:\s*(coding|research|operations|mixed)\s*$/m)?.[1];
if (!workloadProfile) throw new Error('Workload Profile must be coding, research, operations, or mixed');
const canonicalBlock = section.match(/Canonical Entity IDs:\s*\n([\s\S]*?)(?=\n[A-Z][A-Za-z ]+:)/)?.[1] ?? '';
if (!/^\s*-\s+[^:\n]+:\s+\S+/m.test(canonicalBlock)) throw new Error('Canonical Entity IDs must contain at least one name: id mapping');
const tagsBlock = section.match(/Stable Tags:\s*\n([\s\S]*?)(?=\n[A-Z][A-Za-z ]+:)/)?.[1] ?? '';
if (!/^\s*-\s+(?!project:)[a-z0-9][a-z0-9-]*\s*$/m.test(tagsBlock)) throw new Error('Stable Tags must contain at least one non-project kebab-case tag');
console.log(`Valid MemBerry config: ${path} (${projectTag}, ${workloadProfile})`);
