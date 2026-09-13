# Legacy supersession reconciliation

`inventory-semantic-supersession.mjs` remains read-only. The companion command
creates a dry-run plan, applies exactly that plan, or conditionally reverses its
temporal repairs. It never creates historical timestamps: only missing
predecessor `invalid_at` and SUPERSEDES `valid_at` receive an existing, consistent
cutoff. All other source properties are preserved.

Set explicit `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` and, when needed,
`NEO4J_DATABASE`. There is no `.env` or localhost fallback for this command.

```sh
node scripts/reconcile-semantic-supersession.mjs --plan plan.json
node scripts/reconcile-semantic-supersession.mjs --apply plan.json applied.json
node scripts/reconcile-semantic-supersession.mjs --rollback plan.json rolled-back.json
```

Review the plan's `inventory`, `excluded`, and `components` before apply. Plan
eligibility is deliberately narrower than inventory classification: apply needs
explicit concrete tenant IDs and a canonical project scope. Missing authority,
ambiguous topology, or missing/conflicting temporal evidence requires manual
investigation; no automatic repair is proposed. A plan is tied to physical graph
identities and full property fingerprints, so generate a new plan after a
database restore or source edit. Artifacts include temporal/identity metadata and
property hashes, not source content or embeddings.

The operator must provision these uniqueness constraints through the normal
schema change process before apply. The command checks them and never adds DDL:

```cypher
CREATE CONSTRAINT semantic_reconciliation_id IF NOT EXISTS
FOR (receipt:SemanticReconciliation) REQUIRE receipt.id IS UNIQUE;
CREATE CONSTRAINT semantic_id IF NOT EXISTS
FOR (s:Semantic) REQUIRE s.id IS UNIQUE;
CREATE CONSTRAINT knowledge_epoch_scope IF NOT EXISTS
FOR (epoch:KnowledgeEpoch) REQUIRE (epoch.tenant_id, epoch.project_scope) IS UNIQUE;
```

One bounded write transaction claims the receipt, locks all affected Semantic
nodes and SUPERSEDES relationships, then re-reads complete incident topology and
property fingerprints before mutation. A changed or additional endpoint, edge,
or property aborts the entire transaction. Conditional writes require the old
field to remain absent. Each changed component advances its project and tenant
unscoped knowledge epochs in that transaction. Existing runtime supersede writers
also acquire endpoint write locks; concurrent arbitrary writers outside that
protocol must be quiesced during migration.

The durable `SemanticReconciliation` receipt is committed with changes and epochs.
If exporting its JSON fails after commit, rerun the same apply command with a new
output filename to recover the receipt. Applied replay performs no further
mutations. Rollback requires the saved plan and stored applied receipt, locks and
compares the exact post-apply graph, removes only fields introduced by the plan,
and advances epochs again. It refuses intervening source/edge/property drift.
An already rolled-back plan cannot be reapplied; create and review a fresh plan
with a new source state if further work is needed. Rollback of these metadata
repairs does not authorize rollback to stale retrieval behavior.

Local synthetic transaction tests cover planning, apply/replay/rollback,
post-plan and post-apply drift, tampering, constraint absence and atomic failure
at the epoch step. They do not establish real Neo4j lock/concurrency or Cypher
qualification. Run disposable database qualification before production use.

Required live synthetic qualification (explicit disposable credentials as above):

```sh
MEMBERRY_PR01_LIVE=required node --test scripts/__tests__/reconcile-semantic-supersession.live.test.mjs
```

Unset required mode skips this fixture; invalid mode or absent/unavailable
credentials fails. It creates missing uniqueness constraints in the disposable
database and cleans up only its UUID-prefixed synthetic sources/epochs and exact
receipt IDs. It exercises concurrent same-plan apply, dry-run isolation, epoch
increments, rollback/replay, property and topology drift, and quarantine.
