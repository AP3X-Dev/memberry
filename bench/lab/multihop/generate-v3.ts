// RET-007 v3 — deterministic committed generator for the three v3 splits.
//
// Pure function of (MULTIHOP_V3_KNOBS, split, fixed seed strings): no Date, no
// Math.random, no environment reads. The PRNG is a sha256 counter over fixed
// seed strings; regenerating with the committed knobs MUST byte-reproduce the
// committed artifacts (asserted by __tests__/generate-v3.test.ts for ALL THREE
// splits).
//
// Scenario contract: identical to v2 (LabScenario 1.0.0) with v3 identity —
// scenario ids ^mh3-(c|d|h)-\d{2}$, opaque memory ids m3-<24hex>, opaque probe
// ids p3-<24hex>, five v2 relation families, one two-hop chain A -> bridge -> B
// plus knob-governed distractors, tenant synthetic-ret007v3, per-scenario
// project synthetic-mh3-<split>-<nn>, six tags re-keyed to
// lab-ret007-candidate-blind-v3.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MULTIHOP_V3_CALIB_PROBES,
  MULTIHOP_V3_FREEZE,
  MULTIHOP_V3_K,
  MULTIHOP_V3_KNOBS,
  MULTIHOP_V3_PROBES_PER_SPLIT,
  validateMultiHopV3Knobs,
  type MultiHopV3Density,
  type MultiHopV3Knobs,
} from './policy-v3.js';

// Import-time knob custody (spec: "the generator validates its knobs against
// them at import time").
validateMultiHopV3Knobs(MULTIHOP_V3_KNOBS);

export type MultiHopV3Split = 'calib' | 'dev' | 'holdout';

const GENERATOR_SEEDS = Object.freeze({
  calib: 'memberry-ret007-v3-generate-calib-2026-08-25',
  dev: 'memberry-ret007-v3-generate-dev-2026-08-25',
  holdout: 'memberry-ret007-v3-generate-holdout-2026-08-25',
} as const satisfies Record<MultiHopV3Split, string>);

const SPLIT_LETTERS = Object.freeze({ calib: 'c', dev: 'd', holdout: 'h' } as const);
const SPLIT_DATES = Object.freeze({ calib: '2026-05-01', dev: '2026-06-01', holdout: '2026-07-01' } as const);
const FAMILIES = Object.freeze(['routing', 'assignment', 'component', 'custody', 'maintenance'] as const);
type MultiHopV3Family = (typeof FAMILIES)[number];

/** Split layout: probe count, density order, and the domain/form window offset. */
const SPLIT_LAYOUT = Object.freeze({
  calib: { probes: MULTIHOP_V3_CALIB_PROBES, densities: Object.freeze({ low: 5, medium: 5, high: 5 }), groupOffset: 0, groups: 8 },
  dev: { probes: MULTIHOP_V3_PROBES_PER_SPLIT, densities: Object.freeze({ low: 7, medium: 7, high: 6 }), groupOffset: 8, groups: 10 },
  holdout: { probes: MULTIHOP_V3_PROBES_PER_SPLIT, densities: Object.freeze({ low: 7, medium: 7, high: 6 }), groupOffset: 18, groups: 10 },
} as const);

interface MultiHopV3Domain {
  readonly tag: string;
  readonly subjectType: string;
  readonly bridgeType: string;
  readonly answerType: string;
}

