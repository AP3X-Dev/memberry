// packages/retrieval/src/deterministic.ts
// Yggdrasil-inspired 5-step deterministic context assembly.
// Same graph state always produces the same output — no ranking heuristics.

import { Record as Neo4jRecord, type Driver } from 'neo4j-driver';
import { isProxy } from 'node:util/types';
import { activeRelationshipFilter, tenantWhere, resolveTenant, TENANT_PARAM } from '@memberry/neo4j';
import type { ContextSection, ContextItem } from './types.js';
import { DeterministicRuntimeTraceAdapter } from './runtime-trace.js';
import type {
  RetrievalTraceChannelSettlement,
  RetrievalTraceDeterministicOutputChannelV2,
  RetrievalTraceV1,
} from './trace.js';

/**
 * Deterministic context assembly.
 *
 * Unlike ranked retrieval, this algorithm is fully reproducible:
 * same graph state → same output, every time.
 *
 * 5 steps:
 * 1. Identify target entities (from task description keywords matched against entity names)
 * 2. Walk hierarchy (ancestors provide domain context)
 * 3. Expand dependencies (typed structural relations)
 * 4. Overlay aspects (cross-cutting concerns)
 * 5. Include semantic memories scoped to target entities
 *
 * Token budgeting fills from most-specific to least-specific.
 *
 * Tenant scoping (OPT-67): Entity and Aspect are SHARED architecture nodes — by
 * design they carry no `tenant_id` (they are absent from TENANT_LABELS), so their
 * reads here are intentionally NOT tenant-filtered (a strict `tenant_id = $t`
 * match would return zero arch nodes for a named tenant). Semantic IS a
 * tenant-scoped memory node, so the semantic read (step 6) ANDs
 * `tenantWhere('s', tenantId)` for defense-in-depth: the default tenant matches
 * legacy/null-tenant nodes (output-identical in single-tenant) and, in a
 * multi-tenant deployment, no longer surfaces a named tenant's semantics about a
 * shared entity. Named tenants are additionally routed away from this path
 * entirely by the tools.ts strategy guard; this is the data-layer backstop.
 */
export class DeterministicAssembler {
  constructor(private driver: Driver) {}

  async assemble(
    task: string,
    options?: { entity_scope?: string[]; resolvedEntityIds?: unknown; project_name?: string; max_tokens?: number; as_of?: string; tenantId?: string },
  ): Promise<ContextSection[]> {
    options = snapshotDeterministicOptions(options);
    const maxTokens = options?.max_tokens ?? 8000;
    const asOf = options?.as_of;
    const tenant = resolveTenant(options?.tenantId);
    const sections: ContextSection[] = [];
    let tokenBudget = maxTokens;

    // Step 1: Identify target entities
    const resolvedEntityIds = normalizeResolvedEntityIds(options?.resolvedEntityIds);
    const stableIdLane = resolvedEntityIds !== undefined;
    const targets = resolvedEntityIds ?? (options?.entity_scope?.length
      ? options.entity_scope
      : await this.matchEntities(task, options?.project_name));

    if (targets.length === 0) {
      sections.push({
        heading: 'No matching entities found',
        source_type: 'arch_entity',
        items: [{ id: 'none', content: `No entities matched task: "${task}"`, score: 0, metadata: {} }],
      });
      return sections;
    }

    // Step 2: Hierarchy walk — ancestors provide domain context
    // Batched: one UNWIND query for all targets, regrouped in JS to preserve the
    // exact per-target iteration order the per-target loop produced.
    const ancestorsByTarget = stableIdLane
      ? new Map<string, Array<{ name: string; depth: number; responsibility: string }>>()
      : await this.getAncestorsBatch(targets);
    const hierarchyItems: ContextItem[] = [];
    for (const target of targets) {
      const ancestors = ancestorsByTarget.get(target) ?? [];
      for (const a of ancestors) {
        hierarchyItems.push({
          id: `hier-${a.name}`,
          content: `**${a.name}** (depth ${a.depth}): ${a.responsibility}`,
          score: 1 - (a.depth * 0.1), // Higher = closer to root = less specific
          metadata: { depth: a.depth },
        });
      }
    }
    if (hierarchyItems.length > 0) {
      const section = budgetSection('Domain Hierarchy', 'arch_entity', hierarchyItems, tokenBudget);
      sections.push(section.section);
      tokenBudget -= section.tokens;
    }

    // Step 3: Target entities with full properties
    const entitiesByTarget = stableIdLane
      ? await this.getEntitiesBatch(targets, true, options?.project_name)
      : await this.getEntitiesBatch(targets);
    const targetItems: ContextItem[] = [];
    for (const target of targets) {
      const entity = entitiesByTarget.get(target);
      if (entity) {
        const parts: string[] = [`# ${entity.name} (${entity.category})`];
        if (entity.responsibility) parts.push(`**Responsibility:** ${entity.responsibility}`);
        if (entity.interface_desc) parts.push(`**Interface:** ${entity.interface_desc}`);
        if (entity.internals) parts.push(`**Internals:** ${entity.internals}`);
        targetItems.push({
          id: `target-${entity.name}`,
          content: parts.join('\n'),
          score: 1.0,
          metadata: { category: entity.category },
        });
      }
    }
    if (targetItems.length > 0) {
      const section = budgetSection('Target Components', 'arch_entity', targetItems, tokenBudget);
      sections.push(section.section);
      tokenBudget -= section.tokens;
    }

    // Step 4: Dependencies — what targets depend on
    const depsByTarget = stableIdLane
      ? new Map<string, Array<{ name: string; relation: string; interface_desc: string }>>()
      : await this.getDependenciesBatch(targets);
    const dependentsByTarget = stableIdLane
      ? new Map<string, Array<{ name: string; relation: string }>>()
      : await this.getDependentsBatch(targets);
    const depItems: ContextItem[] = [];
    for (const target of targets) {
      const targetLabel = stableIdLane ? (entitiesByTarget.get(target)?.name ?? target) : target;
      const deps = depsByTarget.get(target) ?? [];
      for (const d of deps) {
        depItems.push({
          id: `dep-${target}-${d.name}`,
          content: `**${targetLabel}** —[${d.relation}]→ **${d.name}**: ${d.interface_desc}`,
          score: 0.8,
          metadata: { relation: d.relation },
        });
      }
      const dependents = dependentsByTarget.get(target) ?? [];
      for (const d of dependents) {
        depItems.push({
          id: `dnt-${d.name}-${target}`,
          content: `**${d.name}** —[${d.relation}]→ **${targetLabel}** (dependent)`,
          score: 0.6,
          metadata: { relation: d.relation, direction: 'dependent' },
        });
      }
    }
    if (depItems.length > 0) {
      const section = budgetSection('Dependencies & Dependents', 'arch_entity', depItems, tokenBudget);
      sections.push(section.section);
      tokenBudget -= section.tokens;
    }

    // Step 5: Aspects — cross-cutting concerns
    const aspectsByTarget = stableIdLane
      ? new Map<string, Array<{ name: string; stability_tier: string; description: string }>>()
      : await this.getAspectsBatch(targets);
    const aspectItems: ContextItem[] = [];
    for (const target of targets) {
      const aspects = aspectsByTarget.get(target) ?? [];
      for (const a of aspects) {
        aspectItems.push({
          id: `aspect-${a.name}`,
          content: `**${a.name}** [${a.stability_tier}]: ${a.description}`,
          score: a.stability_tier === 'schema' ? 0.9 : a.stability_tier === 'protocol' ? 0.7 : 0.5,
          metadata: { stability_tier: a.stability_tier },
        });
      }
    }
    if (aspectItems.length > 0) {
      const section = budgetSection('Cross-Cutting Concerns', 'aspect', aspectItems, tokenBudget);
      sections.push(section.section);
      tokenBudget -= section.tokens;
    }

    // Step 6: Semantic memories scoped to target entities (and to the tenant)
    const semanticsByTarget = stableIdLane
      ? await this.getScopedSemanticsBatch(targets, asOf, tenant, true, options?.project_name)
      : await this.getScopedSemanticsBatch(targets, asOf, tenant);
    const semanticItems: ContextItem[] = [];
    for (const target of targets) {
      const memories = semanticsByTarget.get(target) ?? [];
      for (const m of memories) {
        semanticItems.push({
          id: m.id,
          content: m.content,
          score: m.confidence,
          metadata: { confidence: m.confidence, tags: m.tags },
        });
      }
    }
    if (semanticItems.length > 0) {
      const section = budgetSection('Semantic Knowledge', 'semantic', semanticItems, tokenBudget);
      sections.push(section.section);
      tokenBudget -= section.tokens;
    }

    return sections;
  }

