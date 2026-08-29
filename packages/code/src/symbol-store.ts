// packages/code/src/symbol-store.ts
// CRUD for Symbol nodes + relationship edges in Neo4j.

import neo4j, { type Driver } from 'neo4j-driver';
import type { SymbolNode, SymbolKind, SupportedLanguage } from './types.js';

export interface SymbolDependencyOptions {
  file_path?: string;
  kind?: SymbolKind;
  /**
   * Canonical single-scope project tag (`project:<slug>`). When set, results are
   * scoped by `s.project_tag = $tag` FIRST; the `file_path` substring heuristic
   * applies only as a FALLBACK for symbols with no stored project_tag (legacy
   * rows indexed before scoping). When unset, behavior is unchanged.
   */
  project_tag?: string;
  limit?: number;
}

export interface SymbolLookupOptions {
  name?: string;
  file_path?: string;
  kind?: SymbolKind;
  /**
   * Canonical single-scope project tag (`project:<slug>`). When set, results are
   * scoped by `s.project_tag = $tag` FIRST; the `file_path` substring heuristic
   * applies only as a FALLBACK for symbols with no stored project_tag.
   */
  project_tag?: string;
  limit?: number;
}

export class SymbolStore {
  constructor(private driver: Driver) {}

  async create(node: SymbolNode): Promise<string> {
    const session = this.driver.session();
    try {
      await session.run(
        `CREATE (s:Symbol {
          id: $id, name: $name, kind: $kind, language: $language,
          file_path: $file_path, start_line: $start_line, end_line: $end_line,
          signature: $signature, doc_comment: $doc_comment,
          content_hash: $content_hash, parent_symbol: $parent_symbol,
          project_tag: $project_tag,
          created_at: $created_at, updated_at: $updated_at
        })`,
        {
          id: node.id,
          name: node.name,
          kind: node.kind,
          language: node.language,
          file_path: node.file_path,
          start_line: neo4j.int(node.start_line),
          end_line: neo4j.int(node.end_line),
          signature: node.signature,
          doc_comment: node.doc_comment,
          content_hash: node.content_hash,
          // '' sentinel for "no parent": Neo4j rejects a null property in a MERGE
          // pattern, and parent_symbol is part of the Symbol composite key. Read
          // back as null in mapSymbol so the string|null contract is preserved.
          parent_symbol: node.parent_symbol ?? '',
          // Canonical single-scope project tag (null when unscoped).
          project_tag: node.project_tag ?? null,
          created_at: node.created_at,
          updated_at: node.updated_at,
        },
      );

      // Store vectors (each as separate SET to avoid oversized CREATE)
      const vectorProps: Record<string, unknown> = {};
      if (node.embedding) vectorProps.embedding = node.embedding;
      if (node.lexical_vector) vectorProps.lexical_vector = node.lexical_vector;

      if (Object.keys(vectorProps).length > 0) {
        await session.run(
          'MATCH (s:Symbol {id: $id}) SET s += $props',
          { id: node.id, props: vectorProps },
        );
      }

      return node.id;
    } finally {
      await session.close();
    }
  }

  async update(existingId: string, node: Partial<SymbolNode>): Promise<void> {
    const session = this.driver.session();
    try {
      const setClauses: string[] = ['s.updated_at = $now'];
      const params: Record<string, unknown> = { id: existingId, now: new Date().toISOString() };

      const fields: Array<keyof SymbolNode> = [
        'name', 'kind', 'language', 'file_path', 'signature',
        'doc_comment', 'content_hash', 'parent_symbol',
      ];
      for (const key of fields) {
        if (node[key] !== undefined) {
          setClauses.push(`s.${key} = $${key}`);
          params[key] = node[key];
        }
      }
      if (node.start_line !== undefined) {
        setClauses.push('s.start_line = $start_line');
        params.start_line = neo4j.int(node.start_line);
      }
      if (node.end_line !== undefined) {
        setClauses.push('s.end_line = $end_line');
        params.end_line = neo4j.int(node.end_line);
      }

      await session.run(
        `MATCH (s:Symbol {id: $id}) SET ${setClauses.join(', ')}`,
        params,
      );
    } finally {
      await session.close();
    }
  }

