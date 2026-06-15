import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 10000,
    // Live tests share ONE Neo4j and write Symbol nodes. Run files sequentially so
    // concurrent first-write/label-lock acquisition across files can't deadlock the
    // Forseti lock manager on a fresh CI database.
    fileParallelism: false,
  },
});
