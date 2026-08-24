// packages/wiki/src/__tests__/lifecycle-settings.test.ts
//
// MEM-006 status surface: the read-only server card renders the lifecycle
// block (flag state + budgets) beside the decay half-life row it already shows.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderSettingsBody } from '../settings.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memberry-wiki-lifecycle-'));
  process.env.AMP_SETTINGS_PATH = path.join(dir, 'settings.json');
  delete process.env.MEMBERRY_LIFECYCLE_V1;
});
afterEach(() => {
  delete process.env.AMP_SETTINGS_PATH;
  delete process.env.MEMBERRY_LIFECYCLE_V1;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('settings page lifecycle block', () => {
  it('renders the lifecycle row with default budgets when the flag is off', () => {
    const html = renderSettingsBody(dir);
    expect(html).toContain('Lifecycle pass');
    expect(html).toContain('disabled, sidecarBudget=5000, sidecarMaxAge=180d, archiveMultiplier=2x, decayCap=25/scope, cooldown=30d');
    // It sits in the same read-only card as the decay half-life row it complements.
    expect(html).toContain('Decay half-lives (volatile/stable/permanent)');
  });

  it('reflects the live flag state', () => {
    process.env.MEMBERRY_LIFECYCLE_V1 = 'live';
    const html = renderSettingsBody(dir);
    expect(html).toContain('live, sidecarBudget=5000');
  });
});
