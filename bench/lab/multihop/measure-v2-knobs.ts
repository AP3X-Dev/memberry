// RET-007 v3 — pre-calibration measurement of the two "measured" difficulty knobs
// (bridgeTokenCollisions, factTokenEcho) from the committed v2 DEV input bytes ONLY.
//
// Custody (spec F2): this script reads exactly one file —
// bench/lab/datasets/multihop/v2/dev/input.jsonl. It never opens any oracle
// artifact and never touches bench/lab/datasets/multihop/v2/holdout/**.
//
// Oracle-free chain detection rule (documented per spec "Pre-registered
// difficulty knobs"): the two oracle-required memories of a v2 scenario are
// recovered structurally from adapter-visible bytes alone:
//   1. First hop: the unique memory matching the v2 first-hop grammar
//      `^<subject> (is stored at|is assigned to|contains|is entrusted to|is maintained by) <bridge>.$`
//      whose <subject> (lowercased) appears verbatim in the lowercased probe
//      query text. (v2's committed audit invariants guarantee the query names
//      the chain subject and no distractor pairs subject with bridge.)
//   2. Second hop: the unique memory matching the family-specific v2
//      second-hop grammar anchored at that <bridge>:
//        routing      `^<bridge> sends ... to <answer>.$`
//        assignment   `^<bridge> starts ... at <answer>.$`
//        component    `^<bridge> requires <answer> for ....$`
//        custody      `^<bridge> requires <answer> for ....$`
//        maintenance  `^<bridge> files ... at <answer>.$`
//   3. The detection FAILS LOUDLY (non-zero exit) unless exactly one
//      (first, second) pair exists per scenario and the soundness cross-checks
//      hold (query does not contain the answer; 24 memories; no distractor
//      contains both subject+bridge or bridge+answer name tokens).
//
// Token rule: the "name token" of a chain phrase is the alphabetic core of its
// LAST capitalized word (e.g. "greenhouse Birch" -> "Birch",
// "runoff basin Cobalt" -> "Cobalt", "Seed lot Aster" -> "Aster"). A distractor
// "contains" a name token when it matches /\b<name>(?:-\d+)?\b/ (v2 reuses
// bridge names in composites such as "workspace Birch-02").
//
// Measured quantities, per scenario (22 distractors = 24 memories - 2 hops):
//   bridgeTokenCollisions := distractors containing the ORACLE-chain bridge
//                            name token.
//   factTokenEcho         := distractors containing the subject or answer name
//                            token and NOT already counted as a bridge
//                            collision (the two categories are disjoint).
// Committed output: bench/lab/multihop/measure-v2-knobs.output.txt.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const V2_DEV_INPUT = resolve(HERE, '..', 'datasets', 'multihop', 'v2', 'dev', 'input.jsonl');

const FIRST_HOP = /^(.*?) (?:is stored at|is assigned to|contains|is entrusted to|is maintained by) (.*?)\.$/;

