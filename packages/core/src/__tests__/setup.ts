// packages/core/src/__tests__/setup.ts
// Vitest setup — disables MEMBERRY_REQUIRE_PROJECT_TAG enforcement during tests so
// pre-existing fixtures that don't supply a project tag continue to work.
// Production keeps the default-on enforcement (Bucket B). The legacy AMP_ alias is
// still honored and is exercised separately in config-settings.test.ts.
process.env['MEMBERRY_REQUIRE_PROJECT_TAG'] = 'false';