  async delete(id: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run('MATCH (s:Symbol {id: $id}) DETACH DELETE s', { id });
    } finally {
      await session.close();
    }
  }

  async getById(id: string): Promise<SymbolNode | null> {
    const session = this.driver.session();
    try {
      const result = await session.run('MATCH (s:Symbol {id: $id}) RETURN s', { id });
      if (result.records.length === 0) return null;
      return mapSymbol(result.records[0].get('s').properties);
    } finally {
      await session.close();
    }
  }

  async getByFile(filePath: string): Promise<SymbolNode[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (s:Symbol {file_path: $path}) RETURN s ORDER BY s.start_line ASC',
        { path: filePath },
      );
      return result.records.map((r) => mapSymbol(r.get('s').properties));
    } finally {
      await session.close();
    }
  }

  async findByName(name: string, kind?: SymbolKind): Promise<SymbolNode[]> {
    const session = this.driver.session();
    try {
      const kindFilter = kind ? 'AND s.kind = $kind' : '';
      const result = await session.run(
        `MATCH (s:Symbol {name: $name}) WHERE true ${kindFilter}
         RETURN s ORDER BY s.file_path ASC`,
        { name, kind: kind ?? null },
      );
      return result.records.map((r) => mapSymbol(r.get('s').properties));
    } finally {
      await session.close();
    }
  }

  async findByNameAndFile(name: string, filePath: string): Promise<SymbolNode | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (s:Symbol {name: $name, file_path: $path}) RETURN s LIMIT 1',
        { name, path: filePath },
      );
      if (result.records.length === 0) return null;
      return mapSymbol(result.records[0].get('s').properties);
    } finally {
      await session.close();
    }
  }

  /**
   * Find a symbol by composite key: name + file + kind + parent_symbol.
   * This uniquely identifies symbols even with overloaded names, duplicate method
   * names across classes, or same-named nested symbols.
   */
  async findByCompositeKey(
    name: string,
    filePath: string,
    kind: SymbolKind,
    parentSymbol: string | null,
  ): Promise<SymbolNode | null> {
    const session = this.driver.session();
    try {
      const parentClause = parentSymbol === null
        ? "AND (s.parent_symbol IS NULL OR s.parent_symbol = '')"
        : 'AND s.parent_symbol = $parent';
      const result = await session.run(
        `MATCH (s:Symbol {name: $name, file_path: $path, kind: $kind})
         WHERE true ${parentClause}
         RETURN s LIMIT 1`,
        { name, path: filePath, kind, parent: parentSymbol },
      );
      if (result.records.length === 0) return null;
      return mapSymbol(result.records[0].get('s').properties);
    } finally {
      await session.close();
    }
  }

  /**
   * Batched upsert for all of a file's symbols in ONE Neo4j round-trip.
   *
   * Reproduces the exact semantics of the prior per-symbol
   * findByCompositeKey -> create/update loop:
   *  - Composite-key identity: MERGE on (name, file_path, kind, parent_symbol).
   *    Neo4j REJECTS a null property in a MERGE pattern, and top-level symbols
   *    have no parent, so "no parent" is stored as the '' sentinel (rows coalesce
   *    null -> ''); mapSymbol normalises '' back to null on read. findByCompositeKey
   *    matches either form.
   *  - ON CREATE: writes the full property set (incl. id, created_at, updated_at)
   *    plus vector props -- identical to create().
   *  - ON MATCH: writes only the update() field subset plus updated_at = now,
   *    leaving the existing node's id and created_at untouched -- identical to
   *    update(existing.id, node). Vector props are NOT rewritten on match, matching
   *    update()'s behavior.
   *
   * Returns counts so the caller can preserve indexFile's created/updated tallies.
   *
   * `projectTag` (T5/gap-11): the canonical single-scope `project:<slug>` tag to
   * stamp on these symbols. NOT part of the composite MERGE key (adding it there
   * would fork existing nodes). On CREATE the tag is written as-is (null when
   * unscoped); on MATCH it is COALESCE($projectTag, s.project_tag) so a new tag
   * OVERWRITES the stored scope, but re-indexing WITHOUT a tag (e.g. the watcher)
   * PRESERVES the existing scope rather than clearing it.
   *
   * Sibling-tag inheritance (OPT-7): when a NEW symbol is created during a
   * context-free reindex (no `projectTag`, e.g. the watcher), its same-file
   * siblings already carry the file's stored `project_tag` (preserved via the
   * COALESCE-on-match above). Without inheritance the new node would be stamped
   * null, so a tag-scoped query would miss it while its siblings match. Before the
   * MERGE we therefore look up an existing sibling's tag for the row's file_path
   * and, on CREATE only, fall back to it when the row carries no explicit tag. The
   * MERGE key and the ON MATCH COALESCE are unchanged; only the ON CREATE tag
   * source gains the sibling fallback.
   */
  async upsertSymbols(
    nodes: SymbolNode[],
    projectTag?: string,
  ): Promise<{ created: number; updated: number }> {
    if (nodes.length === 0) return { created: 0, updated: 0 };

    const now = new Date().toISOString();
    const rows = nodes.map((node) => {
      // Vector props applied on create only (mirrors create()'s separate SET).
      const vectorProps: Record<string, unknown> = {};
      if (node.embedding) vectorProps.embedding = node.embedding;
      if (node.lexical_vector) vectorProps.lexical_vector = node.lexical_vector;

      return {
        // Composite-key fields (MERGE pattern). '' sentinel for "no parent":
        // a null property is illegal in a MERGE node pattern (mapSymbol reads ''
        // back as null, preserving the string|null contract).
        name: node.name,
        kind: node.kind,
        file_path: node.file_path,
        parent_symbol: node.parent_symbol ?? '',
        // ON CREATE scalar props.
        id: node.id,
        language: node.language,
        start_line: neo4j.int(node.start_line),
        end_line: neo4j.int(node.end_line),
        signature: node.signature,
        doc_comment: node.doc_comment,
        content_hash: node.content_hash,
        // Canonical single-scope project tag. The method-level arg wins (the
        // caller threads the resolved tag); fall back to a tag pre-set on the
        // node, else null (unscoped). null + COALESCE-on-match preserves any
        // existing stored scope on re-index.
        project_tag: projectTag ?? node.project_tag ?? null,
        created_at: node.created_at,
        updated_at: node.updated_at,
        vectorProps,
      };
    });

    const session = this.driver.session();
    try {
      const result = await session.run(
        `UNWIND $rows AS row
         // OPT-7: resolve a sibling's stored project_tag for this file BEFORE the
         // MERGE, so a NEW symbol created during a context-free reindex (row tag
         // null) inherits the scope its same-file siblings already carry instead
         // of being stamped null (which a tag-scoped query would miss). Reads an
         // existing scoped sibling only; null when the file has no scoped symbol.
         CALL {
           WITH row
           OPTIONAL MATCH (sib:Symbol {file_path: row.file_path})
           WHERE sib.project_tag IS NOT NULL
           RETURN sib.project_tag AS siblingTag
           LIMIT 1
         }
         WITH row, COALESCE(row.project_tag, siblingTag) AS createTag
         MERGE (s:Symbol {
           name: row.name,
           file_path: row.file_path,
           kind: row.kind,
           parent_symbol: row.parent_symbol
         })
         ON CREATE SET
           s.id = row.id,
           s.name = row.name,
           s.kind = row.kind,
           s.language = row.language,
           s.file_path = row.file_path,
           s.start_line = row.start_line,
           s.end_line = row.end_line,
           s.signature = row.signature,
           s.doc_comment = row.doc_comment,
           s.content_hash = row.content_hash,
           s.parent_symbol = row.parent_symbol,
           s.project_tag = createTag,
           s.created_at = row.created_at,
           s.updated_at = row.updated_at,
           s += row.vectorProps,
           s.\`__upsert_created\` = true
         ON MATCH SET
           s.name = row.name,
           s.kind = row.kind,
           s.language = row.language,
           s.file_path = row.file_path,
           s.start_line = row.start_line,
           s.end_line = row.end_line,
           s.signature = row.signature,
           s.doc_comment = row.doc_comment,
           s.content_hash = row.content_hash,
           s.parent_symbol = row.parent_symbol,
           s.project_tag = COALESCE(row.project_tag, s.project_tag),
           s.updated_at = $now,
           s.\`__upsert_created\` = false
         WITH s, s.\`__upsert_created\` AS wasCreated
         REMOVE s.\`__upsert_created\`
         RETURN
           sum(CASE WHEN wasCreated THEN 1 ELSE 0 END) AS created,
           count(*) AS total`,
        { rows, now },
      );

      const record = result.records[0];
      const total = toNum(record?.get('total'));
      const created = toNum(record?.get('created'));
      return { created, updated: total - created };
    } finally {
      await session.close();
    }
  }

  async getHashesByFile(filePath: string): Promise<Set<string>> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (s:Symbol {file_path: $path}) RETURN s.content_hash AS hash',
        { path: filePath },
      );
      return new Set(result.records.map((r) => r.get('hash') as string));
    } finally {
      await session.close();
    }
  }

  async getCallers(symbolName: string, options: SymbolDependencyOptions = {}): Promise<SymbolNode[]> {
    const session = this.driver.session();
    try {
      const filters = buildDependencyFilters('caller', options);
      const result = await session.run(
        `MATCH (caller:Symbol)-[:SYMBOL_CALLS]->(target:Symbol {name: $name})
         ${filters.whereClause}
         RETURN caller ORDER BY caller.file_path ASC
         LIMIT $limit`,
        {
          name: symbolName,
          ...filters.params,
          limit: neo4j.int(normalizeDependencyLimit(options.limit)),
        },
      );
      return result.records.map((r) => mapSymbol(r.get('caller').properties));
    } finally {
      await session.close();
    }
  }

  async findSymbols(options: SymbolLookupOptions): Promise<SymbolNode[]> {
    const session = this.driver.session();
    try {
      const filters: string[] = [];
      const params: Record<string, unknown> = {
        limit: neo4j.int(normalizeLookupLimit(options.limit)),
      };

      if (options.name?.trim()) {
        filters.push('s.name = $name');
        params.name = options.name.trim();
      }
      // Project scope (T5/gap-11): the stored canonical tag is the PRIMARY filter;
      // the file_path substring heuristic is a FALLBACK applied only to symbols
      // with no stored project_tag (legacy rows). Build them together so scope
      // wins before the path heuristic.
      const lookupScope = buildSymbolScopeFilter('s', options.project_tag, options.file_path);
      if (lookupScope.clause) {
        filters.push(lookupScope.clause);
        Object.assign(params, lookupScope.params);
      }
      if (options.kind) {
        filters.push('s.kind = $kind');
        params.kind = options.kind;
      }

      const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
      const result = await session.run(
        `MATCH (s:Symbol)
         ${whereClause}
         RETURN s ORDER BY s.file_path ASC, s.start_line ASC
         LIMIT $limit`,
        params,
      );
      return result.records.map((r) => mapSymbol(r.get('s').properties));
    } finally {
      await session.close();
    }
  }

  async getCallees(symbolName: string, options: SymbolDependencyOptions = {}): Promise<SymbolNode[]> {
    const session = this.driver.session();
    try {
      const filters = buildDependencyFilters('callee', options);
      const result = await session.run(
        `MATCH (source:Symbol {name: $name})-[:SYMBOL_CALLS]->(callee:Symbol)
         ${filters.whereClause}
         RETURN callee ORDER BY callee.file_path ASC
         LIMIT $limit`,
        {
          name: symbolName,
          ...filters.params,
          limit: neo4j.int(normalizeDependencyLimit(options.limit)),
        },
      );
      return result.records.map((r) => mapSymbol(r.get('callee').properties));
    } finally {
      await session.close();
    }
  }

  async getImporters(symbolName: string, options: SymbolDependencyOptions = {}): Promise<SymbolNode[]> {
    const session = this.driver.session();
    try {
      const filters = buildDependencyFilters('importer', options);
      const result = await session.run(
        `MATCH (importer:Symbol)-[:SYMBOL_IMPORTS]->(target:Symbol {name: $name})
         ${filters.whereClause}
         RETURN importer ORDER BY importer.file_path ASC
         LIMIT $limit`,
        {
          name: symbolName,
          ...filters.params,
          limit: neo4j.int(normalizeDependencyLimit(options.limit)),
        },
      );
      return result.records.map((r) => mapSymbol(r.get('importer').properties));
    } finally {
      await session.close();
    }
  }

  async getInheritanceChain(symbolName: string, options: SymbolDependencyOptions = {}): Promise<SymbolNode[]> {
    const session = this.driver.session();
    try {
      const filters = buildDependencyFilters('symbol', options);
      const result = await session.run(
        `MATCH path = (child:Symbol {name: $name})-[:SYMBOL_INHERITS*]->(ancestor:Symbol)
         UNWIND nodes(path) AS n
         WITH DISTINCT n AS symbol, length(path) AS depth
         ${filters.whereClause}
         RETURN symbol ORDER BY depth ASC, symbol.file_path ASC
         LIMIT $limit`,
        {
          name: symbolName,
          ...filters.params,
          limit: neo4j.int(normalizeDependencyLimit(options.limit)),
        },
      );
      return result.records.map((r) => mapSymbol(r.get('symbol').properties));
    } finally {
      await session.close();
    }
  }

  async deleteByFile(filePath: string): Promise<number> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (s:Symbol {file_path: $path}) DETACH DELETE s RETURN count(s) AS deleted',
        { path: filePath },
      );
      const count = result.records[0]?.get('deleted');
      return typeof count === 'number' ? count : count ? (count as { toNumber(): number }).toNumber() : 0;
    } finally {
      await session.close();
    }
  }
}