  /** RET-001B2 trace-only execution. Ordinary assemble() remains untouched so
   * its calls, allocations, ordering, and returned bytes retain the baseline. */
  async assembleTraced(
    task: string,
    options?: { entity_scope?: string[]; resolvedEntityIds?: unknown; project_name?: string; max_tokens?: number; as_of?: string; tenantId?: string },
  ): Promise<{ sections: ContextSection[]; trace: RetrievalTraceV1 }> {
    options = snapshotDeterministicOptions(options);
    const maxTokens = options?.max_tokens ?? 8000;
    const asOf = options?.as_of;
    const tenant = resolveTenant(options?.tenantId);
    const sections: ContextSection[] = [];
    let tokenBudget = maxTokens;
    let discovery: RetrievalTraceChannelSettlement | undefined;

    const resolvedEntityIds = normalizeResolvedEntityIds(options?.resolvedEntityIds);
    const stableIdLane = resolvedEntityIds !== undefined;
    const explicitTargets = resolvedEntityIds ?? (options?.entity_scope?.length ? options.entity_scope : undefined);
    const targets = explicitTargets ?? await this.matchEntities(
      task,
      options?.project_name,
      (settlement) => { discovery = settlement; },
    );
    const trace = new DeterministicRuntimeTraceAdapter({
      query: task,
      maxTokens,
      targetCount: targets.length,
      projectScopeApplied: normalizeProjectName(options?.project_name) !== null,
      namedTenant: tenant !== 'default',
      temporalFilterApplied: Boolean(asOf),
      discovery,
    });

    if (targets.length === 0) {
      sections.push({
        heading: 'No matching entities found',
        source_type: 'arch_entity',
        items: [{ id: 'none', content: `No entities matched task: "${task}"`, score: 0, metadata: {} }],
      });
      return { sections, trace: trace.finalize() };
    }

    let ancestorsByTarget = new Map<string, Array<{ name: string; depth: number; responsibility: string }>>();
    if (stableIdLane) {
      trace.attempt('arch.hierarchy');
      trace.settle('arch.hierarchy', { outcome: 'safe-failure', code: 'unavailable' });
    } else {
      ancestorsByTarget = await runTracedQuery(trace, 'arch.hierarchy', () => this.getAncestorsBatch(targets))
        ?? ancestorsByTarget;
    }
    const hierarchyItems: ContextItem[] = [];
    for (const target of targets) {
      for (const a of ancestorsByTarget.get(target) ?? []) {
        hierarchyItems.push({
          id: `hier-${a.name}`,
          content: `**${a.name}** (depth ${a.depth}): ${a.responsibility}`,
          score: 1 - (a.depth * 0.1),
          metadata: { depth: a.depth },
        });
      }
    }
    const hierarchy = budgetSection('Domain Hierarchy', 'arch_entity', hierarchyItems, tokenBudget);
    if (hierarchyItems.length > 0) {
      sections.push(hierarchy.section);
      tokenBudget -= hierarchy.tokens;
    }
    trace.recordSourceFinal('arch.hierarchy', hierarchyItems, hierarchy.section.items);

    const entitiesByTarget = await runTracedQuery(trace, 'arch.entity', () => stableIdLane
      ? this.getEntitiesBatch(targets, true, options?.project_name)
      : this.getEntitiesBatch(targets))
      ?? new Map<string, { name: string; category: string; responsibility: string; interface_desc: string; internals: string }>();
    const targetItems: ContextItem[] = [];
    for (const target of targets) {
      const entity = entitiesByTarget.get(target);
      if (!entity) continue;
      const parts: string[] = [`# ${entity.name} (${entity.category})`];
      if (entity.responsibility) parts.push(`**Responsibility:** ${entity.responsibility}`);
      if (entity.interface_desc) parts.push(`**Interface:** ${entity.interface_desc}`);
      if (entity.internals) parts.push(`**Internals:** ${entity.internals}`);
      targetItems.push({
        id: `target-${entity.name}`,
        content: parts.join('\n'),
        score: 1.0,
        metadata: { category: entity.category },
      });
    }
    const entitySection = budgetSection('Target Components', 'arch_entity', targetItems, tokenBudget);
    if (targetItems.length > 0) {
      sections.push(entitySection.section);
      tokenBudget -= entitySection.tokens;
    }
    trace.recordSourceFinal('arch.entity', targetItems, entitySection.section.items);

    trace.attempt('arch.dependency');
    let dependencyFailure = false;
    let depsByTarget = new Map<string, Array<{ name: string; relation: string; interface_desc: string }>>();
    let dependentsByTarget = new Map<string, Array<{ name: string; relation: string }>>();
    if (!stableIdLane) {
      try { depsByTarget = await this.getDependenciesBatch(targets); } catch { dependencyFailure = true; }
      try { dependentsByTarget = await this.getDependentsBatch(targets); } catch { dependencyFailure = true; }
    }
    trace.settle('arch.dependency', stableIdLane
      ? { outcome: 'safe-failure', code: 'unavailable' }
      : dependencyFailure
      ? { outcome: 'safe-failure', code: 'query-failed' }
      : { outcome: 'success' });
    const depItems: ContextItem[] = [];
    for (const target of targets) {
      const targetLabel = stableIdLane ? (entitiesByTarget.get(target)?.name ?? target) : target;
      for (const d of depsByTarget.get(target) ?? []) {
        depItems.push({
          id: `dep-${target}-${d.name}`,
          content: `**${targetLabel}** —[${d.relation}]→ **${d.name}**: ${d.interface_desc}`,
          score: 0.8,
          metadata: { relation: d.relation },
        });
      }
      for (const d of dependentsByTarget.get(target) ?? []) {
        depItems.push({
          id: `dnt-${d.name}-${target}`,
          content: `**${d.name}** —[${d.relation}]→ **${targetLabel}** (dependent)`,
          score: 0.6,
          metadata: { relation: d.relation, direction: 'dependent' },
        });
      }
    }
    const dependencySection = budgetSection('Dependencies & Dependents', 'arch_entity', depItems, tokenBudget);
    if (depItems.length > 0) {
      sections.push(dependencySection.section);
      tokenBudget -= dependencySection.tokens;
    }
    trace.recordSourceFinal('arch.dependency', depItems, dependencySection.section.items);

    let aspectsByTarget = new Map<string, Array<{ name: string; stability_tier: string; description: string }>>();
    if (stableIdLane) {
      trace.attempt('arch.aspect');
      trace.settle('arch.aspect', { outcome: 'safe-failure', code: 'unavailable' });
    } else {
      aspectsByTarget = await runTracedQuery(trace, 'arch.aspect', () => this.getAspectsBatch(targets))
        ?? aspectsByTarget;
    }
    const aspectItems: ContextItem[] = [];
    for (const target of targets) {
      for (const a of aspectsByTarget.get(target) ?? []) {
        aspectItems.push({
          id: `aspect-${a.name}`,
          content: `**${a.name}** [${a.stability_tier}]: ${a.description}`,
          score: a.stability_tier === 'schema' ? 0.9 : a.stability_tier === 'protocol' ? 0.7 : 0.5,
          metadata: { stability_tier: a.stability_tier },
        });
      }
    }
    const aspectSection = budgetSection('Cross-Cutting Concerns', 'aspect', aspectItems, tokenBudget);
    if (aspectItems.length > 0) {
      sections.push(aspectSection.section);
      tokenBudget -= aspectSection.tokens;
    }
    trace.recordSourceFinal('arch.aspect', aspectItems, aspectSection.section.items);

    const semanticsByTarget = await runTracedQuery(trace, 'memory.graph', () => stableIdLane
      ? this.getScopedSemanticsBatch(targets, asOf, tenant, true, options?.project_name)
      : this.getScopedSemanticsBatch(targets, asOf, tenant))
      ?? new Map<string, Array<{ id: string; content: string; confidence: number; tags: string[] }>>();
    const semanticItems: ContextItem[] = [];
    for (const target of targets) {
      for (const memory of semanticsByTarget.get(target) ?? []) {
        semanticItems.push({
          id: memory.id,
          content: memory.content,
          score: memory.confidence,
          metadata: { confidence: memory.confidence, tags: memory.tags },
        });
      }
    }
    const semanticSection = budgetSection('Semantic Knowledge', 'semantic', semanticItems, tokenBudget);
    if (semanticItems.length > 0) sections.push(semanticSection.section);
    trace.recordSourceFinal('memory.graph', semanticItems, semanticSection.section.items);

    return { sections, trace: trace.finalize() };
  }

