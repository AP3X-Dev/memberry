// packages/core/src/config/paths.ts
//
// Shared filesystem-confinement base for ingest/index/compile tools across the
// monorepo. A single source of truth so MEMBERRY_INGEST_ALLOW_DIR (e.g.
// /workspace in docker) is honored everywhere — the wiki, code, and mcp
// packages all delegate to this instead of hardcoding process.cwd().

import path from 'node:path';
import { readEnv } from './settings.js';

/**
 * Returns the allowed base directory that ingest/index/compile path access must
 * be confined to. Uses the MEMBERRY_INGEST_ALLOW_DIR env var if set, otherwise
 * falls back to the process working directory.
 *
 * This only resolves the base; callers still apply the lexical + symlink
 * confinement checks (validatePath / confineReindexPath) against it.
 */
export function getAllowedBaseDir(): string {
  return path.resolve(readEnv('MEMBERRY_INGEST_ALLOW_DIR') ?? process.cwd());
}
