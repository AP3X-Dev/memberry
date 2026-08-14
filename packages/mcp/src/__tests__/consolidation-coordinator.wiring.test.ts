import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BOOTSTRAP = fs.readFileSync(path.resolve(__dirname, '../bootstrap.ts'), 'utf8');
const SERVER = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

describe('autonomous consolidation production wiring', () => {
  it('recovers current and legacy episode attribution during catch-up', () => {
    expect(BOOTSTRAP).toContain('RETURN e.scope AS scope, e.tags AS tags, e.task AS task, e.content AS content');
    expect(BOOTSTRAP).toContain('recoverEpisodeScopes(result.records.map');
  });

  it('schedules successful non-duplicate stores and starts/stops with the server', () => {
    expect(BOOTSTRAP).toContain('consolidationCoordinator.schedule(resolveEpisodeScope(input))');
    expect(BOOTSTRAP).toContain('consolidationCoordinator.start()');
    expect(BOOTSTRAP).toContain('await consolidationCoordinator.stop()');
  });

  it('publishes auto-applied mutations and exposes coordinator health', () => {
    expect(BOOTSTRAP).toContain('rawWikiCompiler.compile(resolveWikiOutputDir())');
    expect(BOOTSTRAP).toContain('await consolidationCoordinator.schedulePublication()');
    expect(BOOTSTRAP).toContain("redis.incr('memberry:wiki:generation:dirty')");
    expect(SERVER).toContain('consolidation_automation: getConsolidationAutomationHealth()');
  });

  it('cannot mark wiki generations published when automatic compilation is disabled', () => {
    expect(BOOTSTRAP).toContain('onMutation: wikiPublicationEnabled');
    expect(BOOTSTRAP).toContain('publicationState: wikiPublicationEnabled ?');
    expect(BOOTSTRAP).toContain('automatic wiki publication is disabled');
  });
});
