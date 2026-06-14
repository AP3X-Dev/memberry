// packages/core/src/path-confine.ts
//
// OPT-74: shared realpath-based path-confinement check, used by every confinement
// helper (confineReindexPath @code, validatePath/confineToDir @wiki) so the
// symlink-resolution logic lives in ONE place (no drift — the lesson of OPT-34).
//
// The gap it closes: the prior helpers realpath'd only the FULL target, so when
// the target did not exist yet (a path about to be CREATED, e.g. a compile
// output_dir) realpathSync threw ENOENT and they fell back to a lexical-only
// allow. A symlinked ANCESTOR of that non-existent leaf — e.g. a planted
// `${base}/evil` → /etc — therefore escaped: the lexical check (which never
// resolves symlinks) passed and the symlink check was skipped. This resolves the
// NEAREST EXISTING ANCESTOR's realpath and re-joins the non-existent tail, so an
// escaping ancestor symlink is caught even for a not-yet-existing leaf.

import { realpathSync } from 'node:fs';
import { dirname, basename, join, sep } from 'node:path';

/** realpathSync, or the input unchanged if it can't be resolved (e.g. absent). */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Realpath of `target` — or, when `target` doesn't exist, the realpath of its
 * NEAREST EXISTING ANCESTOR with the non-existent tail lexically re-joined. This
 * means a symlink at ANY level (including an ancestor directory of a path being
 * created) is resolved, not just a symlink at the final component.
 */
export function realpathNearestExisting(target: string): string {
  let existing = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(existing);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return target; // reached root; nothing existed
      tail.push(basename(existing));
      existing = parent;
    }
  }
}

/**
 * True if `resolved` is confined within `baseDir` once symlinks are resolved —
 * `realpath(resolved)` must equal `realpath(baseDir)` or sit under it
 * (`realBase + sep` prefix, so a sibling like `${base}EVIL` cannot pass). Handles
 * not-yet-existing targets via realpathNearestExisting, closing the symlinked-
 * ancestor escape (OPT-74). Pure check: callers keep their own lexical (Layer-1)
 * guard and their own return convention (null vs throw).
 */
export function isRealpathWithinBase(resolved: string, baseDir: string): boolean {
  const realBase = safeRealpath(baseDir);
  const realResolved = realpathNearestExisting(resolved);
  return realResolved === realBase || realResolved.startsWith(realBase + sep);
}
