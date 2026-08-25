// RET-007 v4 — deterministic committed generator for the FOUR v4 splits
// (calib, dev, holdout, twin). Spec: docs/agent-runs/specs/2026-08-25-ret007-v4-instrument.md,
// "Generator (generate-v4.ts) — shared pool, stratified draws, scenario-level disjointness".
//
// Pure function of (MULTIHOP_V4_KNOBS, split, fixed seed strings): no Date, no
// Math.random, no environment reads. PRNG = sha256 counter over fixed seed
// strings. Regenerating with the committed knobs MUST byte-reproduce the
// committed artifacts for ALL FOUR splits (asserted by __tests__/generate-v4.test.ts).
//
// Departures from v3 (all pre-registered):
//   - SHARED POOL: all 28 domains and all 28 query forms are available to every
//     split; SPLIT_LAYOUT.groupOffset and the domain blocks are DELETED (failed
//     attempt "v3 instrument": difficulty became a property of the domain block).
//   - Query form is drawn INDEPENDENTLY of domain by the per-split PRNG.
//   - Every (family x density) cell is filled to MULTIHOP_V4_CELL_COUNTS,
//     PRNG-ordered within the density block.
//   - (domain, family, query-form) triples are globally unique across all 235
//     scenarios; name draws are globally disjoint across scenarios (compound
//     name pool, 80 x 79 = 6320 names).
//   - C1: at most ONE bridge clone per scenario, matching the bridge by
//     prefix/suffix only (`Name-01`), never an exact match.
//   - C2 (i)-(iv) hard assertions on every scenario (bite-tested).
//   - C3: the twin split is BROKEN-BRIDGE (bridge token in A replaced by a
//     fresh unused name; B intact; required ids unchanged).
//
// Scenario contract: LabScenario 1.0.0 with v4 identity — scenario ids
// ^mh4-(c|d|h|t)-\d{2,3}$, opaque memory ids m4-<24hex>, opaque probe ids
// p4-<24hex>, tenant synthetic-ret007v4, project synthetic-<scenario id>, six
// tags re-keyed to lab-ret007-candidate-blind-v4.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MULTIHOP_V4_BATTERY,
  MULTIHOP_V4_CELL_COUNTS,
  MULTIHOP_V4_DENSITIES,
  MULTIHOP_V4_DISTRACTOR_PROBE_OVERLAP_BAND,
  MULTIHOP_V4_FAMILIES,
  MULTIHOP_V4_FREEZE,
  MULTIHOP_V4_K,
  MULTIHOP_V4_KNOBS,
  MULTIHOP_V4_PROBES,
  MULTIHOP_V4_SPLITS,
  validateMultiHopV4Knobs,
  type MultiHopV4Density,
  type MultiHopV4Family,
  type MultiHopV4Knobs,
  type MultiHopV4Split,
} from './policy-v4.js';

// Import-time knob custody.
validateMultiHopV4Knobs(MULTIHOP_V4_KNOBS);

const GENERATOR_SEEDS = Object.freeze({
  calib: 'memberry-ret007-v4-generate-calib-2026-08-25',
  dev: 'memberry-ret007-v4-generate-dev-2026-08-25',
  holdout: 'memberry-ret007-v4-generate-holdout-2026-08-25',
  twin: 'memberry-ret007-v4-generate-twin-2026-08-25',
} as const satisfies Record<MultiHopV4Split, string>);

const SPLIT_LETTERS = Object.freeze({ calib: 'c', dev: 'd', holdout: 'h', twin: 't' } as const);
const SPLIT_DATES = Object.freeze({ calib: '2026-05-01', dev: '2026-06-01', holdout: '2026-07-01', twin: '2026-08-01' } as const);

export interface MultiHopV4Domain {
  readonly tag: string;
  readonly subjectType: string;
  readonly bridgeType: string;
  readonly answerType: string;
}