// 28 domains: calib uses [0..7], dev [8..17], holdout [18..27] — three-way
// disjoint domain tags by construction, with distinct type-noun triples.
const DOMAINS: readonly MultiHopV3Domain[] = Object.freeze([
  { tag: 'apiary', subjectType: 'hive frame', bridgeType: 'apiary shed', answerType: 'extraction room' },
  { tag: 'pottery', subjectType: 'glaze batch', bridgeType: 'kiln yard', answerType: 'cooling rack' },
  { tag: 'vineyard', subjectType: 'barrel lot', bridgeType: 'cellar vault', answerType: 'tasting annex' },
  { tag: 'observatory', subjectType: 'lens crate', bridgeType: 'dome platform', answerType: 'archive cabin' },
  { tag: 'bakery', subjectType: 'flour sack', bridgeType: 'proofing chamber', answerType: 'delivery van' },
  { tag: 'aquarium', subjectType: 'coral tray', bridgeType: 'quarantine tank', answerType: 'display wing' },
  { tag: 'printworks', subjectType: 'ink drum', bridgeType: 'press hall', answerType: 'binding station' },
  { tag: 'orchard', subjectType: 'fruit bin', bridgeType: 'grading barn', answerType: 'cider house' },
  { tag: 'foundry', subjectType: 'casting mold', bridgeType: 'furnace bay', answerType: 'polishing bench' },
  { tag: 'herbarium', subjectType: 'specimen folder', bridgeType: 'drying loft', answerType: 'reference vault' },
  { tag: 'planetarium', subjectType: 'projector cart', bridgeType: 'staging alcove', answerType: 'control mezzanine' },
  { tag: 'tannery', subjectType: 'leather roll', bridgeType: 'soaking pit', answerType: 'finishing gallery' },
  { tag: 'brewery', subjectType: 'malt pallet', bridgeType: 'fermentation cellar', answerType: 'bottling line' },
  { tag: 'clockworks', subjectType: 'gear tray', bridgeType: 'assembly bench', answerType: 'testing booth' },
  { tag: 'dairy', subjectType: 'cheese wheel', bridgeType: 'ripening cave', answerType: 'wax room' },
  { tag: 'glassworks', subjectType: 'silica batch', bridgeType: 'annealing oven', answerType: 'inspection deck' },
  { tag: 'ropewalk', subjectType: 'fiber bale', bridgeType: 'twisting shed', answerType: 'coiling yard' },
  { tag: 'mint', subjectType: 'blank coil', bridgeType: 'striking room', answerType: 'audit cage' },
  { tag: 'papermill', subjectType: 'pulp vat', bridgeType: 'screening deck', answerType: 'drying corridor' },
  { tag: 'saltern', subjectType: 'brine pan', bridgeType: 'evaporation terrace', answerType: 'bagging hut' },
  { tag: 'lighthouse', subjectType: 'lamp assembly', bridgeType: 'service landing', answerType: 'signal store' },
  { tag: 'weaving', subjectType: 'warp beam', bridgeType: 'loom bay', answerType: 'mending parlor' },
  { tag: 'candleworks', subjectType: 'wax block', bridgeType: 'dipping room', answerType: 'trimming counter' },
  { tag: 'seedbank', subjectType: 'accession packet', bridgeType: 'cold aisle', answerType: 'catalog office' },
  { tag: 'cooperage', subjectType: 'stave bundle', bridgeType: 'steam box', answerType: 'hooping floor' },
  { tag: 'distillery', subjectType: 'grain hopper', bridgeType: 'still house', answerType: 'cask cellar' },
  { tag: 'icehouse', subjectType: 'ice block', bridgeType: 'sawdust vault', answerType: 'loading ramp' },
  { tag: 'bindery', subjectType: 'folio stack', bridgeType: 'sewing frame', answerType: 'gilding table' },
]);

interface QueryFormContext {
  readonly stype: string;
  readonly sname: string;
  readonly btype: string;
  readonly atype: string;
}