  // ─── Private graph queries ──────────────────────────────────────────────

  private async matchEntities(
    task: string,
    projectNameOption?: string,
    onFulltextSettlement?: (settlement: RetrievalTraceChannelSettlement) => void,
  ): Promise<string[]> {
    const session = this.driver.session();
    try {
      // Try fulltext search first (fast, uses index), fall back to CONTAINS
      const escaped = task
          .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&')
          .replace(/\b(AND|OR|NOT|TO)\b/g, '"$1"');
      const projectName = normalizeProjectName(projectNameOption);
      try {
        const ftResult = await session.run(
          `CALL db.index.fulltext.queryNodes('entity_name_search', $query)
           YIELD node, score
           WHERE $projectName IS NULL
              OR toLower(COALESCE(node.name, '')) = toLower($projectName)
              OR EXISTS {
                MATCH (project:Entity)-[:CONTAINS*0..]->(node)
                WHERE toLower(COALESCE(project.name, '')) = toLower($projectName)
              }
           RETURN node.name AS name
           ORDER BY score DESC LIMIT 5`,
          { query: escaped.split(/\s+/).filter((w) => w.length > 2).join(' ') || escaped, projectName },
        );
        onFulltextSettlement?.({ outcome: 'success' });
        if (ftResult.records.length > 0) {
          return ftResult.records.map((r) => r.get('name') as string);
        }
      } catch (err: unknown) {
        // Fulltext index may not exist yet — fall through
        onFulltextSettlement?.({ outcome: 'safe-failure', code: 'query-failed' });
      }

      // Fallback: keyword CONTAINS match
      const words = task.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      if (words.length === 0) return [];

      const result = await session.run(
        `MATCH (e:Entity)
         WHERE (
           ANY(word IN $words WHERE toLower(e.name) CONTAINS word)
           OR ANY(word IN $words WHERE toLower(COALESCE(e.responsibility, '')) CONTAINS word)
         )
           AND (
             $projectName IS NULL
             OR toLower(COALESCE(e.name, '')) = toLower($projectName)
             OR EXISTS {
               MATCH (project:Entity)-[:CONTAINS*0..]->(e)
               WHERE toLower(COALESCE(project.name, '')) = toLower($projectName)
             }
           )
         RETURN e.name AS name
         ORDER BY size(e.name) DESC
         LIMIT 5`,
        { words, projectName },
      );
      return result.records.map((r) => r.get('name') as string);
    } finally {
      await session.close();
    }
  }

