// packages/core/src/config/lifecycle.ts
//
// Configuration for the scheduled `memberry lifecycle` pass (MEM-006):
// per-(tenant, scope) sidecar retention budgets, review-gated decay proposals,
// and reversible archive. Hostile-parse style mirrors admission-routing.ts —
// closed key set, strict integer/float parsing, explicit bounds, degenerate
// values rejected. Precedence: env > default (readEnv also honors legacy AMP_*
// names). All values are read once at job start; the MCP server never reads
// these.

import { readEnv } from './settings.js';

/**
 * Single source of truth for decay half-lives. status.ts re-exports this so the
 * wiki settings row and the lifecycle decay engine can never drift.
 */
export const DECAY_HALF_LIVES_DAYS = Object.freeze({
  volatile: 14,
  stable: 90,
  permanent: 365,
} as const);

export type LifecycleConfigErrorCode =
  | 'invalid_int'
  | 'invalid_float'
  | 'out_of_bounds'
  | 'blank_value';

/** Contract failures mention only the env var name and a code, never values. */
export class LifecycleConfigError extends Error {
  constructor(
    readonly code: LifecycleConfigErrorCode,
    readonly field: string,
  ) {
    super(`lifecycle_config:${code}:${field}`);
    this.name = 'LifecycleConfigError';
  }
}

export interface LifecycleConfig {
  /** Flag gate: the pass runs only when 'live'. */
  mode: 'disabled' | 'live';
  dryRun: boolean;
  /** Per-(tenant, scope, label) non-protected sidecar row budget. */
  sidecarBudget: number;
  /** Non-protected sidecar rows older than this are deleted regardless of budget. */
  sidecarMaxAgeDays: number;
  /** Archive at half_life x multiplier (one half-life earns a decay proposal, N earn archive). */
  archiveHalfLifeMultiplier: number;
  /** Decay proposals never propose below this confidence. */
  decayConfidenceFloor: number;
  /** Per-(tenant, scope) cap on emitted decay proposals, largest drop first. */
  maxDecayProposalsPerScope: number;
  /** No re-emission for a node within this many days of its decay_proposed_at stamp. */
  decayCooldownDays: number;
  /** Batch size for IN TRANSACTIONS mutations (tenant-admin precedent 1000). */
  batchRows: number;
  /** Root for export-before-mutate artifacts (under <exportDir>/lifecycle/). */
  exportDir: string;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function parseBoundedInt(envVar: string, def: number, min: number, max: number): number {
  const raw = readEnv(envVar);
  if (raw === undefined) return def;
  const trimmed = raw.trim();
  // Strict decimal integer only — no floats, no exponents, no hex, no signs.
  if (!/^\d+$/.test(trimmed)) throw new LifecycleConfigError('invalid_int', envVar);
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) throw new LifecycleConfigError('invalid_int', envVar);
  if (parsed < min || parsed > max) throw new LifecycleConfigError('out_of_bounds', envVar);
  return parsed;
}

function parseBoundedFloat(envVar: string, def: number, min: number, max: number): number {
  const raw = readEnv(envVar);
  if (raw === undefined) return def;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new LifecycleConfigError('invalid_float', envVar);
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) throw new LifecycleConfigError('invalid_float', envVar);
  if (parsed < min || parsed > max) throw new LifecycleConfigError('out_of_bounds', envVar);
  return parsed;
}

/**
 * Enum with a warn-and-disable fallback: an unrecognized value must never
 * enable the pass. Parameterized (MEM-007) so the anti-entropy sub-flag shares
 * the exact MEM-006 semantics; the MEMBERRY_LIFECYCLE_V1 behavior and warning
 * text are byte-identical to the pre-parameterized helper.
 */
function parseMode(envVar: string): 'disabled' | 'live' {
  const raw = (readEnv(envVar) ?? 'disabled').trim().toLowerCase();
  if (raw === 'live') return 'live';
  if (raw !== 'disabled' && raw !== '') {
    console.warn(`[lifecycle] ${envVar} has an unrecognized value; treating as disabled.`);
  }
  return 'disabled';
}

/**
 * Resolve the effective lifecycle configuration from the environment.
 * Malformed or out-of-bounds values throw (fail closed) rather than silently
 * falling back — a typoed budget must not run with the default.
 *
 * @param defaultExportDir used when MEMBERRY_LIFECYCLE_EXPORT_DIR is unset;
 *   callers pass defaultExportPath() (kept as a parameter so the parser stays
 *   filesystem-free and unit-testable).
 */