// --- Helpers ------------------------------------------------------------------

function mapSymbol(props: Record<string, unknown>): SymbolNode {
  return {
    id: props.id as string,
    name: props.name as string,
    kind: props.kind as SymbolKind,
    language: props.language as SupportedLanguage,
    file_path: props.file_path as string,
    start_line: toNum(props.start_line),
    end_line: toNum(props.end_line),
    signature: (props.signature as string) ?? '',
    doc_comment: (props.doc_comment as string) ?? '',
    content_hash: (props.content_hash as string) ?? '',
    // '' is the "no parent" sentinel written by create()/upsertSymbols (a null
    // MERGE key is illegal in Neo4j) — normalise it back to null for callers.
    parent_symbol: (props.parent_symbol as string) || null,
    // Canonical single-scope project tag (undefined when the symbol is unscoped).
    project_tag: (props.project_tag as string) || undefined,
    embedding: props.embedding as number[] | undefined,
    created_at: props.created_at as string,
    updated_at: props.updated_at as string,
  };
}

function toNum(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val != null && typeof val === 'object' && 'toNumber' in val) {
    return (val as { toNumber: () => number }).toNumber();
  }
  return 0;
}

function buildDependencyFilters(
  alias: string,
  options: SymbolDependencyOptions,
): { whereClause: string; params: Record<string, unknown> } {
  const filters: string[] = [];
  const params: Record<string, unknown> = {};

  // Project scope FIRST (stored canonical tag), with the file_path substring as a
  // fallback for symbols that have no stored project_tag. See buildSymbolScopeFilter.
  const scope = buildSymbolScopeFilter(alias, options.project_tag, options.file_path);
  if (scope.clause) {
    filters.push(scope.clause);
    Object.assign(params, scope.params);
  }
  if (options.kind) {
    filters.push(`${alias}.kind = $kind`);
    params.kind = options.kind;
  }

  return {
    whereClause: filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '',
    params,
  };
}

