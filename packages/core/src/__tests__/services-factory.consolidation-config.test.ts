import { afterEach, describe, expect, it } from 'vitest';
import { createCoreServices } from '../services-factory.js';

afterEach(() => {
  delete process.env['MEMBERRY_CONSOLIDATION_AUTO_APPLY'];
});
describe('createCoreServices consolidation policy config', () => {
  it('keeps the library-safe review-first default', async () => {
    const core = createCoreServices();
    try {
      expect(core.config.consolidation.autoApply).toBe(false);
    } finally {
      await core.close();
    }
  });

  it.each(['1', 'true', 'YES', 'on'])('accepts %s as the explicit safe-auto-apply opt-in', async (value) => {
    process.env['MEMBERRY_CONSOLIDATION_AUTO_APPLY'] = value;
    const core = createCoreServices();
    try {
      expect(core.config.consolidation.autoApply).toBe(true);
    } finally {
      await core.close();
    }
  });
});
