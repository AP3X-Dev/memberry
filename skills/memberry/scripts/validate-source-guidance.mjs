#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(process.argv[2] ?? join(scriptDir, '..', '..', '..'));
const skillNames = ['memberry', 'memberry-setup', 'memberry-wiki', 'memberry-coding'];
const forbidden = ['35 tools available', '8 on-demand domains', 'The 6 Domains', 'domain: "all"', 'every 6 hours', 'If 10+ unprocessed episodes'];

async function filesUnder(path) {
  const output = [];
  for (const name of await readdir(path)) {
    const full = join(path, name);
    if ((await stat(full)).isDirectory()) output.push(...await filesUnder(full));
    else output.push(full);
  }
  return output;
}

for (const name of skillNames) {
  const root = join(repoRoot, 'skills', name);
  for (const required of ['SKILL.md', join('agents', 'openai.yaml')]) {
    if (!existsSync(join(root, required))) throw new Error(`${name} missing ${required}`);
  }
  const skill = await readFile(join(root, 'SKILL.md'), 'utf8');
  if (/\[TODO|TODO:/.test(skill)) throw new Error(`${name} contains TODO placeholders`);
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const keys = frontmatter.split(/\r?\n/).filter((line) => /^[a-z][a-z_-]*:/.test(line)).map((line) => line.split(':', 1)[0]);
  if (keys.join(',') !== 'name,description') throw new Error(`${name} frontmatter must contain only name and description`);
  for (const link of skill.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^[a-z]+:|^#/.test(link[1])) continue;
    if (!existsSync(resolve(root, link[1]))) throw new Error(`${name} has broken reference: ${link[1]}`);
  }
}

const guidanceFiles = [join(repoRoot, '.cursorrules')];
for (const name of skillNames) {
  guidanceFiles.push(...(await filesUnder(join(repoRoot, 'skills', name))).filter((path) => /\.(?:md|ya?ml)$/i.test(path)));
}
for (const path of guidanceFiles) {
  const text = await readFile(path, 'utf8');
  for (const phrase of forbidden) if (text.includes(phrase)) throw new Error(`Stale guidance in ${path}: ${phrase}`);
}

const reference = await readFile(join(repoRoot, 'skills', 'memberry', 'reference', 'memberry-tool-reference.md'), 'utf8');
const tools = [...new Set(reference.match(/\bberry_[a-z0-9_]+\b/g) ?? [])];
if (tools.length !== 49) throw new Error(`Expected 49 documented tools, found ${tools.length}`);
const mainSkill = await readFile(join(repoRoot, 'skills', 'memberry', 'SKILL.md'), 'utf8');
const disclosedInMain = [...new Set(mainSkill.match(/\bberry_[a-z0-9_]+\b/g) ?? [])];
if (disclosedInMain.length > 12) throw new Error(`Main skill discloses ${disclosedInMain.length} tool names; keep the detailed catalog in the reference (max 12)`);
if (mainSkill.includes('| Domain | Tools |')) throw new Error('Main skill must route domains instead of inlining the complete tool catalog');
for (const domain of ['memory', 'temporal', 'admin', 'research', 'code', 'arch', 'wiki', 'retrieval', 'graph']) {
  if (!reference.includes(`\`${domain}\``)) throw new Error(`Missing domain in tool reference: ${domain}`);
}
console.log(`Valid canonical MemBerry guidance: ${skillNames.length} skills, ${tools.length} tools, 9 domains.`);