// 28 query forms: calib uses [0..7], dev [8..17], holdout [18..27] — three-way
// disjoint form tags and (with all-distinct wording) lexical skeletons.
const QUERY_FORMS: ReadonlyArray<{ readonly tag: string; readonly render: (context: QueryFormContext) => string }> = Object.freeze([
  { tag: 'name-both-linked', render: ({ stype, sname, btype, atype }) => `For ${stype} ${sname}, name its ${btype} and the ${atype} linked through it.` },
  { tag: 'which-holds-then-feeds', render: ({ stype, sname, btype, atype }) => `Which ${btype} holds ${stype} ${sname}, and which ${atype} does it feed?` },
  { tag: 'trace-onward', render: ({ stype, sname, btype, atype }) => `Trace ${stype} ${sname} to its ${btype} and onward to the connected ${atype}.` },
  { tag: 'identify-then-points', render: ({ stype, sname, btype, atype }) => `Identify the ${btype} for ${stype} ${sname}, then the ${atype} it points to.` },
  { tag: 'locate-report-downstream', render: ({ stype, sname, btype, atype }) => `Locate ${stype} ${sname}; report the ${btype} involved and the downstream ${atype}.` },
  { tag: 'give-with-partner', render: ({ stype, sname, btype, atype }) => `Give the ${btype} assigned to ${stype} ${sname} together with its partner ${atype}.` },
  { tag: 'resolve-first-second', render: ({ stype, sname, btype, atype }) => `Starting from ${stype} ${sname}, resolve first the ${btype} and second the ${atype}.` },
  { tag: 'find-place-and-tied', render: ({ stype, sname, btype, atype }) => `Find where ${stype} ${sname} sits, meaning the ${btype}, plus the ${atype} tied to that place.` },
  { tag: 'name-both-reached', render: ({ stype, sname, btype, atype }) => `Name both the ${btype} for ${stype} ${sname} and the ${atype} reached from there.` },
  { tag: 'state-then-matching', render: ({ stype, sname, btype, atype }) => `State the ${btype} covering ${stype} ${sname}, then state the matching ${atype}.` },
  { tag: 'recorded-and-follows', render: ({ stype, sname, btype, atype }) => `Which ${btype} is recorded for ${stype} ${sname}, and what ${atype} follows from it?` },
  { tag: 'report-behind-onward', render: ({ stype, sname, btype, atype }) => `Report the ${btype} behind ${stype} ${sname} plus the ${atype} it connects onward to.` },
  { tag: 'lookup-first-afterwards', render: ({ stype, sname, btype, atype }) => `Look up ${stype} ${sname}: provide the ${btype} first and afterwards the ${atype}.` },
  { tag: 'after-finding-determine', render: ({ stype, sname, btype, atype }) => `After finding the ${btype} of ${stype} ${sname}, determine the associated ${atype}.` },
  { tag: 'resolve-two-step', render: ({ stype, sname, btype, atype }) => `Resolve the two-step link from ${stype} ${sname} through its ${btype} to the final ${atype}.` },
  { tag: 'tell-belongs-onward', render: ({ stype, sname, btype, atype }) => `Tell me the ${btype} where ${stype} ${sname} belongs and the onward ${atype}.` },
  { tag: 'provide-governing-dependent', render: ({ stype, sname, btype, atype }) => `Provide, for ${stype} ${sname}, the governing ${btype} and its dependent ${atype}.` },
  { tag: 'lists-and-completes', render: ({ stype, sname, btype, atype }) => `What ${btype} lists ${stype} ${sname}, and which ${atype} completes that chain?` },
  { tag: 'establish-before-terminal', render: ({ stype, sname, btype, atype }) => `Establish the ${btype} tied to ${stype} ${sname} before naming the terminal ${atype}.` },
  { tag: 'chase-then-surface', render: ({ stype, sname, btype, atype }) => `Chase ${stype} ${sname} into its ${btype}, then surface the corresponding ${atype}.` },
  { tag: 'derive-continue-resulting', render: ({ stype, sname, btype, atype }) => `From ${stype} ${sname}, derive the ${btype} and continue to the resulting ${atype}.` },
  { tag: 'show-handles-beyond', render: ({ stype, sname, btype, atype }) => `Show which ${btype} handles ${stype} ${sname} along with the ${atype} beyond it.` },
  { tag: 'determine-attached-afterwards', render: ({ stype, sname, btype, atype }) => `Determine the ${btype} attached to ${stype} ${sname} and afterwards its ${atype}.` },
  { tag: 'answer-two-parts', render: ({ stype, sname, btype, atype }) => `Answer in two parts: the ${btype} of ${stype} ${sname}, and the ${atype} past it.` },
  { tag: 'uncover-closing-with', render: ({ stype, sname, btype, atype }) => `Uncover the ${btype} registered against ${stype} ${sname}, closing with the ${atype}.` },
  { tag: 'walk-chain-far', render: ({ stype, sname, btype, atype }) => `Walk the chain for ${stype} ${sname}: the ${btype} first, the far ${atype} second.` },
  { tag: 'confirm-keeping-connected', render: ({ stype, sname, btype, atype }) => `Confirm the ${btype} keeping ${stype} ${sname} and then confirm the connected ${atype}.` },
  { tag: 'point-out-reachable', render: ({ stype, sname, btype, atype }) => `Point out the ${btype} that carries ${stype} ${sname}, ending at the reachable ${atype}.` },
]);

