import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 10000,
    // Integration tests share ONE Neo4j. With parallel file execution, multiple
    // files run their beforeAll schema setup (initSchema / runMigrations create
    // indexes + constraints) at once; on a fresh database two schema transactions
    // deadlock on label locks (Forseti 'can't acquire UpdateLock on LABEL(...)').
    // Run files sequentially so only one schema/transaction touches a label at a time.
    fileParallelism: false,
  },
});
