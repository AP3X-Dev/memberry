// packages/core/src/config/status.ts
//
// Read-only view of MemBerry's effective configuration, for the wiki settings panel.
// Hook tuning is live-resolved (env > file > default) and editable via the UI.
// The server block reflects values baked into the MCP bootstrap (applied on
// restart) plus two env-derived runtime facts — surfaced for visibility, not
// yet editable from the UI.

import { loadRawSettings, resolveNumber, readEnv, getSettingsPath, DEFAULT_SETTINGS, defaultExportPath, type HookSettings, type ResolvedNumber } from './settings.js';
import { DECAY_HALF_LIVES_DAYS, resolveLifecycleConfig, type LifecycleConfig } from './lifecycle.js';

export interface ConfigStatus {
  settingsPath: string;
  hookTuning: {
    timeoutMs: ResolvedNumber;
    turnTokens: ResolvedNumber;
    sessionTimeoutMs: ResolvedNumber;
  };
  server: {
    editable: false;
    cacheTTLSeconds: { default: number; context: number; embedding: number };
    consolidation: { autoApply: boolean; signalThreshold: number };
    decayHalfLivesDays: { volatile: number; stable: number; permanent: number };
    requireProjectTag: boolean;
    embeddings: 'openai' | 'zero-vector';
    /** MEM-006 lifecycle pass: flag state + budgets (read-only visibility). */
    lifecycle: {
      mode: LifecycleConfig['mode'];
      sidecarBudget: number;
      sidecarMaxAgeDays: number;
      archiveHalfLifeMultiplier: number;
      maxDecayProposalsPerScope: number;
      decayCooldownDays: number;
    };
  };
}

export function getConfigStatus(): ConfigStatus {
  // Use the RAW file (not merged defaults) so source attribution can tell a
  // file-provided value apart from a built-in default.
  const raw: Partial<HookSettings> = loadRawSettings()?.hooks ?? {};
  const fileVal = (v: number | undefined): number => (typeof v === 'number' ? v : NaN);
  return {
    settingsPath: getSettingsPath(),
    hookTuning: {
      timeoutMs: resolveNumber('MEMBERRY_HOOK_TIMEOUT_MS', fileVal(raw.timeoutMs), DEFAULT_SETTINGS.hooks.timeoutMs),
      turnTokens: resolveNumber('MEMBERRY_HOOK_TURN_TOKENS', fileVal(raw.turnTokens), DEFAULT_SETTINGS.hooks.turnTokens),
      sessionTimeoutMs: resolveNumber('MEMBERRY_HOOK_SESSION_TIMEOUT_MS', fileVal(raw.sessionTimeoutMs), DEFAULT_SETTINGS.hooks.sessionTimeoutMs),
    },
    server: {
      editable: false,
      // Bootstrap defaults (packages/mcp/src/bootstrap.ts) — applied on server restart.
      cacheTTLSeconds: { default: 300, context: 300, embedding: 86400 },
      consolidation: {
        autoApply: ['1', 'true', 'yes', 'on'].includes(
          (readEnv('MEMBERRY_CONSOLIDATION_AUTO_APPLY') ?? '').trim().toLowerCase(),
        ),
        signalThreshold: 3,
      },
      // Single source of truth shared with the lifecycle decay engine (MEM-006).
      decayHalfLivesDays: { ...DECAY_HALF_LIVES_DAYS },
      // Live, env-derived (the wiki service shares the MCP server's env file).
      requireProjectTag: readEnv('MEMBERRY_REQUIRE_PROJECT_TAG') !== 'false',
      embeddings: (process.env['OPENAI_API_KEY'] ?? '').trim() ? 'openai' : 'zero-vector',
      lifecycle: lifecycleStatus(),
    },
  };
}

/** Effective lifecycle knobs for the settings panel. A malformed env var must
 *  not crash the read-only status page — it degrades to disabled + defaults
 *  (the lifecycle job itself fails loudly on the same input). */
function lifecycleStatus(): ConfigStatus['server']['lifecycle'] {
  let config: LifecycleConfig;
  try {
    config = resolveLifecycleConfig(defaultExportPath());
  } catch {
    return {
      mode: 'disabled', sidecarBudget: 5000, sidecarMaxAgeDays: 180,
      archiveHalfLifeMultiplier: 2, maxDecayProposalsPerScope: 25, decayCooldownDays: 30,
    };
  }
  return {
    mode: config.mode,
    sidecarBudget: config.sidecarBudget,
    sidecarMaxAgeDays: config.sidecarMaxAgeDays,
    archiveHalfLifeMultiplier: config.archiveHalfLifeMultiplier,
    maxDecayProposalsPerScope: config.maxDecayProposalsPerScope,
    decayCooldownDays: config.decayCooldownDays,
  };
}