export function resolveLifecycleConfig(defaultExportDir: string): LifecycleConfig {
  const exportDirRaw = readEnv('MEMBERRY_LIFECYCLE_EXPORT_DIR');
  if (exportDirRaw !== undefined && exportDirRaw.trim() === '') {
    throw new LifecycleConfigError('blank_value', 'MEMBERRY_LIFECYCLE_EXPORT_DIR');
  }
  return {
    mode: parseMode('MEMBERRY_LIFECYCLE_V1'),
    dryRun: TRUTHY.has((readEnv('MEMBERRY_LIFECYCLE_DRY_RUN') ?? '').trim().toLowerCase()),
    // 0 would delete every non-protected row — rejected as degenerate (min 100).
    sidecarBudget: parseBoundedInt('MEMBERRY_LIFECYCLE_SIDECAR_BUDGET', 5000, 100, 1_000_000),
    sidecarMaxAgeDays: parseBoundedInt('MEMBERRY_LIFECYCLE_SIDECAR_MAX_AGE_DAYS', 180, 7, 3650),
    archiveHalfLifeMultiplier: parseBoundedInt('MEMBERRY_LIFECYCLE_ARCHIVE_HALFLIFE_MULTIPLIER', 2, 1, 10),
    decayConfidenceFloor: parseBoundedFloat('MEMBERRY_LIFECYCLE_DECAY_CONFIDENCE_FLOOR', 0.1, 0.01, 0.5),
    maxDecayProposalsPerScope: parseBoundedInt('MEMBERRY_LIFECYCLE_MAX_DECAY_PROPOSALS_PER_SCOPE', 25, 1, 500),
    decayCooldownDays: parseBoundedInt('MEMBERRY_LIFECYCLE_DECAY_COOLDOWN_DAYS', 30, 1, 365),
    batchRows: parseBoundedInt('MEMBERRY_LIFECYCLE_BATCH_ROWS', 1000, 100, 10_000),
    exportDir: exportDirRaw ?? defaultExportDir,
  };
}

// ─── MEM-007 anti-entropy sub-flag ──────────────────────────────────────────
//
// Deliberately a SEPARATE resolved object, not new fields on LifecycleConfig:
// the MEM-006 retention/archive pass is already live, and its config shape
// (and tests) must stay byte-equivalent. The sub-flag exists so the first
// automated graph writes outside bootstrap are killable without disabling
// sidecar retention/archive.

export interface AntiEntropyConfig {
  /** Sub-flag gate: the anti-entropy pass runs only when BOTH this and the MEM-006 mode are 'live'. */
  mode: 'disabled' | 'live';
  /** Only consumers idle longer than this (with an empty PEL) are GC'd. */
  consumerGcIdleMs: number;
}

/**
 * Resolve the anti-entropy configuration from the environment. Dry-run, batch
 * rows, and the export dir are reused from resolveLifecycleConfig — no new
 * knobs for report-only classes.
 */
export function resolveAntiEntropyConfig(): AntiEntropyConfig {
  return {
    mode: parseMode('MEMBERRY_LIFECYCLE_ANTIENTROPY'),
    // 7d default, floor 1h, ceiling 365d — far above the 60s stream reclaim
    // idle and any plausible consolidation gap, so only genuinely dead
    // consumer names qualify.
    consumerGcIdleMs: parseBoundedInt(
      'MEMBERRY_ANTIENTROPY_CONSUMER_GC_IDLE_MS', 604_800_000, 3_600_000, 31_536_000_000,
    ),
  };
}

// ─── MEM-006H hebbian (usage-modulated decay) sub-flag ──────────────────────
//
// Same separate-object rationale as AntiEntropyConfig: the MEM-006 config
// shape stays byte-equivalent. No new numeric env vars — the modulation
// factors, window, and caps are frozen exported constants, not knobs.

/** Accesses older than this window count as stale (U1) for decay modulation
 *  and make a node archive-eligible again. */
export const HEBBIAN_RECENCY_WINDOW_DAYS = 90;

/**
 * Closed usage-band table: the EFFECTIVE decay half-life is
 * DECAY_HALF_LIVES_DAYS[class] x factor. U1 (factor 1.0) is the classic
 * MEM-006 behavior; U0 sinks never-accessed memory faster; U4 marks
 * promotion-eligible heavy use (§2.5 reclass proposals).
 */
export const HEBBIAN_HALF_LIFE_FACTORS = Object.freeze({
  U0_never_accessed: 0.75,
  U1_stale_access: 1.0,
  U2_recent_low: 1.5,
  U3_recent_habitual: 2.0,
  U4_recent_heavy: 3.0,
} as const);

export interface HebbianConfig {
  /** Sub-flag gate: the hebbian pass runs only when BOTH this and the MEM-006 mode are 'live'. */
  mode: 'disabled' | 'live';
}

/**
 * Resolve the hebbian configuration from the environment. Dry-run, batch
 * rows, the export dir, and the reclass cooldown are reused from
 * resolveLifecycleConfig — the sub-flag is the only knob.
 */
export function resolveHebbianConfig(): HebbianConfig {
  return { mode: parseMode('MEMBERRY_LIFECYCLE_HEBBIAN') };
}
