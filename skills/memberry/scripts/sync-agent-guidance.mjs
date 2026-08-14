#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '<!-- memberry-contract:start -->';
const END = '<!-- memberry-contract:end -->';
const SKILLS = ['memberry', 'memberry-setup', 'memberry-wiki', 'memberry-coding'];
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(valueAfter('--repo-root', join(scriptDir, '..', '..', '..')));
const userHome = resolve(valueAfter('--home', homedir()));
const contract = (await readFile(join(repoRoot, 'skills', 'memberry', 'reference', 'agent-contract.md'), 'utf8')).trim();
const rendered = `${START}\n${contract}\n${END}`;

function assertUnder(parent, target) {
  const rel = relative(resolve(parent), resolve(target));
  if (rel.startsWith('..') || rel === '..' || rel.split(sep).includes('..')) throw new Error(`Refusing path outside ${parent}: ${target}`);
}

async function backupOnce(path) {
  if (!existsSync(path)) return;
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const base = `${path}.memberry-backup-${day}`;
  let backup = base;
  for (let suffix = 2; existsSync(backup); suffix += 1) backup = `${base}-${suffix}`;
  await cp(path, backup, { recursive: true });
}

function replaceMarked(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < start) return null;
  return `${text.slice(0, start)}${rendered}${text.slice(end + END.length)}`;
}

function renderAgents(existing) {
  const marked = replaceMarked(existing);
  if (marked != null) return marked;
  const section = existing.indexOf('## MemBerry Memory');
  if (section < 0) return `${existing.trim()}\n\n${rendered}\n`;
  const next = existing.indexOf('\n## ', section + 3);
  return `${existing.slice(0, section)}${rendered}${next < 0 ? '\n' : existing.slice(next)}`;
}

function renderClaude(existing) {
  const marked = replaceMarked(existing);
  if (marked != null) return marked;
  const tailAt = existing.indexOf('\n## Bug Fixing');
  const tail = tailAt >= 0 ? existing.slice(tailAt + 1).trimStart() : '';
  return `# Claude Global Instructions\n\n${rendered}${tail ? `\n\n---\n\n${tail}` : ''}\n`;
}

async function writeOrCheck(path, expected, label) {
  const actual = existsSync(path) ? await readFile(path, 'utf8') : '';
  if (actual === expected) return;
  if (!apply) throw new Error(`${label} is out of sync: ${path}`);
  await backupOnce(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, expected, 'utf8');
}

const agentsPath = join(userHome, 'AGENTS.md');
const claudePath = join(userHome, '.claude', 'CLAUDE.md');
const agentsExisting = existsSync(agentsPath) ? await readFile(agentsPath, 'utf8') : '# Codex Global Instructions\n';
const claudeExisting = existsSync(claudePath) ? await readFile(claudePath, 'utf8') : '# Claude Global Instructions\n';
await writeOrCheck(agentsPath, renderAgents(agentsExisting), 'Global AGENTS contract');
await writeOrCheck(claudePath, renderClaude(claudeExisting), 'Global Claude contract');

async function sameTree(source, target) {
  if (!existsSync(source) || !existsSync(target)) return false;
  const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target)]);
  if (sourceStat.isDirectory() !== targetStat.isDirectory()) return false;
  if (!sourceStat.isDirectory()) return (await readFile(source)).equals(await readFile(target));
  const [sourceEntries, targetEntries] = await Promise.all([readdir(source), readdir(target)]);
  sourceEntries.sort();
  targetEntries.sort();
  if (sourceEntries.join('\0') !== targetEntries.join('\0')) return false;
  for (const entry of sourceEntries) if (!(await sameTree(join(source, entry), join(target, entry)))) return false;
  return true;
}

for (const skill of SKILLS) {
  const source = join(repoRoot, 'skills', skill);
  if (!existsSync(join(source, 'SKILL.md'))) throw new Error(`Missing canonical skill: ${source}`);
  for (const platform of ['.codex', '.claude']) {
    const root = join(userHome, platform, 'skills');
    const target = join(root, skill);
    assertUnder(root, target);
    if (await sameTree(source, target)) continue;
    if (!apply) throw new Error(`${platform} skill is out of sync: ${skill}`);
    await backupOnce(target);
    await mkdir(root, { recursive: true });
    const staging = join(root, `.${skill}.memberry-staging-${process.pid}`);
    const previous = join(root, `.${skill}.memberry-previous-${process.pid}`);
    assertUnder(root, staging);
    assertUnder(root, previous);
    await rm(staging, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
    await cp(source, staging, { recursive: true });
    if (existsSync(target)) await rename(target, previous);
    try {
      await rename(staging, target);
    } catch (error) {
      if (existsSync(previous) && !existsSync(target)) await rename(previous, target);
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
  }
}

console.log(`MemBerry guidance ${apply ? 'synchronized' : 'is synchronized'} (${SKILLS.length} skills, 2 platforms).`);
