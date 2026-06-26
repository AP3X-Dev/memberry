// Canonicalize project: scope + tags to lowercase across all node types, and
// dedupe tag arrays. Fixes the casing fragmentation that hid nodes from
// lowercase-tag / lowercase-scope retrieval. Idempotent.

// 1. Lowercase the `scope` property wherever it's an upper-cased project: scope.
MATCH (n)
WHERE n.scope IS NOT NULL
  AND toLower(n.scope) STARTS WITH 'project:'
  AND n.scope <> toLower(n.scope)
SET n.scope = toLower(n.scope);

// 2. Lowercase project: entries inside `tags` arrays, and dedupe the array.
MATCH (n)
WHERE n.tags IS NOT NULL
  AND any(t IN n.tags WHERE toLower(t) STARTS WITH 'project:' AND t <> toLower(t))
WITH n, [t IN n.tags | CASE WHEN toLower(t) STARTS WITH 'project:' THEN toLower(t) ELSE t END] AS lowered
WITH n, apoc.coll.toSet(lowered) AS deduped
SET n.tags = deduped;

// 3. Dedupe any remaining tag arrays that carry duplicates (e.g. the bootstrap
//    seeds that stored project:X twice) even when no casing change was needed.
MATCH (n)
WHERE n.tags IS NOT NULL AND size(n.tags) > size(apoc.coll.toSet(n.tags))
SET n.tags = apoc.coll.toSet(n.tags);