/** 28 domains — ONE shared pool for every split. */
export const MULTIHOP_V4_DOMAINS: readonly MultiHopV4Domain[] = Object.freeze([
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
}

/**
 * 28 query forms — ONE shared pool, drawn independently of the domain. Every
 * form is X-only (C2 iii): it names the subject and the bridge TYPE and asks
 * for the chain's end WITHOUT naming the answer or the answer's type.
 */
export const MULTIHOP_V4_QUERY_FORMS: ReadonlyArray<{ readonly tag: string; readonly render: (context: QueryFormContext) => string }> = Object.freeze([
  { tag: 'name-both-linked', render: ({ stype, sname, btype }) => `For ${stype} ${sname}, name its ${btype} and the place reached through it.` },
  { tag: 'which-holds-then-leads', render: ({ stype, sname, btype }) => `Which ${btype} holds ${stype} ${sname}, and where does that ${btype} lead next?` },
  { tag: 'trace-onward', render: ({ stype, sname, btype }) => `Trace ${stype} ${sname} to its ${btype} and onward to the next link.` },
  { tag: 'identify-then-points', render: ({ stype, sname, btype }) => `Identify the ${btype} for ${stype} ${sname}, then whatever it points to.` },
  { tag: 'locate-report-downstream', render: ({ stype, sname, btype }) => `Locate ${stype} ${sname}; report the ${btype} involved and its downstream stop.` },
  { tag: 'give-with-partner', render: ({ stype, sname, btype }) => `Give the ${btype} assigned to ${stype} ${sname} together with its partner site.` },
  { tag: 'resolve-first-second', render: ({ stype, sname, btype }) => `Starting from ${stype} ${sname}, resolve first the ${btype} and second its onward site.` },
  { tag: 'find-place-and-tied', render: ({ stype, sname, btype }) => `Find where ${stype} ${sname} sits, meaning the ${btype}, plus whatever is tied to that place.` },
  { tag: 'name-both-reached', render: ({ stype, sname, btype }) => `Name both the ${btype} for ${stype} ${sname} and the site reached from there.` },
  { tag: 'state-then-leads', render: ({ stype, sname, btype }) => `State the ${btype} covering ${stype} ${sname}, then state what that ${btype} leads to.` },
  { tag: 'recorded-and-follows', render: ({ stype, sname, btype }) => `Which ${btype} is recorded for ${stype} ${sname}, and what follows from it?` },
  { tag: 'report-behind-onward', render: ({ stype, sname, btype }) => `Report the ${btype} behind ${stype} ${sname} plus the location it connects onward to.` },
  { tag: 'lookup-first-afterwards', render: ({ stype, sname, btype }) => `Look up ${stype} ${sname}: provide the ${btype} first and afterwards the next stop.` },
  { tag: 'after-finding-determine', render: ({ stype, sname, btype }) => `After finding the ${btype} of ${stype} ${sname}, determine the associated endpoint.` },
  { tag: 'resolve-two-step', render: ({ stype, sname, btype }) => `Resolve the two-step link from ${stype} ${sname} through its ${btype} to the final stop.` },
  { tag: 'tell-belongs-onward', render: ({ stype, sname, btype }) => `Tell me the ${btype} where ${stype} ${sname} belongs and the onward destination.` },
  { tag: 'provide-governing-dependent', render: ({ stype, sname, btype }) => `Provide, for ${stype} ${sname}, the governing ${btype} and its dependent site.` },
  { tag: 'lists-and-completes', render: ({ stype, sname, btype }) => `What ${btype} lists ${stype} ${sname}, and which place completes that chain?` },
  { tag: 'establish-before-terminal', render: ({ stype, sname, btype }) => `Establish the ${btype} tied to ${stype} ${sname} before naming the terminal site.` },
  { tag: 'chase-then-surface', render: ({ stype, sname, btype }) => `Chase ${stype} ${sname} into its ${btype}, then surface the corresponding endpoint.` },
  { tag: 'derive-continue-resulting', render: ({ stype, sname, btype }) => `From ${stype} ${sname}, derive the ${btype} and continue to the resulting location.` },
  { tag: 'show-handles-beyond', render: ({ stype, sname, btype }) => `Show which ${btype} handles ${stype} ${sname} along with whatever lies beyond it.` },
  { tag: 'determine-attached-afterwards', render: ({ stype, sname, btype }) => `Determine the ${btype} attached to ${stype} ${sname} and afterwards its next hop.` },
  { tag: 'answer-two-parts', render: ({ stype, sname, btype }) => `Answer in two parts: the ${btype} of ${stype} ${sname}, and the stop past it.` },
  { tag: 'uncover-closing-with', render: ({ stype, sname, btype }) => `Uncover the ${btype} registered against ${stype} ${sname}, closing with the last link.` },
  { tag: 'walk-chain-far', render: ({ stype, sname, btype }) => `Walk the chain for ${stype} ${sname}: the ${btype} first, the far end second.` },
  { tag: 'confirm-keeping-connected', render: ({ stype, sname, btype }) => `Confirm the ${btype} keeping ${stype} ${sname} and then confirm the connected site.` },
  { tag: 'point-out-reachable', render: ({ stype, sname, btype }) => `Point out the ${btype} that carries ${stype} ${sname}, ending at the reachable location.` },
]);

const HOP1_VERBS = Object.freeze({
  routing: 'is warehoused at',
  assignment: 'is rostered to',
  component: 'is fitted inside',
  custody: 'is safeguarded by',
  maintenance: 'is serviced by',
} as const satisfies Record<MultiHopV4Family, string>);

function hop2Content(family: MultiHopV4Family, btype: string, bname: string, atype: string, aname: string): string {
  const bridge = `${capitalize(btype)} ${bname}`;
  switch (family) {
    case 'routing': return `${bridge} forwards outbound freight to ${atype} ${aname}.`;
    case 'assignment': return `${bridge} opens its duty cycle at ${atype} ${aname}.`;
    case 'component': return `${bridge} depends on ${atype} ${aname} for stable operation.`;
    case 'custody': return `${bridge} keeps ${atype} ${aname} for controlled handling.`;
    case 'maintenance': return `${bridge} lodges upkeep records at ${atype} ${aname}.`;
  }
}

/** Alternative-chain second hop: different wording/length from B so alt-B never ties B exactly under BM25. */
function altHop2Content(family: MultiHopV4Family, btype: string, bname: string, atype: string, aname: string): string {
  const bridge = `${capitalize(btype)} ${bname}`;
  switch (family) {
    case 'routing': return `Freight leaving ${bridge} is booked through to ${atype} ${aname} on the evening run.`;
    case 'assignment': return `Crews rostered at ${bridge} report afterwards to ${atype} ${aname} for handover.`;
    case 'component': return `Without ${atype} ${aname} the ${bridge} cannot hold stable operation.`;
    case 'custody': return `Controlled items from ${bridge} are countersigned at ${atype} ${aname} each week.`;
    case 'maintenance': return `Upkeep tickets raised at ${bridge} are archived by ${atype} ${aname} monthly.`;
  }
}

const BASE_NAMES: readonly string[] = Object.freeze([
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
  'Ambrose', 'Beacon', 'Calloway', 'Dresden', 'Elmstead', 'Farrow', 'Greylock', 'Hawthorne',
  'Ironwood', 'Jasper',
]);

/**
 * Compound proper-noun pool (90 x 89 = 8010 single-token names such as
 * "Alderbasalt"). Names are drawn WITHOUT replacement across ALL scenarios of
 * ALL splits, so no proper name ever appears in two scenarios.
 */
export const MULTIHOP_V4_NAME_POOL: readonly string[] = Object.freeze(
  BASE_NAMES.flatMap((first) => BASE_NAMES.filter((second) => second !== first).map((second) => `${first}${second.toLowerCase()}`)),
);

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

/** Public frozen order key — identical derivation to v2/v3 with the v4 seed. */
export function multiHopV4OrderKey(scenarioId: string, neutralSlotId: string): string {
  return sha256Hex(`${MULTIHOP_V4_FREEZE.publicOrderSeed}\n${scenarioId}\n${neutralSlotId}`);
}

function ordinalCompare(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Same tokenizer as the funnel adapter (duplicated: the generator may not import adapters). */
export function multiHopV4Tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length >= 2);
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Extra domain-vocabulary distractor templates, drawn WITHOUT replacement per
// scenario by the split PRNG (so no two extras in one corpus share a lexical
// structure — repeated templates would tie exactly under BM25). `names` = how
// many fresh proper names each consumes. The mix spans subject-bearing,
// bridge-only, subject+bridge and answer-only wording so the funnel's ranking
// of B varies WITHIN a stratum rather than being fixed by it. 20 templates
// cover the maximum extra count (corpus 24, share 1, no clone, no echo = 20).
const EXTRA_TEMPLATES: ReadonlyArray<{ readonly names: 1 | 2; readonly render: (domain: MultiHopV4Domain, names: readonly string[]) => string }> = Object.freeze([
  { names: 1, render: (d, [n]) => `${capitalize(d.subjectType)} ${n} passed its scheduled ${d.tag} inspection.` },
  { names: 1, render: (d, [n]) => `The ${d.tag} register logged ${d.subjectType} ${n} for archival.` },
  { names: 2, render: (d, [n, m]) => `${capitalize(d.subjectType)} ${n} was moved beside ${d.bridgeType} ${m} for the ${d.tag} count.` },
  { names: 2, render: (d, [n, m]) => `${capitalize(d.bridgeType)} ${n} now stores ${d.subjectType} ${m} between shifts.` },
  { names: 2, render: (d, [n, m]) => `${capitalize(d.subjectType)} ${n} awaits collection at ${d.bridgeType} ${m}.` },
  { names: 1, render: (d, [n]) => `A damaged ${d.subjectType} ${n} was set aside for repair.` },
  { names: 1, render: (d, [n]) => `${capitalize(d.bridgeType)} ${n} completed a routine ${d.tag} drill.` },
  { names: 1, render: (d, [n]) => `${capitalize(d.bridgeType)} ${n} was repainted last spring.` },
  { names: 2, render: (d, [n, m]) => `${capitalize(d.subjectType)} ${n} and ${d.subjectType} ${m} share one ${d.tag} label.` },
  { names: 2, render: (d, [n, m]) => `Inventory shows ${d.subjectType} ${n} inside ${d.bridgeType} ${m}.` },
  { names: 1, render: (d, [n]) => `${capitalize(d.bridgeType)} ${n} is closed for cleaning today.` },
  { names: 1, render: (d, [n]) => `Staff count ${d.subjectType} ${n} every ${d.tag} morning.` },
  { names: 1, render: (d, [n]) => `${capitalize(d.answerType)} ${n} remains reserved for ${d.tag} training.` },
  { names: 1, render: (d, [n]) => `Seasonal notes describe ${d.answerType} ${n} as idle.` },
  { names: 1, render: (d, [n]) => `The ${d.tag} committee toured ${d.answerType} ${n} in spring.` },
  { names: 1, render: (d, [n]) => `A ${d.tag} bulletin praised ${d.answerType} ${n} for tidiness.` },
  { names: 1, render: (d, [n]) => `${capitalize(d.answerType)} ${n} gained a new noticeboard this year.` },
  { names: 1, render: (d, [n]) => `Visitors to the ${d.tag} gathered near ${d.answerType} ${n}.` },
  { names: 1, render: (d, [n]) => `The ${d.tag} almanac lists ${d.answerType} ${n} among the older ones.` },
  { names: 1, render: (d, [n]) => `Cleaning of ${d.answerType} ${n} is scheduled for the ${d.tag} holiday.` },
]);

const GENERIC_TEMPLATES: ReadonlyArray<(name: string) => string> = Object.freeze([
  (name) => `Visitor badge ${name} was returned to the front desk.`,
  (name) => `Courier slip ${name} awaits a countersignature.`,
  (name) => `Umbrella stand ${name} was moved beside the lobby door.`,
  (name) => `Notice board ${name} lists next month's holidays.`,
  (name) => `Spare key ${name} hangs in the porter's cabinet.`,
  (name) => `Lost-property box ${name} holds one unclaimed scarf.`,
  (name) => `Coffee urn ${name} was descaled on Friday.`,
  (name) => `Bicycle rack ${name} gained a new weather cover.`,
  (name) => `Guest ledger ${name} closed with no entries.`,
  (name) => `Window latch ${name} was oiled during the quiet hour.`,
  (name) => `Stairwell lamp ${name} received a fresh bulb.`,
  (name) => `Postal tray ${name} was emptied before noon.`,
]);

interface Composition {
  readonly corpusSize: number;
  readonly bridgeCollisions: number;
  readonly echoes: number;
  readonly extraDomainCount: number;
  readonly genericCount: number;
}

function composition(density: MultiHopV4Density, knobs: MultiHopV4Knobs, at: string): Composition {
  const corpusSize = knobs.corpusSizePerScenario;
  const distractorCount = corpusSize - 2;
  const bridgeCollisions = knobs.bridgeTokenCollisions[density];
  const echoes = knobs.factTokenEcho[density];
  const domainVocabTarget = Math.round(knobs.domainLexicalOverlapShare[density] * distractorCount);
  const structuredDomainCount = 2 + bridgeCollisions + echoes;
  if (domainVocabTarget < structuredDomainCount || domainVocabTarget > distractorCount) {
    throw new Error(`${at}: knob composition infeasible `
      + `(domain-vocab target ${domainVocabTarget}, structured minimum ${structuredDomainCount}, distractors ${distractorCount})`);
  }
  return {
    corpusSize,
    bridgeCollisions,
    echoes,
    extraDomainCount: domainVocabTarget - structuredDomainCount,
    genericCount: distractorCount - domainVocabTarget,
  };
}

export interface MultiHopV4ScenarioPlan {
  readonly split: MultiHopV4Split;
  readonly index: number;
  readonly density: MultiHopV4Density;
  readonly family: MultiHopV4Family;
  readonly domainIndex: number;
  readonly formIndex: number;
  readonly extraTemplateIndices: readonly number[];
  /** [subject, bridge, answer, altSubject, altBridge, altAnswer, ...filler, (twinBridge)] */
  readonly names: readonly string[];
}

/**
 * Plans ALL FOUR splits in fixed order (calib, dev, holdout, twin) so that
 * global uniqueness (triples, names) is a pure function of the knobs. Each
 * split's draws come from its own PRNG; only the USED sets are shared.
 */
export function planMultiHopV4Splits(knobs: MultiHopV4Knobs = MULTIHOP_V4_KNOBS): Readonly<Record<MultiHopV4Split, readonly MultiHopV4ScenarioPlan[]>> {
  validateMultiHopV4Knobs(knobs);
  const usedTriples = new Set<string>();
  const remainingNames = [...MULTIHOP_V4_NAME_POOL];
  const plans = {} as Record<MultiHopV4Split, MultiHopV4ScenarioPlan[]>;
  for (const split of MULTIHOP_V4_SPLITS) {
    const prng = createPrng(`${GENERATOR_SEEDS[split]}\nplan`);
    const cap = MULTIHOP_V4_BATTERY[split].cap;
    const domainCounts = new Map<number, number>();
    const formCounts = new Map<number, number>();
    const list: MultiHopV4ScenarioPlan[] = [];
    for (const density of MULTIHOP_V4_DENSITIES) {
      const cells = MULTIHOP_V4_CELL_COUNTS[split][density];
      const families: MultiHopV4Family[] = [];
      MULTIHOP_V4_FAMILIES.forEach((family, position) => {
        for (let k = 0; k < cells[position]!; k += 1) families.push(family);
      });
      // PRNG order within the density block (Fisher-Yates).
      for (let position = families.length - 1; position > 0; position -= 1) {
        const swap = prng(position + 1);
        [families[position], families[swap]] = [families[swap]!, families[position]!];
      }
      for (const family of families) {
        const index = list.length;
        const at = `${split}[${index}]`;
        let domainIndex = -1;
        let formIndex = -1;
        for (let attempt = 0; attempt < 10_000; attempt += 1) {
          // Domain and form are INDEPENDENT draws.
          const d = prng(MULTIHOP_V4_DOMAINS.length);
          const f = prng(MULTIHOP_V4_QUERY_FORMS.length);
          const triple = `${d}|${family}|${f}`;
          if ((domainCounts.get(d) ?? 0) >= cap || (formCounts.get(f) ?? 0) >= cap || usedTriples.has(triple)) continue;
          domainIndex = d;
          formIndex = f;
          usedTriples.add(triple);
          break;
        }
        if (domainIndex < 0) throw new Error(`${at}: cannot fill cell without a new domain (pool shortfall)`);
        domainCounts.set(domainIndex, (domainCounts.get(domainIndex) ?? 0) + 1);
        formCounts.set(formIndex, (formCounts.get(formIndex) ?? 0) + 1);
        const shape = composition(density, knobs, at);
        const extraTemplateIndices: number[] = [];
        const availableTemplates = EXTRA_TEMPLATES.map((_, position) => position);
        let extraNames = 0;
        for (let k = 0; k < shape.extraDomainCount; k += 1) {
          if (availableTemplates.length === 0) throw new Error(`${at}: extra template pool exhausted`);
          const template = availableTemplates.splice(prng(availableTemplates.length), 1)[0]!;
          extraTemplateIndices.push(template);
          extraNames += EXTRA_TEMPLATES[template]!.names;
        }
        const nameCount = 6 + extraNames + shape.genericCount + (split === 'twin' ? 1 : 0);
        const names: string[] = [];
        while (names.length < nameCount) {
          if (remainingNames.length === 0) throw new Error(`${at}: name pool exhausted`);
          const candidate = remainingNames.splice(prng(remainingNames.length), 1)[0]!;
          if (names.some((name) => name.includes(candidate) || candidate.includes(name))) continue;
          names.push(candidate);
        }
        list.push({ split, index, density, family, domainIndex, formIndex, extraTemplateIndices, names });
      }
    }
    if (list.length !== MULTIHOP_V4_PROBES[split]) throw new Error(`${split}: cell counts do not sum to the probe count`);
    plans[split] = list;
  }
  return plans;
}

export interface MultiHopV4InvariantInput {
  readonly query: string;
  readonly memories: ReadonlyArray<{ readonly id: string; readonly content: string }>;
  /** [A id, B id] */
  readonly required: readonly [string, string];
  readonly subjectName: string;
  readonly bridgeName: string;
  readonly answerName: string;
  readonly answerType: string;
  /** Present only for twin scenarios: the fresh name that replaced the bridge token in A. */
  readonly twinBridgeName?: string;
}

function exactNameMention(name: string): RegExp {
  return new RegExp(`(?:^|[^A-Za-z0-9-])${name}(?![A-Za-z0-9-])`);
}

function cloneMention(name: string): RegExp {
  return new RegExp(`\\b${name}-\\d{2}\\b`);
}

/**
 * C1 + C2 (i)-(iv) + C3 hard assertions. Called by the generator on every
 * emitted scenario; exported so the bite tests can feed it violating inputs.
 */
export function assertMultiHopV4ScenarioInvariants(input: MultiHopV4InvariantInput, at = 'scenario'): void {
  const { query, memories, required, subjectName, bridgeName, answerName, answerType, twinBridgeName } = input;
  const [aId, bId] = required;
  const a = memories.find(({ id }) => id === aId);
  const b = memories.find(({ id }) => id === bId);
  if (!a || !b) throw new Error(`${at}: required hop ids absent from corpus`);
  const requiredIds = new Set(required);
  // C2 (i): no single memory contains both X and Z.
  for (const memory of memories) {
    if (exactNameMention(subjectName).test(memory.content) && exactNameMention(answerName).test(memory.content)) {
      throw new Error(`${at}: C2(i) memory ${memory.id} names both the subject and the answer`);
    }
  }
  // C2 (ii) / C1: the bridge name appears exactly in A and B (B only for a twin) plus at most one prefix/suffix clone.
  const exactBridge = memories.filter(({ content }) => exactNameMention(bridgeName).test(content)).map(({ id }) => id);
  const expectedBridge = twinBridgeName === undefined ? [aId, bId] : [bId];
  if (exactBridge.length !== expectedBridge.length || expectedBridge.some((id) => !exactBridge.includes(id))) {
    throw new Error(`${at}: C2(ii) bridge name must appear exactly in ${twinBridgeName === undefined ? 'A and B' : 'B'}`);
  }
  const clones = memories.filter(({ content }) => cloneMention(bridgeName).test(content));
  if (clones.length > 1) throw new Error(`${at}: C1 more than one bridge clone`);
  if (clones.some(({ id }) => requiredIds.has(id))) throw new Error(`${at}: C1 bridge clone inside the chain`);
  // C3: twin — A carries the fresh name and nothing else does; B is intact.
  if (twinBridgeName !== undefined) {
    const fresh = memories.filter(({ content }) => exactNameMention(twinBridgeName).test(content)).map(({ id }) => id);
    if (fresh.length !== 1 || fresh[0] !== aId) throw new Error(`${at}: C3 twin bridge name must appear in A only`);
  }
  // C2 (iii): the probe is X-only.
  const probeTokens = multiHopV4Tokenize(query);
  const probeTokenSet = new Set(probeTokens);
  if (!probeTokenSet.has(subjectName.toLowerCase())) throw new Error(`${at}: C2(iii) probe must name the subject`);
  if (probeTokenSet.has(bridgeName.toLowerCase())) throw new Error(`${at}: C2(iii) probe names the bridge`);
  if (probeTokenSet.has(answerName.toLowerCase())) throw new Error(`${at}: C2(iii) probe names the answer`);
  if (twinBridgeName !== undefined && probeTokenSet.has(twinBridgeName.toLowerCase())) throw new Error(`${at}: C2(iii) probe names the twin bridge`);
  for (const token of multiHopV4Tokenize(answerType)) {
    if (probeTokenSet.has(token)) throw new Error(`${at}: C2(iii) probe names the answer type (${token})`);
  }
  // C2 (iv): every distractor's overlap with the probe lies inside the band.
  for (const memory of memories) {
    if (requiredIds.has(memory.id)) continue;
    const overlap = jaccard(multiHopV4Tokenize(memory.content), probeTokens);
    if (overlap < MULTIHOP_V4_DISTRACTOR_PROBE_OVERLAP_BAND.min || overlap > MULTIHOP_V4_DISTRACTOR_PROBE_OVERLAP_BAND.max) {
      throw new Error(`${at}: C2(iv) distractor ${memory.id} overlap ${overlap.toFixed(3)} outside the band`);
    }
  }
}

interface GeneratedMemory {
  readonly id: string;
  readonly content: string;
}

interface GeneratedScenario {
  readonly inputLine: string;
  readonly oracleLine: string;
}

function generateScenario(plan: MultiHopV4ScenarioPlan, knobs: MultiHopV4Knobs): GeneratedScenario {
  const { split, index, density, family } = plan;
  const width = String(MULTIHOP_V4_PROBES[split]).length;
  const nn = String(index + 1).padStart(width, '0');
  const scenarioId = `mh4-${SPLIT_LETTERS[split]}-${nn}`;
  const scenarioSeed = `${GENERATOR_SEEDS[split]}\n${scenarioId}`;
  const domain = MULTIHOP_V4_DOMAINS[plan.domainIndex]!;
  const form = MULTIHOP_V4_QUERY_FORMS[plan.formIndex]!;
  const shape = composition(density, knobs, scenarioId);
  const [sname, bname, aname, altS, altB, altA] = plan.names as unknown as [string, string, string, string, string, string];
  const twinBridge = split === 'twin' ? plan.names[plan.names.length - 1]! : undefined;
  const filler = plan.names.slice(6, twinBridge === undefined ? undefined : -1);
  let fillerCursor = 0;
  const takeNames = (count: number): string[] => {
    const taken = filler.slice(fillerCursor, fillerCursor + count);
    if (taken.length !== count) throw new Error(`${scenarioId}: filler name shortfall`);
    fillerCursor += count;
    return taken;
  };

  const contents: string[] = [];
  // Chain hops (construction indices 0 and 1). C3: the twin's A carries a fresh bridge name.
  contents.push(`${capitalize(domain.subjectType)} ${sname} ${HOP1_VERBS[family]} ${domain.bridgeType} ${twinBridge ?? bname}.`);
  contents.push(hop2Content(family, domain.bridgeType, bname, domain.answerType, aname));
  // Alternative chain (domain-vocabulary distractors; alt-B worded differently from B).
  contents.push(`${capitalize(domain.subjectType)} ${altS} ${HOP1_VERBS[family]} ${domain.bridgeType} ${altB}.`);
  contents.push(altHop2Content(family, domain.bridgeType, altB, domain.answerType, altA));
  // C1: at most one bridge clone, prefix/suffix only.
  if (shape.bridgeCollisions > 0) contents.push(`A ${domain.tag} bulletin noted post ${bname}-01 during rounds.`);
  // Fact-token echoes: the subject or answer name outside the chain relation (never both in one memory).
  const echoVariants = [
    `The ${domain.tag} register listed ${domain.subjectType} ${sname} for periodic review.`,
    `A stocktake memo cited ${domain.answerType} ${aname} during the ${domain.tag} audit.`,
    `A quarterly ${domain.tag} digest mentioned ${domain.subjectType} ${sname} with no changes.`,
    `The ${domain.tag} planning sheet named ${domain.answerType} ${aname} as unchanged.`,
  ];
  for (let k = 0; k < shape.echoes; k += 1) contents.push(echoVariants[k]!);
  // Extra domain-vocabulary distractors (PRNG-chosen templates, fresh names).
  for (const templateIndex of plan.extraTemplateIndices) {
    const template = EXTRA_TEMPLATES[templateIndex]!;
    contents.push(template.render(domain, takeNames(template.names)));
  }
  // Lexically-distant generic distractors.
  for (let k = 0; k < shape.genericCount; k += 1) {
    contents.push(GENERIC_TEMPLATES[k % GENERIC_TEMPLATES.length]!(takeNames(1)[0]!));
  }
  if (fillerCursor !== filler.length) throw new Error(`${scenarioId}: filler names not fully consumed`);
  if (contents.length !== shape.corpusSize) throw new Error(`${scenarioId}: corpus composition drifted`);

  const memories: GeneratedMemory[] = contents.map((content, construction) => ({
    id: `m4-${sha256Hex(`${scenarioSeed}\nmemory\n${construction}`).slice(0, 24)}`,
    content,
  }));
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
    ordinalCompare(multiHopV4OrderKey(scenarioId, left.id), multiHopV4OrderKey(scenarioId, right.id))
      || ordinalCompare(left.id, right.id)
  ));

  const probeId = `p4-${sha256Hex(`${scenarioSeed}\nprobe`).slice(0, 24)}`;
  const query = form.render({ stype: domain.subjectType, sname, btype: domain.bridgeType });

  assertMultiHopV4ScenarioInvariants({
    query,
    memories: ordered,
    required: [memories[0]!.id, memories[1]!.id],
    subjectName: sname,
    bridgeName: bname,
    answerName: aname,
    answerType: domain.answerType,
    ...(twinBridge === undefined ? {} : { twinBridgeName: twinBridge }),
  }, scenarioId);

  const input = {
    version: '1.0.0',
    id: scenarioId,
    split,
    title: `${capitalize(domain.tag)} chain trace ${nn}`,
    description: split === 'twin'
      ? `Candidate-blind synthetic broken-bridge ${domain.tag} twin with ${density} distractor density (diagnostic only).`
      : `Candidate-blind synthetic two-hop ${domain.tag} probe with ${density} distractor density.`,
    dimensions: ['multi-hop'],
    tenant: 'synthetic-ret007v4',
    project: `synthetic-${scenarioId}`,
    memories: ordered.map(({ id, content }) => ({ id, content, recordedAt: recordedAt.get(id)! })),
    queries: [{ id: probeId, query, limit: MULTIHOP_V4_K }],
    tags: [
      'synthetic',
      'lab-ret007-candidate-blind-v4',
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

export interface MultiHopV4GeneratedSplit {
  readonly input: string;
  readonly oracle: string;
}

/** Pure deterministic emission of one split from the given knob values. */
export function generateMultiHopV4Split(
  split: MultiHopV4Split,
  knobs: MultiHopV4Knobs = MULTIHOP_V4_KNOBS,
): MultiHopV4GeneratedSplit {
  validateMultiHopV4Knobs(knobs);
  for (const domain of MULTIHOP_V4_DOMAINS) {
    const answerTokens = new Set(multiHopV4Tokenize(domain.answerType));
    for (const token of multiHopV4Tokenize(`${domain.subjectType} ${domain.bridgeType}`)) {
      if (answerTokens.has(token)) throw new Error(`${domain.tag}: answer-type token ${token} collides with the probe vocabulary`);
    }
  }
  const scenarios = planMultiHopV4Splits(knobs)[split].map((plan) => generateScenario(plan, knobs));
  return {
    input: `${scenarios.map(({ inputLine }) => inputLine).join('\n')}\n`,
    oracle: `${scenarios.map(({ oracleLine }) => oracleLine).join('\n')}\n`,
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DATASET_ROOT = resolve(HERE, '..', 'datasets', 'multihop', 'v4');

async function main(): Promise<void> {
  for (const split of MULTIHOP_V4_SPLITS) {
    const generated = generateMultiHopV4Split(split, MULTIHOP_V4_KNOBS);
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