const HOP1_VERBS = Object.freeze({
  routing: 'is warehoused at',
  assignment: 'is rostered to',
  component: 'is fitted inside',
  custody: 'is safeguarded by',
  maintenance: 'is serviced by',
} as const satisfies Record<MultiHopV3Family, string>);

function hop2Content(family: MultiHopV3Family, btype: string, bname: string, atype: string, aname: string): string {
  const bridge = `${capitalize(btype)} ${bname}`;
  switch (family) {
    case 'routing': return `${bridge} forwards outbound freight to ${atype} ${aname}.`;
    case 'assignment': return `${bridge} opens its duty cycle at ${atype} ${aname}.`;
    case 'component': return `${bridge} depends on ${atype} ${aname} for stable operation.`;
    case 'custody': return `${bridge} keeps ${atype} ${aname} for controlled handling.`;
    case 'maintenance': return `${bridge} lodges upkeep records at ${atype} ${aname}.`;
  }
}

// Proper-noun pool. Per scenario, names are drawn without replacement and with
// a no-substring rule, so knob counts cannot be inflated by accidental token
// collisions.
const NAMES: readonly string[] = Object.freeze([
  'Alder', 'Basalt', 'Cinder', 'Dorian', 'Emberly', 'Fjord', 'Garnet', 'Hollis',
  'Ingram', 'Juniper', 'Kestrel', 'Larkspur', 'Meridian', 'Nimbus', 'Ochre', 'Peregrine',
  'Quartz', 'Rowan', 'Saffron', 'Tamarind', 'Umberto', 'Verbena', 'Wexford', 'Yarrow',
  'Zephyr', 'Aurelia', 'Briony', 'Caldera', 'Damson', 'Eldwin', 'Fennel', 'Gossamer',
  'Halcyon', 'Isolde', 'Jacinth', 'Kelpline', 'Lunaris', 'Mistral', 'Nocturne', 'Opaline',
  'Pimento', 'Quillon', 'Rosalind', 'Sorrel', 'Thistle', 'Umbriel', 'Vesper', 'Winnow',
  'Xanthe', 'Yewbark', 'Zinnia', 'Ashcombe', 'Bellamy', 'Corvid', 'Dunmore', 'Everly',
  'Falchion', 'Gadwall', 'Hartley', 'Ivorine', 'Jessamy', 'Kirtland', 'Lowther', 'Marlow',
  'Norwich', 'Osprey', 'Pendrell', 'Quenby', 'Redpoll', 'Selborne', 'Tanager', 'Ullswater',
  'Vireo', 'Wagtail', 'Xylona', 'Yellowham', 'Zircon', 'Arbutus', 'Bracken', 'Cormorant',
]);

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Deterministic PRNG: a sha256 counter over a fixed seed string. */
function createPrng(seed: string): (bound: number) => number {
  let counter = 0;
  let buffer: Buffer = Buffer.alloc(0);
  let offset = 0;
  return (bound: number): number => {
    if (!Number.isInteger(bound) || bound <= 0) throw new Error(`invalid PRNG bound: ${bound}`);
    // Rejection sampling over uint32 keeps the draw unbiased and deterministic.
    const limit = Math.floor(0x1_0000_0000 / bound) * bound;
    for (;;) {
      if (offset + 4 > buffer.length) {
        buffer = createHash('sha256').update(`${seed}\n${counter}`, 'utf8').digest();
        counter += 1;
        offset = 0;
      }
      const value = buffer.readUInt32BE(offset);
      offset += 4;
      if (value < limit) return value % bound;
    }
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Public frozen order key — identical derivation to v2 with the v3 seed. */
export function multiHopV3OrderKey(scenarioId: string, neutralSlotId: string): string {
  return sha256Hex(`${MULTIHOP_V3_FREEZE.publicOrderSeed}\n${scenarioId}\n${neutralSlotId}`);
}

function ordinalCompare(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface GeneratedMemory {
  readonly id: string;
  readonly content: string;
}

function drawNames(scenarioSeed: string, count: number): string[] {
  const next = createPrng(`${scenarioSeed}\nnames`);
  const drawn: string[] = [];
  const remaining = [...NAMES];
  while (drawn.length < count) {
    if (remaining.length === 0) throw new Error('name pool exhausted');
    const index = next(remaining.length);
    const candidate = remaining.splice(index, 1)[0]!;
    if (drawn.some((name) => name.includes(candidate) || candidate.includes(name))) continue;
    drawn.push(candidate);
  }
  return drawn;
}

function densityOfIndex(layout: (typeof SPLIT_LAYOUT)[MultiHopV3Split], index: number): MultiHopV3Density {
  if (index < layout.densities.low) return 'low';
  if (index < layout.densities.low + layout.densities.medium) return 'medium';
  return 'high';
}

interface GeneratedScenario {
  readonly inputLine: string;
  readonly oracleLine: string;
}

function generateScenario(
  split: MultiHopV3Split,
  index: number,
  knobs: MultiHopV3Knobs,
): GeneratedScenario {
  const layout = SPLIT_LAYOUT[split];
  const nn = String(index + 1).padStart(2, '0');
  const scenarioId = `mh3-${SPLIT_LETTERS[split]}-${nn}`;
  const scenarioSeed = `${GENERATOR_SEEDS[split]}\n${scenarioId}`;
  const density = densityOfIndex(layout, index);
  const family = FAMILIES[index % FAMILIES.length]!;
  const group = layout.groupOffset + Math.floor(index / 2);
  const domain = DOMAINS[group]!;
  const form = QUERY_FORMS[group]!;

  const corpusSize = knobs.corpusSizePerScenario;
  const distractorCount = corpusSize - 2;
  const bridgeCollisions = knobs.bridgeTokenCollisions[density];
  const echoes = knobs.factTokenEcho[density];
  const domainVocabTarget = Math.round(knobs.domainLexicalOverlapShare[density] * distractorCount);
  const structuredDomainCount = 2 + bridgeCollisions + echoes;
  if (domainVocabTarget < structuredDomainCount || domainVocabTarget > distractorCount) {
    throw new Error(`${scenarioId}: knob composition infeasible `
      + `(domain-vocab target ${domainVocabTarget}, structured minimum ${structuredDomainCount}, distractors ${distractorCount})`);
  }
  const extraDomainCount = domainVocabTarget - structuredDomainCount;
  const genericCount = distractorCount - domainVocabTarget;

  const fillerNames = extraDomainCount + genericCount;
  const names = drawNames(scenarioSeed, 6 + fillerNames);
  const [sname, bname, aname, altS, altB, altA] = names as [string, string, string, string, string, string];
  const filler = names.slice(6);

  const contents: string[] = [];
  // Chain hops (construction indices 0 and 1).
  contents.push(`${capitalize(domain.subjectType)} ${sname} ${HOP1_VERBS[family]} ${domain.bridgeType} ${bname}.`);
  contents.push(hop2Content(family, domain.bridgeType, bname, domain.answerType, aname));
  // Alternative chain (always present; domain-vocabulary distractors).
  contents.push(`${capitalize(domain.subjectType)} ${altS} ${HOP1_VERBS[family]} ${domain.bridgeType} ${altB}.`);
  contents.push(hop2Content(family, domain.bridgeType, altB, domain.answerType, altA));
  // Bridge-token collisions: reuse the chain bridge name in a non-bridge composite.
  const bridgeVariants = [
    `A ${domain.tag} bulletin noted station ${bname}-01 during rounds.`,
    `The weekly ${domain.tag} digest referenced station ${bname}-02.`,
  ];
  for (let k = 0; k < bridgeCollisions; k += 1) contents.push(bridgeVariants[k]!);
  // Fact-token echoes: reuse the subject or answer name outside the chain relation.
  const echoVariants = [
    `The ${domain.tag} register listed ${domain.subjectType} ${sname} for periodic review.`,
    `A stocktake memo cited ${domain.answerType} ${aname} during the ${domain.tag} audit.`,
    `A quarterly ${domain.tag} digest mentioned ${domain.subjectType} ${sname} with no changes.`,
    `The ${domain.tag} planning sheet named ${domain.answerType} ${aname} as unchanged.`,
  ];
  for (let k = 0; k < echoes; k += 1) contents.push(echoVariants[k]!);
  // Remaining domain-vocabulary distractors (fresh names).
  const extraTemplates = [
    (name: string) => `${capitalize(domain.subjectType)} ${name} passed its scheduled ${domain.tag} inspection.`,
    (name: string) => `${capitalize(domain.bridgeType)} ${name} completed a routine ${domain.tag} drill.`,
    (name: string) => `${capitalize(domain.answerType)} ${name} remains reserved for ${domain.tag} training.`,
    (name: string) => `The ${domain.tag} register logged ${domain.subjectType} ${name} for archival.`,
    (name: string) => `A maintenance card for ${domain.bridgeType} ${name} was filed without remarks.`,
    (name: string) => `Seasonal notes describe ${domain.answerType} ${name} as idle.`,
  ];
  for (let k = 0; k < extraDomainCount; k += 1) {
    contents.push(extraTemplates[k % extraTemplates.length]!(filler[k]!));
  }
  // Lexically-distant generic distractors (v1 style; no domain vocabulary).
  const genericTemplates = [
    (name: string) => `Visitor badge ${name} was returned to the front desk.`,
    (name: string) => `Courier slip ${name} awaits a countersignature.`,
    (name: string) => `Umbrella stand ${name} was moved beside the lobby door.`,
    (name: string) => `Notice board ${name} lists next month's holidays.`,
    (name: string) => `Spare key ${name} hangs in the porter's cabinet.`,
    (name: string) => `Lost-property box ${name} holds one unclaimed scarf.`,
    (name: string) => `Coffee urn ${name} was descaled on Friday.`,
    (name: string) => `Bicycle rack ${name} gained a new weather cover.`,
    (name: string) => `Guest ledger ${name} closed with no entries.`,
    (name: string) => `Window latch ${name} was oiled during the quiet hour.`,
    (name: string) => `Stairwell lamp ${name} received a fresh bulb.`,
    (name: string) => `Postal tray ${name} was emptied before noon.`,
  ];
  for (let k = 0; k < genericCount; k += 1) {
    contents.push(genericTemplates[k % genericTemplates.length]!(filler[extraDomainCount + k]!));
  }
  if (contents.length !== corpusSize) throw new Error(`${scenarioId}: corpus composition drifted`);

  const memories: GeneratedMemory[] = contents.map((content, construction) => ({
    id: `m3-${sha256Hex(`${scenarioSeed}\nmemory\n${construction}`).slice(0, 24)}`,
    content,
  }));
  // Role-neutral recordedAt: a PRNG permutation over construction order.
  const hourPrng = createPrng(`${scenarioSeed}\nhours`);
  const hours = memories.map((_, position) => position);
  for (let position = hours.length - 1; position > 0; position -= 1) {
    const swap = hourPrng(position + 1);
    [hours[position], hours[swap]] = [hours[swap]!, hours[position]!];
  }
  const recordedAt = new Map(memories.map((memory, position) => [
    memory.id,
    `${SPLIT_DATES[split]}T${String(hours[position]!).padStart(2, '0')}:00:00.000Z`,
  ]));

  const ordered = [...memories].sort((left, right) => (
    ordinalCompare(multiHopV3OrderKey(scenarioId, left.id), multiHopV3OrderKey(scenarioId, right.id))
      || ordinalCompare(left.id, right.id)
  ));

  const probeId = `p3-${sha256Hex(`${scenarioSeed}\nprobe`).slice(0, 24)}`;
  const query = form.render({
    stype: domain.subjectType, sname, btype: domain.bridgeType, atype: domain.answerType,
  });

  const input = {
    version: '1.0.0',
    id: scenarioId,
    split,
    title: `${capitalize(domain.tag)} chain trace ${nn}`,
    description: `Candidate-blind synthetic two-hop ${domain.tag} probe with ${density} distractor density.`,
    dimensions: ['multi-hop'],
    tenant: 'synthetic-ret007v3',
    project: `synthetic-${scenarioId}`,
    memories: ordered.map(({ id, content }) => ({ id, content, recordedAt: recordedAt.get(id)! })),
    queries: [{ id: probeId, query, limit: MULTIHOP_V3_K }],
    tags: [
      'synthetic',
      'lab-ret007-candidate-blind-v3',
      `domain:${domain.tag}`,
      `family:${family}`,
      `query-form:${form.tag}`,
      `density:${density}`,
    ],
  };
  const oracle = {
    version: '1.0.0',
    scenarioId,
    probes: [{
      probeId,
      relevant: [memories[0]!.id, memories[1]!.id],
      required: [memories[0]!.id, memories[1]!.id],
    }],
  };
  return { inputLine: JSON.stringify(input), oracleLine: JSON.stringify(oracle) };
}

export interface MultiHopV3GeneratedSplit {
  readonly input: string;
  readonly oracle: string;
}

/** Pure deterministic emission of one split from the given knob values. */
export function generateMultiHopV3Split(
  split: MultiHopV3Split,
  knobs: MultiHopV3Knobs = MULTIHOP_V3_KNOBS,
): MultiHopV3GeneratedSplit {
  validateMultiHopV3Knobs(knobs);
  const layout = SPLIT_LAYOUT[split];
  const scenarios = Array.from({ length: layout.probes }, (_, index) => generateScenario(split, index, knobs));
  return {
    input: `${scenarios.map(({ inputLine }) => inputLine).join('\n')}\n`,
    oracle: `${scenarios.map(({ oracleLine }) => oracleLine).join('\n')}\n`,
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DATASET_ROOT = resolve(HERE, '..', 'datasets', 'multihop', 'v3');

async function main(): Promise<void> {
  for (const split of ['calib', 'dev', 'holdout'] as const) {
    const generated = generateMultiHopV3Split(split, MULTIHOP_V3_KNOBS);
    const directory = resolve(DATASET_ROOT, split);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'input.jsonl'), generated.input, 'utf8');
    await writeFile(resolve(directory, 'oracle.jsonl'), generated.oracle, 'utf8');
    process.stdout.write(`${split}: ${generated.input.length} input bytes, ${generated.oracle.length} oracle bytes\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