interface DevInput {
  id: string;
  memories: ReadonlyArray<{ id: string; content: string }>;
  queries: ReadonlyArray<{ query: string }>;
  tags: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function secondHopPattern(bridge: string, family: string): RegExp {
  const escaped = escapeRegExp(bridge);
  const patterns: Record<string, RegExp> = {
    routing: new RegExp(`^${escaped} sends .+ to (.+)\\.$`, 'i'),
    assignment: new RegExp(`^${escaped} starts .+ at (.+)\\.$`, 'i'),
    component: new RegExp(`^${escaped} requires (.+) for .+\\.$`, 'i'),
    custody: new RegExp(`^${escaped} requires (.+) for .+\\.$`, 'i'),
    maintenance: new RegExp(`^${escaped} files .+ at (.+)\\.$`, 'i'),
  };
  const pattern = patterns[family];
  if (!pattern) throw new Error(`unknown family: ${family}`);
  return pattern;
}

/**
 * Alphabetic core of the LAST capitalized word of a chain phrase; when the
 * phrase carries no capitalized word (numeric answers such as
 * "the 09:10 review window"), the LAST digit-bearing token instead.
 */
function nameToken(phrase: string): string {
  const capitalized = phrase.match(/\b[A-Z][A-Za-z']*\b/g);
  if (capitalized && capitalized.length > 0) return capitalized[capitalized.length - 1]!;
  const numeric = phrase.match(/\b[\d:]+\b/g);
  if (numeric && numeric.length > 0) return numeric[numeric.length - 1]!;
  // Common-noun answers (e.g. "ceramic shield") carry no single name token;
  // the whole phrase is the fact token.
  return phrase;
}

function containsToken(content: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}(?:-\\d+)?\\b`).test(content);
}

function oneTag(input: DevInput, prefix: string): string {
  const values = input.tags.filter((tag) => tag.startsWith(prefix));
  if (values.length !== 1) throw new Error(`${input.id}: requires exactly one ${prefix} tag`);
  return values[0]!.slice(prefix.length);
}

async function main(): Promise<void> {
  const raw = await readFile(V2_DEV_INPUT, 'utf8');
  const inputs = raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as DevInput);
  if (inputs.length !== 20) throw new Error(`expected 20 v2 dev scenarios, found ${inputs.length}`);

  const perDensity = new Map<string, Array<{ id: string; bridge: number; echo: number }>>();
  const lines: string[] = [];
  lines.push('RET-007 v3 knob measurement over bench/lab/datasets/multihop/v2/dev/input.jsonl (oracle-free)');
  lines.push('');

  for (const input of inputs) {
    const family = oneTag(input, 'family:');
    const density = oneTag(input, 'density:');
    const query = input.queries[0]!.query.toLowerCase();
    if (input.memories.length !== 24) throw new Error(`${input.id}: expected 24 memories`);

    const chains: Array<{ first: string; second: string; subject: string; bridge: string; answer: string }> = [];
    for (const memory of input.memories) {
      const match = memory.content.match(FIRST_HOP);
      if (!match) continue;
      const subject = match[1]!;
      const bridge = match[2]!;
      if (!query.includes(subject.toLowerCase())) continue;
      const pattern = secondHopPattern(bridge, family);
      for (const candidate of input.memories) {
        if (candidate.id === memory.id) continue;
        const secondMatch = candidate.content.match(pattern);
        if (secondMatch) {
          chains.push({ first: memory.id, second: candidate.id, subject, bridge, answer: secondMatch[1]! });
        }
      }
    }
    if (chains.length !== 1) {
      throw new Error(`${input.id}: chain detection is not unique (${chains.length} candidate chains) — STOP`);
    }
    const chain = chains[0]!;
    const subjectName = nameToken(chain.subject);
    const bridgeName = nameToken(chain.bridge);
    const answerName = nameToken(chain.answer);
    if (query.includes(chain.answer.toLowerCase())) throw new Error(`${input.id}: query leaks the answer — STOP`);

    const chainIds = new Set([chain.first, chain.second]);
    const distractors = input.memories.filter(({ id }) => !chainIds.has(id));
    for (const { content } of distractors) {
      const text = content.toLowerCase();
      if (text.includes(chain.subject.toLowerCase()) && text.includes(chain.bridge.toLowerCase())) {
        throw new Error(`${input.id}: distractor pairs subject with bridge — detection unsound — STOP`);
      }
      if (text.includes(chain.bridge.toLowerCase()) && text.includes(chain.answer.toLowerCase())) {
        throw new Error(`${input.id}: distractor pairs bridge with answer — detection unsound — STOP`);
      }
    }

    const bridgeCollisions = distractors.filter(({ content }) => containsToken(content, bridgeName));
    const bridgeIds = new Set(bridgeCollisions.map(({ id }) => id));
    const echoes = distractors.filter(({ id, content }) => !bridgeIds.has(id)
      && (containsToken(content, subjectName) || containsToken(content, answerName)));

    const entry = { id: input.id, bridge: bridgeCollisions.length, echo: echoes.length };
    perDensity.set(density, [...(perDensity.get(density) ?? []), entry]);
    lines.push(`${input.id} family=${family} density=${density} `
      + `chain=${subjectName}->${bridgeName}->${answerName} `
      + `bridgeTokenCollisions=${entry.bridge} factTokenEcho=${entry.echo}`);
  }

  lines.push('');
  lines.push('Per-density summary (v2 dev; knob upper bounds take the per-density MAXIMUM):');
  for (const density of ['low', 'medium', 'high']) {
    const entries = perDensity.get(density) ?? [];
    const bridges = entries.map(({ bridge }) => bridge);
    const echoes = entries.map(({ echo }) => echo);
    const summary = (values: number[]) => `min=${Math.min(...values)} max=${Math.max(...values)} `
      + `values=[${values.join(',')}]`;
    lines.push(`density=${density} n=${entries.length}`);
    lines.push(`  bridgeTokenCollisions ${summary(bridges)}`);
    lines.push(`  factTokenEcho ${summary(echoes)}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