  // Batched per-step queries.
  //
  // Each helper replaces a per-target loop of N single-entity queries (each on
  // its own session) with ONE `UNWIND $names AS name` query on a single session,
  // turning ~6×T round-trips into ~6. Output identity is preserved by:
  //   - keeping each step's original per-target ORDER BY in the Cypher,
  //   - tagging every row with its source target (`targetName`),
  //   - regrouping in JS via a per-target Map that the caller iterates in the
  //     ORIGINAL `targets` order — so the assembled item insertion order, and
  //     therefore the (stably-sorted) budgeted output, is byte-identical to the
  //     prior per-target loop.

  /** Group result rows by their `targetName` column, preserving Cypher row order per target. */
  private groupByTarget<T>(
    records: Array<{ get: (key: string) => unknown }>,
    map: (r: { get: (key: string) => unknown }) => { target: string; value: T },
  ): Map<string, T[]> {
    const grouped = new Map<string, T[]>();
    for (const r of records) {
      const { target, value } = map(r);
      const bucket = grouped.get(target);
      if (bucket) bucket.push(value);
      else grouped.set(target, [value]);
    }
    return grouped;
  }

  private async getAncestorsBatch(
    names: string[],
  ): Promise<Map<string, Array<{ name: string; depth: number; responsibility: string }>>> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `UNWIND $names AS targetName
         MATCH path = (ancestor:Entity)-[:CONTAINS*]->(target:Entity {name: targetName})
         UNWIND nodes(path) AS n
         WITH targetName, n WHERE n.name <> targetName
         WITH targetName, n, COALESCE(n.depth, 0) AS depth, COALESCE(n.responsibility, '') AS responsibility
         RETURN DISTINCT targetName AS targetName, n.name AS name, depth, responsibility
         ORDER BY targetName ASC, depth ASC`,
        { names },
      );
      return this.groupByTarget(result.records, (r) => ({
        target: r.get('targetName') as string,
        value: {
          name: r.get('name') as string,
          depth: toNum(r.get('depth')),
          responsibility: r.get('responsibility') as string,
        },
      }));
    } finally {
      await session.close();
    }
  }

  private async getEntitiesBatch(names: string[], stableIds = false, projectNameOption?: string): Promise<Map<string, {
    name: string; category: string; responsibility: string; interface_desc: string; internals: string;
  }>> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        stableIds ? `UNWIND range(0, size($ids) - 1) AS ordinal
         WITH ordinal, $ids[ordinal] AS targetId
         OPTIONAL MATCH (e:Entity {id: targetId})
         WHERE $projectName IS NULL
            OR toLower(COALESCE(e.name, '')) = toLower($projectName)
            OR EXISTS {
              MATCH (project:Entity)-[:CONTAINS*0..64]->(e)
              WHERE toLower(COALESCE(project.name, '')) = toLower($projectName)
            }
         WITH ordinal, targetId, e ORDER BY ordinal
         RETURN toString(ordinal) AS ordinal, targetId, e,
           CASE WHEN e IS NULL THEN null ELSE $projectName END AS projectName` : `UNWIND $names AS targetName
         MATCH (e:Entity {name: targetName})
         RETURN targetName AS targetName, e`,
        stableIds ? { ids: names, projectName: normalizeProjectName(projectNameOption) } : { names },
      );
      if (stableIds) return parseStableEntityRecords(result, names, normalizeProjectName(projectNameOption));
      const map = new Map<string, {
        name: string; category: string; responsibility: string; interface_desc: string; internals: string;
      }>();
      for (const r of result.records) {
        const targetName = r.get('targetName') as string;
        // Preserve original getEntity semantics: first record for a name wins.
        if (map.has(targetName)) continue;
        const props = (r.get('e') as { properties: Record<string, unknown> }).properties;
        map.set(targetName, {
          name: props.name as string,
          category: (props.category as string) ?? (props.type as string) ?? 'unknown',
          responsibility: (props.responsibility as string) ?? '',
          interface_desc: (props.interface_desc as string) ?? '',
          internals: (props.internals as string) ?? '',
        });
      }
      return map;
    } finally {
      await session.close();
    }
  }

  private async getDependenciesBatch(
    names: string[],
  ): Promise<Map<string, Array<{ name: string; relation: string; interface_desc: string }>>> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `UNWIND $names AS targetName
         MATCH (e:Entity {name: targetName})-[r]->(dep:Entity)
         WHERE type(r) IN ['USES', 'CALLS', 'EXTENDS', 'IMPLEMENTS', 'EMITS']
         RETURN targetName AS targetName, dep.name AS name, type(r) AS relation, COALESCE(dep.interface_desc, '') AS interface_desc
         ORDER BY targetName ASC, dep.name ASC`,
        { names },
      );
      return this.groupByTarget(result.records, (r) => ({
        target: r.get('targetName') as string,
        value: {
          name: r.get('name') as string,
          relation: r.get('relation') as string,
          interface_desc: r.get('interface_desc') as string,
        },
      }));
    } finally {
      await session.close();
    }
  }

  private async getDependentsBatch(
    names: string[],
  ): Promise<Map<string, Array<{ name: string; relation: string }>>> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `UNWIND $names AS targetName
         MATCH (dep:Entity)-[r]->(e:Entity {name: targetName})
         WHERE type(r) IN ['USES', 'CALLS', 'EXTENDS', 'IMPLEMENTS', 'LISTENS']
         RETURN targetName AS targetName, dep.name AS name, type(r) AS relation
         ORDER BY targetName ASC, dep.name ASC`,
        { names },
      );
      return this.groupByTarget(result.records, (r) => ({
        target: r.get('targetName') as string,
        value: {
          name: r.get('name') as string,
          relation: r.get('relation') as string,
        },
      }));
    } finally {
      await session.close();
    }
  }

  private async getAspectsBatch(
    names: string[],
  ): Promise<Map<string, Array<{ name: string; stability_tier: string; description: string }>>> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `UNWIND $names AS targetName
         CALL {
           WITH targetName
           MATCH (a:Aspect)-[:APPLIES_TO]->(e:Entity {name: targetName})
           RETURN a.name AS name, a.stability_tier AS stability_tier, a.description AS description
           UNION
           WITH targetName
           MATCH (ancestor:Entity)-[:CONTAINS*]->(e:Entity {name: targetName})
           MATCH (a:Aspect)-[:APPLIES_TO]->(ancestor)
           RETURN DISTINCT a.name AS name, a.stability_tier AS stability_tier, a.description AS description
         }
         RETURN targetName AS targetName, name, stability_tier, description`,
        { names },
      );
      return this.groupByTarget(result.records, (r) => ({
        target: r.get('targetName') as string,
        value: {
          name: r.get('name') as string,
          stability_tier: (r.get('stability_tier') as string) ?? 'implementation',
          description: (r.get('description') as string) ?? '',
        },
      }));
    } finally {
      await session.close();
    }
  }

  private async getScopedSemanticsBatch(
    names: string[],
    asOf: string | undefined,
    tenantId: string,
    stableIds = false,
    projectNameOption?: string,
  ): Promise<Map<string, Array<{ id: string; content: string; confidence: number; tags: string[] }>>> {
    const session = this.driver.session();
    try {
      // When as_of is provided, filter to semantics created before that timestamp.
      // The per-target LIMIT 10 is preserved via a subquery scoped to each target.
      // Semantic is a tenant-scoped node, so AND tenantWhere('s', tenantId): for the
      // default tenant this matches legacy/null-tenant nodes (output-identical in
      // single-tenant), and bars a named tenant's semantics in multi-tenant. The
      // $tenantId value is a bound parameter (injection-safe).
      const temporalFilter = asOf ? ' AND s.created_at <= $asOf' : '';
      const projectScope = normalizeProjectTag(projectNameOption);
      const result = await session.run(
        stableIds ? `UNWIND range(0, size($ids) - 1) AS ordinal
         WITH ordinal, $ids[ordinal] AS targetId
         CALL {
           WITH targetId
           MATCH (s:Semantic)-[r:ABOUT]->(e:Entity {id: targetId})
           WHERE ${activeRelationshipFilter('r', asOf ? 'asOf' : undefined)}
             AND ${tenantWhere('s', tenantId)}${temporalFilter}
             AND $projectScope IS NOT NULL
             AND (toLower(COALESCE(s.scope, '')) = $projectScope
               OR (s.scope IS NULL AND ANY(tag IN COALESCE(s.tags, []) WHERE toLower(tag) = $projectScope)))
           RETURN s.id AS id, s.content AS content, s.confidence AS confidence, s.tags AS tags,
             s.tenant_id AS tenantId, s.scope AS scope
           ORDER BY s.confidence DESC, s.id ASC
           LIMIT 10
         }
         WITH ordinal, targetId, id, content, confidence, tags, tenantId, scope
         ORDER BY ordinal ASC, confidence DESC, id ASC
         RETURN toString(ordinal) AS ordinal, targetId, id, content, confidence, tags, tenantId, scope` : `UNWIND $names AS targetName
         CALL {
           WITH targetName
           MATCH (s:Semantic)-[:ABOUT]->(e:Entity {name: targetName})
           WHERE ${tenantWhere('s', tenantId)}${temporalFilter}
           RETURN s.id AS id, s.content AS content, s.confidence AS confidence, s.tags AS tags
           ORDER BY s.confidence DESC
           LIMIT 10
         }
         RETURN targetName AS targetName, id, content, confidence, tags`,
        stableIds
          ? { ids: names, [TENANT_PARAM]: tenantId, projectScope, ...(asOf ? { asOf } : {}) }
          : { names, [TENANT_PARAM]: tenantId, ...(asOf ? { asOf } : {}) },
      );
      if (stableIds) return parseStableSemanticRecords(result, names, tenantId, projectScope);
      return this.groupByTarget(result.records, (r) => ({
        target: r.get('targetName') as string,
        value: {
          id: r.get('id') as string,
          content: r.get('content') as string,
          confidence: r.get('confidence') as number,
          tags: (r.get('tags') as string[]) ?? [],
        },
      }));
    } finally {
      await session.close();
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MAX_RESOLVED_ENTITY_IDS = 32;
const MAX_ENTITY_ID_LENGTH = 200;
const SAFE_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DETERMINISTIC_OPTION_KEYS = new Set([
  'entity_scope', 'resolvedEntityIds', 'project_name', 'max_tokens', 'as_of', 'tenantId',
]);

function snapshotDeterministicOptions<T extends object | undefined>(options: T): T {
  if (options === undefined) return options;
  if (options === null || typeof options !== 'object'
    || isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) {
    throw new Error('deterministic_options_invalid');
  }
  const stableDescriptor = Object.getOwnPropertyDescriptor(options, 'resolvedEntityIds');
  if (stableDescriptor === undefined) return options;
  if (!('value' in stableDescriptor)) throw new Error('deterministic_options_invalid');
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !DETERMINISTIC_OPTION_KEYS.has(key)) {
      throw new Error('deterministic_options_invalid');
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('deterministic_options_invalid');
    snapshot[key] = descriptor.value;
  }
  return snapshot as T;
}

const MAX_STABLE_DETERMINISTIC_RECORDS = MAX_RESOLVED_ENTITY_IDS * 10;
const MAX_STABLE_DETERMINISTIC_PROPERTIES = 64;
const MAX_STABLE_DETERMINISTIC_ARRAY = 256;
const MAX_STABLE_DETERMINISTIC_STRING_BYTES = 65_536;
const MAX_STABLE_DETERMINISTIC_TOTAL_STRING_BYTES = 2 * 1024 * 1024;
const MAX_STABLE_DETERMINISTIC_TOTAL_VALUES = 16_384;
type StableDeterministicBudget = { values: number; stringBytes: number };

function stableDeterministicInvalid(): never {
  throw new Error('stable_deterministic_result_invalid');
}

function deterministicDataValue(object: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !('value' in descriptor)) return stableDeterministicInvalid();
  return descriptor.value;
}

