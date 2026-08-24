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

/** Enum with a warn-and-disable fallback: an unrecognized value must never enable the pass. */
function parseMode(): 'disabled' | 'live' {
  const raw = (readEnv('MEMBERRY_LIFECYCLE_V1') ?? 'disabled').trim().toLowerCase();
  if (raw === 'live') return 'live';
  if (raw !== 'disabled' && raw !== '') {
    console.warn('[lifecycle] MEMBERRY_LIFECYCLE_V1 has an unrecognized value; treating as disabled.');
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
    mode: parseMode(),
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