/**
 * Build the project-scope WHERE fragment for a symbol alias (T5/gap-11).
 *
 * - When a canonical `project_tag` is supplied: the stored tag is the PRIMARY
 *   filter (`alias.project_tag = $project_tag`). The `file_path` substring
 *   heuristic is a FALLBACK applied ONLY to symbols with no stored project_tag
 *   (`alias.project_tag IS NULL AND toLower(alias.file_path) CONTAINS …`) so
 *   legacy unscoped rows aren't silently excluded. If no file_path is given, the
 *   fallback admits all unscoped rows.
 * - When no `project_tag` is supplied: behavior is unchanged — a `file_path`
 *   substring filter (if any), exactly as before.
 *
 * Param names (`$project_tag`, `$file_path`) are unique within a single query.
 */
function buildSymbolScopeFilter(
  alias: string,
  projectTag: string | undefined,
  filePath: string | undefined,
): { clause: string; params: Record<string, unknown> } {
  const tag = projectTag?.trim();
  const fp = filePath?.trim();

  if (tag) {
    const params: Record<string, unknown> = { project_tag: tag };
    if (fp) {
      params.file_path = fp;
      // Scope by stored tag first; fall back to the path heuristic ONLY for rows
      // that predate scoping (no stored project_tag).
      return {
        clause: `(${alias}.project_tag = $project_tag OR (${alias}.project_tag IS NULL AND toLower(${alias}.file_path) CONTAINS toLower($file_path)))`,
        params,
      };
    }
    // No path hint: scoped rows by tag, plus all legacy unscoped rows.
    return {
      clause: `(${alias}.project_tag = $project_tag OR ${alias}.project_tag IS NULL)`,
      params,
    };
  }

  // No project scope — preserve the prior file_path-only behavior.
  if (fp) {
    return {
      clause: `toLower(${alias}.file_path) CONTAINS toLower($file_path)`,
      params: { file_path: fp },
    };
  }

  return { clause: '', params: {} };
}

function normalizeDependencyLimit(limit: number | undefined): number {
  if (limit == null) return 50;
  const floored = Math.floor(limit);
  if (!Number.isFinite(floored) || floored <= 0) return 50;
  return Math.min(floored, 100);
}

function normalizeLookupLimit(limit: number | undefined): number {
  if (limit == null) return 50;
  const floored = Math.floor(limit);
  if (!Number.isFinite(floored) || floored <= 0) return 50;
  return Math.min(floored, 100);
}