function createStableDeterministicBudget(): StableDeterministicBudget {
  return { values: 0, stringBytes: 0 };
}

function consumeStableDeterministicValue(budget: StableDeterministicBudget, value: unknown): void {
  budget.values += 1;
  if (budget.values > MAX_STABLE_DETERMINISTIC_TOTAL_VALUES) stableDeterministicInvalid();
  if (typeof value === 'string') {
    const remainingStringBytes = MAX_STABLE_DETERMINISTIC_TOTAL_STRING_BYTES - budget.stringBytes;
    if (value.length > MAX_STABLE_DETERMINISTIC_STRING_BYTES || value.length > remainingStringBytes) {
      stableDeterministicInvalid();
    }
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_STABLE_DETERMINISTIC_STRING_BYTES) stableDeterministicInvalid();
    budget.stringBytes += bytes;
    if (budget.stringBytes > MAX_STABLE_DETERMINISTIC_TOTAL_STRING_BYTES) stableDeterministicInvalid();
  }
}

function snapshotDeterministicDenseArray(value: unknown, maxLength: number): unknown[] {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return stableDeterministicInvalid();
  }
  const length = deterministicDataValue(value, 'length');
  if (!Number.isInteger(length) || (length as number) < 0 || (length as number) > maxLength) {
    return stableDeterministicInvalid();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== (length as number) + 1 || keys[keys.length - 1] !== 'length') {
    return stableDeterministicInvalid();
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    if (keys[index] !== String(index)) return stableDeterministicInvalid();
    snapshot.push(deterministicDataValue(value, String(index)));
  }
  return snapshot;
}

