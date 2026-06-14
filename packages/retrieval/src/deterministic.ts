// packages/retrieval/src/deterministic.ts
// Yggdrasil-inspired 5-step deterministic context assembly.
// Same graph state always produces the same output — no ranking heuristics.

import { type Driver } from 'neo4j-driver';
import type { ContextSection, ContextItem } from './types.js';

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
 */
export class DeterministicAssembler {
  constructor(private driver: Driver) {}

  async assemble(
    task: string,
    options?: { entity_scope?: string[]; project_name?: string; max_tokens?: number; as_of?: string },
  ): Promise<ContextSection[]> {
    const maxTokens = options?.max_tokens ?? 8000;
    const asOf = options?.as_of;
    const sections: ContextSection[] = [];
    let tokenBudget = maxTokens;

    // Step 1: Identify target entities
    const targets = options?.entity_scope?.length
      ? options.entity_scope
      : await this.matchEntities(task, options?.project_name);

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
    const ancestorsByTarget = await this.getAncestorsBatch(targets);
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
    const entitiesByTarget = await this.getEntitiesBatch(targets);
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
    const depsByTarget = await this.getDependenciesBatch(targets);
    const dependentsByTarget = await this.getDependentsBatch(targets);
    const depItems: ContextItem[] = [];
    for (const target of targets) {
      const deps = depsByTarget.get(target) ?? [];
      for (const d of deps) {
        depItems.push({
          id: `dep-${target}-${d.name}`,
          content: `**${target}** —[${d.relation}]→ **${d.name}**: ${d.interface_desc}`,
          score: 0.8,
          metadata: { relation: d.relation },
        });
      }
      const dependents = dependentsByTarget.get(target) ?? [];
      for (const d of dependents) {
        depItems.push({
          id: `dnt-${d.name}-${target}`,
          content: `**${d.name}** —[${d.relation}]→ **${target}** (dependent)`,
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
    const aspectsByTarget = await this.getAspectsBatch(targets);
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

    // Step 6: Semantic memories scoped to target entities
    const semanticsByTarget = await this.getScopedSemanticsBatch(targets, asOf);
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

  // ─── Private graph queries ──────────────────────────────────────────────

  private async matchEntities(task: string, projectNameOption?: string): Promise<string[]> {
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
        if (ftResult.records.length > 0) {
          return ftResult.records.map((r) => r.get('name') as string);
        }
      } catch (err: unknown) {
        // Fulltext index may not exist yet — fall through
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

  private async getEntitiesBatch(names: string[]): Promise<Map<string, {
    name: string; category: string; responsibility: string; interface_desc: string; internals: string;
  }>> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `UNWIND $names AS targetName
         MATCH (e:Entity {name: targetName})
         RETURN targetName AS targetName, e`,
        { names },
      );
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
    asOf?: string,
  ): Promise<Map<string, Array<{ id: string; content: string; confidence: number; tags: string[] }>>> {
    const session = this.driver.session();
    try {
      // When as_of is provided, filter to semantics created before that timestamp.
      // The per-target LIMIT 10 is preserved via a subquery scoped to each target.
      const temporalFilter = asOf ? ' AND s.created_at <= $asOf' : '';
      const result = await session.run(
        `UNWIND $names AS targetName
         CALL {
           WITH targetName
           MATCH (s:Semantic)-[:ABOUT]->(e:Entity {name: targetName})
           WHERE true${temporalFilter}
           RETURN s.id AS id, s.content AS content, s.confidence AS confidence, s.tags AS tags
           ORDER BY s.confidence DESC
           LIMIT 10
         }
         RETURN targetName AS targetName, id, content, confidence, tags`,
        { names, ...(asOf ? { asOf } : {}) },
      );
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