function snapshotDeterministicProperties(
  value: unknown, budget: StableDeterministicBudget,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value)) return stableDeterministicInvalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return stableDeterministicInvalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_STABLE_DETERMINISTIC_PROPERTIES) return stableDeterministicInvalid();
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string') return stableDeterministicInvalid();
    const item = deterministicDataValue(value, key);
    consumeStableDeterministicValue(budget, item);
    if (Array.isArray(item)) {
      const items = snapshotDeterministicDenseArray(item, MAX_STABLE_DETERMINISTIC_ARRAY);
      for (const nested of items) consumeStableDeterministicValue(budget, nested);
      snapshot[key] = items;
    } else if (item === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof item)) {
      snapshot[key] = item;
    } else {
      return stableDeterministicInvalid();
    }
  }
  return snapshot;
}

function snapshotDeterministicNodeProperties(
  value: unknown, budget: StableDeterministicBudget,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value)) return stableDeterministicInvalid();
  return snapshotDeterministicProperties(deterministicDataValue(value, 'properties'), budget);
}

function snapshotDeterministicRecords(
  result: unknown,
  fields: readonly string[],
  maxRecords: number,
  budget: StableDeterministicBudget,
): unknown[][] {
  if (result === null || typeof result !== 'object' || isProxy(result)) return stableDeterministicInvalid();
  const records = snapshotDeterministicDenseArray(
    deterministicDataValue(result, 'records'),
    Math.min(MAX_STABLE_DETERMINISTIC_RECORDS, maxRecords),
  );
  return records.map((record) => {
    if (record === null || typeof record !== 'object' || isProxy(record)
      || Object.getPrototypeOf(record) !== Neo4jRecord.prototype) return stableDeterministicInvalid();
    const ownKeys = Reflect.ownKeys(record);
    if (ownKeys.length !== 4 || !['keys', 'length', '_fields', '_fieldLookup'].every((key) => ownKeys.includes(key))) {
      return stableDeterministicInvalid();
    }
    if (deterministicDataValue(record, 'length') !== fields.length) return stableDeterministicInvalid();
    const keys = snapshotDeterministicDenseArray(deterministicDataValue(record, 'keys'), fields.length);
    const values = snapshotDeterministicDenseArray(deterministicDataValue(record, '_fields'), fields.length);
    if (keys.length !== fields.length || fields.some((field, index) => keys[index] !== field)) {
      return stableDeterministicInvalid();
    }
    const lookup = deterministicDataValue(record, '_fieldLookup');
    if (lookup === null || typeof lookup !== 'object' || isProxy(lookup)) return stableDeterministicInvalid();
    const lookupProto = Object.getPrototypeOf(lookup);
    if (lookupProto !== Object.prototype && lookupProto !== null) return stableDeterministicInvalid();
    const lookupKeys = Reflect.ownKeys(lookup);
    if (lookupKeys.length !== fields.length || fields.some((field) => !lookupKeys.includes(field))) {
      return stableDeterministicInvalid();
    }
    fields.forEach((field, index) => {
      if (deterministicDataValue(lookup, field) !== index) stableDeterministicInvalid();
    });
    for (const value of values) consumeStableDeterministicValue(budget, value);
    return values;
  });
}

function parseStableOrdinal(value: unknown, length: number): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]?)$/.test(value)) return stableDeterministicInvalid();
  const ordinal = Number(value);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= length || String(ordinal) !== value) {
    return stableDeterministicInvalid();
  }
  return ordinal;
}

function parseStableEntityRecords(
  result: unknown,
  ids: readonly string[],
  projectName: string | null,
): Map<string, { name: string; category: string; responsibility: string; interface_desc: string; internals: string }> {
  const budget = createStableDeterministicBudget();
  const rows = snapshotDeterministicRecords(
    result, ['ordinal', 'targetId', 'e', 'projectName'], ids.length, budget,
  );
  if (rows.length !== ids.length) return stableDeterministicInvalid();
  const map = new Map<string, { name: string; category: string; responsibility: string; interface_desc: string; internals: string }>();
  rows.forEach(([rawOrdinal, targetId, entity, returnedProjectName], index) => {
    const ordinal = parseStableOrdinal(rawOrdinal, ids.length);
    if (ordinal !== index || targetId !== ids[ordinal]) stableDeterministicInvalid();
    if (entity === null) {
      if (returnedProjectName !== null) stableDeterministicInvalid();
      return;
    }
    if (returnedProjectName !== projectName) stableDeterministicInvalid();
    const props = snapshotDeterministicNodeProperties(entity, budget);
    if (props.id !== targetId || typeof props.id !== 'string' || !SAFE_ENTITY_ID.test(props.id)
      || typeof props.name !== 'string'
      || (props.category !== undefined && props.category !== null && typeof props.category !== 'string')
      || (props.type !== undefined && props.type !== null && typeof props.type !== 'string')
      || (props.responsibility !== undefined && props.responsibility !== null && typeof props.responsibility !== 'string')
      || (props.interface_desc !== undefined && props.interface_desc !== null && typeof props.interface_desc !== 'string')
      || (props.internals !== undefined && props.internals !== null && typeof props.internals !== 'string')) {
      stableDeterministicInvalid();
    }
    map.set(targetId, {
      name: props.name,
      category: typeof props.category === 'string' ? props.category
        : typeof props.type === 'string' ? props.type : 'unknown',
      responsibility: typeof props.responsibility === 'string' ? props.responsibility : '',
      interface_desc: typeof props.interface_desc === 'string' ? props.interface_desc : '',
      internals: typeof props.internals === 'string' ? props.internals : '',
    });
  });
  return map;
}

function parseStableSemanticRecords(
  result: unknown,
  ids: readonly string[],
  tenant: string,
  projectScope: string | null,
): Map<string, Array<{ id: string; content: string; confidence: number; tags: string[] }>> {
  const budget = createStableDeterministicBudget();
  const rows = snapshotDeterministicRecords(
    result, ['ordinal', 'targetId', 'id', 'content', 'confidence', 'tags', 'tenantId', 'scope'],
    ids.length * 10, budget,
  );
  const map = new Map<string, Array<{ id: string; content: string; confidence: number; tags: string[] }>>();
  const seen = new Set<string>();
  const perTargetCounts = new Array(ids.length).fill(0) as number[];
  const previousPerTarget = new Map<number, { confidence: number; id: string }>();
  let previousOrdinal = -1;
  for (const [rawOrdinal, targetId, id, content, confidence, rawTags, tenantId, scope] of rows) {
    const ordinal = parseStableOrdinal(rawOrdinal, ids.length);
    if (ordinal < previousOrdinal || targetId !== ids[ordinal]
      || typeof id !== 'string' || !SAFE_ENTITY_ID.test(id)
      || typeof content !== 'string' || typeof confidence !== 'number' || !Number.isFinite(confidence)
      || (tenant === 'default'
        ? tenantId !== undefined && tenantId !== null && tenantId !== 'default'
        : tenantId !== tenant)
      || projectScope === null) {
      return stableDeterministicInvalid();
    }
    previousOrdinal = ordinal;
    const duplicateKey = `${ordinal}\u0000${id}`;
    if (seen.has(duplicateKey)) return stableDeterministicInvalid();
    seen.add(duplicateKey);
    const tags = snapshotDeterministicDenseArray(rawTags, MAX_STABLE_DETERMINISTIC_ARRAY);
    for (const tag of tags) consumeStableDeterministicValue(budget, tag);
    if (!tags.every((tag) => typeof tag === 'string')) return stableDeterministicInvalid();
    if (typeof scope === 'string' && scope.length > 0) {
      if (scope.toLowerCase() !== projectScope) return stableDeterministicInvalid();
    } else if (scope !== null && scope !== undefined) {
      return stableDeterministicInvalid();
    } else if (!(tags as string[]).some((tag) => tag.toLowerCase() === projectScope)) {
      return stableDeterministicInvalid();
    }
    perTargetCounts[ordinal] = (perTargetCounts[ordinal] ?? 0) + 1;
    if (perTargetCounts[ordinal]! > 10) return stableDeterministicInvalid();
    const previous = previousPerTarget.get(ordinal);
    if (previous && (confidence > previous.confidence
      || (confidence === previous.confidence && compareStableCodeUnits(id, previous.id) <= 0))) {
      return stableDeterministicInvalid();
    }
    previousPerTarget.set(ordinal, { confidence, id });
    const bucket = map.get(targetId) ?? [];
    bucket.push({ id, content, confidence, tags: tags as string[] });
    map.set(targetId, bucket);
  }
  return map;
}

function compareStableCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @internal RET-002C stable-ID boundary. Undefined preserves the legacy lane. */
export function normalizeResolvedEntityIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('resolved_entity_ids_invalid');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isInteger(length) || length < 0 || length > MAX_RESOLVED_ENTITY_IDS) {
    throw new Error('resolved_entity_ids_invalid');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) {
    throw new Error('resolved_entity_ids_invalid');
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) throw new Error('resolved_entity_ids_invalid');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
      throw new Error('resolved_entity_ids_invalid');
    }
    const id = descriptor.value;
    if (id.length === 0 || id.length > MAX_ENTITY_ID_LENGTH || !SAFE_ENTITY_ID.test(id)) {
      throw new Error('resolved_entity_ids_invalid');
    }
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }
  return Object.freeze(normalized) as string[];
}

function budgetSection(
  heading: string,
  sourceType: ContextSection['source_type'],
  items: ContextItem[],
  remainingTokens: number,
): { section: ContextSection; tokens: number } {
  const budgeted: ContextItem[] = [];
  let tokens = 0;

  // Sort by score descending — most relevant first
  const sorted = [...items].sort((a, b) => b.score - a.score);

  for (const item of sorted) {
    const itemTokens = Math.ceil(item.content.length / 4);
    if (tokens + itemTokens > remainingTokens) continue;
    budgeted.push(item);
    tokens += itemTokens;
  }

  return {
    section: { heading, source_type: sourceType, items: budgeted },
    tokens,
  };
}

function toNum(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val != null && typeof val === 'object' && 'toNumber' in val) {
    return (val as { toNumber: () => number }).toNumber();
  }
  return 0;
}

function normalizeProjectName(projectName?: string): string | null {
  const trimmed = projectName?.trim();
  if (!trimmed) return null;
  const withoutPrefix = trimmed.replace(/^project:/i, '').trim();
  return withoutPrefix || null;
}

function normalizeProjectTag(projectName?: string): string | null {
  const normalized = normalizeProjectName(projectName);
  return normalized === null ? null : `project:${normalized.toLowerCase()}`;
}

async function runTracedQuery<T>(
  trace: DeterministicRuntimeTraceAdapter,
  channel: RetrievalTraceDeterministicOutputChannelV2,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  trace.attempt(channel);
  try {
    const value = await operation();
    trace.settle(channel, { outcome: 'success' });
    return value;
  } catch {
    trace.settle(channel, { outcome: 'safe-failure', code: 'query-failed' });
    return undefined;
  }
}
