// packages/code/src/tools.ts
// MCP tools for code intelligence.

import path from 'node:path';
import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { IndexResult, CodeSearchResult, SymbolNode, SymbolKind } from './types.js';
import type { SymbolDependencyOptions, SymbolLookupOptions } from './symbol-store.js';
import type { CodeWatcher } from './watcher.js';
import { getReindexBaseDir } from './watcher.js';
import { structuralSearch, type StructuralSearchLanguage } from './structural-search.js';
import { resolveProjectTag } from './project-tag.js';

// ─── Service interfaces (injected) ───────────────────────────────────────────

export interface ICodeIndexer {
  indexProject(rootPath: string, options?: { include?: string[]; exclude?: string[]; projectTag?: string }): Promise<IndexResult>;
  indexFile(filePath: string, language: string, projectTag?: string): Promise<{ symbols_created: number; symbols_updated: number; relations_created: number }>;
}

export interface ICodeSearch {
  search(query: string, options?: {
    language?: string; file_path?: string; kind?: string; project_tag?: string; limit?: number; include_semantics?: boolean; as_of?: string;
  }): Promise<CodeSearchResult[]>;
  buildContext(task: string, maxTokens?: number, as_of?: string, filters?: {
    language?: string; file_path?: string; kind?: string; project_tag?: string;
  }): Promise<{ task: string; symbols: CodeSearchResult[]; semantic_memories: Array<{ id: string; content: string; confidence: number }>; token_count: number }>;
  renderContextMarkdown(ctx: { task: string; symbols: CodeSearchResult[]; semantic_memories: Array<{ id: string; content: string; confidence: number }>; token_count: number }): string;
}

export interface ISymbolStore {
  getByFile(filePath: string): Promise<SymbolNode[]>;
  findByName(name: string, kind?: SymbolKind): Promise<SymbolNode[]>;
  findSymbols(options: SymbolLookupOptions): Promise<SymbolNode[]>;
  getCallers(symbolName: string, options?: SymbolDependencyOptions): Promise<SymbolNode[]>;
  getCallees(symbolName: string, options?: SymbolDependencyOptions): Promise<SymbolNode[]>;
  getImporters(symbolName: string, options?: SymbolDependencyOptions): Promise<SymbolNode[]>;
  getInheritanceChain(symbolName: string, options?: SymbolDependencyOptions): Promise<SymbolNode[]>;
}

// ─── Service container ────────────────────────────────────────────────────────
//
// The tool layer depends on a single typed container of services rather than a
// scatter of module-level singletons. A process-default container backs the
// legacy setCodeServiceInstances() injection point, while registerCodeTools()
// also accepts an explicit container — the seam that makes per-session /
// multi-tenant service isolation possible without process globals.

export interface CodeServiceContainer {
  codeIndexer: ICodeIndexer | null;
  codeSearch: ICodeSearch | null;
  symbolStore: ISymbolStore | null;
  codeWatcher: CodeWatcher | null;
}

/** Build a container, defaulting any service not supplied to null. */
export function createCodeContainer(partial: Partial<CodeServiceContainer> = {}): CodeServiceContainer {
  return {
    codeIndexer: partial.codeIndexer ?? null,
    codeSearch: partial.codeSearch ?? null,
    symbolStore: partial.symbolStore ?? null,
    codeWatcher: partial.codeWatcher ?? null,
  };
}

/** Process-default container, populated by setCodeServiceInstances() at bootstrap. */
const defaultContainer: CodeServiceContainer = createCodeContainer();

export function setCodeServiceInstances(services: {
  codeIndexer: ICodeIndexer;
  codeSearch: ICodeSearch;
  symbolStore: ISymbolStore;
  codeWatcher?: CodeWatcher;
}): void {
  defaultContainer.codeIndexer = services.codeIndexer;
  defaultContainer.codeSearch = services.codeSearch;
  defaultContainer.symbolStore = services.symbolStore;
  if (services.codeWatcher) defaultContainer.codeWatcher = services.codeWatcher;
}

// ─── Tool names ──────────────────────────────────────────────────────────────

export const CODE_TOOL_NAMES = [
  'berry_code_index',
  'berry_code_search',
  'berry_code_ast_grep',
  'berry_code_symbols',
  'berry_code_deps',
  'berry_code_context',
  'berry_code_watch',
] as const;

function textContent(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text }] };
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerCodeTools(
  server: McpServer,
  container: CodeServiceContainer = defaultContainer,
): RegisteredTool[] {
  // Destructure once into closure-captured locals. Handlers reference these by
  // the same names they used as module globals, so their bodies are unchanged —
  // but each call to registerCodeTools can now be bound to a different container.
  const { codeIndexer, codeSearch, symbolStore, codeWatcher } = container;
  const handles: RegisteredTool[] = [];

  // ─── berry_code_index ─────────────────────────────────────────────────────
  handles.push(server.tool(
    'berry_code_index',
    'Index a project or file using tree-sitter AST parsing. Creates Symbol nodes (functions, classes, methods, interfaces, types) and relationship edges (SYMBOL_CALLS, SYMBOL_IMPORTS, SYMBOL_INHERITS, SYMBOL_CONTAINS) in the graph. Incremental: unchanged symbols are skipped via content hash. Supports: TypeScript, JavaScript, Python, Go, Rust, plus structural extraction for SQL (tables/views/functions), Terraform/HCL (resources/modules/variables), and MCP config files (servers, env-safe).',
    {
      path: z.string().max(2000).describe('Absolute path to project directory or single file'),
      mode: z.enum(['project', 'file']).optional().default('project').describe('Index entire project or a single file'),
      language: z.string().max(2000).optional().describe('Language hint for single-file mode (typescript, javascript, python, go, rust)'),
      include: z.array(z.string()).optional().describe('Include patterns (e.g., ["src/", "lib/"])'),
      exclude: z.array(z.string()).optional().describe('Additional directories to exclude'),
      project_name: z.string().max(2000).optional().describe('Project name to stamp on indexed symbols as a canonical scope (project:<slug>). Used by later berry_code_search/symbols/deps to scope results.'),
      project_tag: z.string().max(2000).optional().describe('Explicit canonical project tag (e.g. "project:my-app"). Takes precedence over project_name. Normalized to project:<slug>.'),
    },
    { openWorldHint: true } satisfies ToolAnnotations,
    async (args) => {
      if (!codeIndexer) throw new Error('Code services not initialised');

      // Validate path is within the allowed base dir to prevent directory
      // traversal. The base honors MEMBERRY_INGEST_ALLOW_DIR (e.g. /workspace
      // in docker) via the shared @memberry/core helper.
      const baseDir = getReindexBaseDir();
      const resolved = path.resolve(args.path);
      if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
        throw new Error(`Path must be within project root: ${args.path}`);
      }

      // Normalize the project scope ONCE to project:<slug>; threaded into the
      // upsert so it lands on s.project_tag. undefined when neither input given.
      const projectTag = resolveProjectTag(args.project_tag, args.project_name);

      if (args.mode === 'file') {
        const lang = args.language ?? 'typescript';
        const result = await codeIndexer.indexFile(args.path, lang, projectTag);
        return textContent(JSON.stringify(result, null, 2));
      }

      const result = await codeIndexer.indexProject(args.path, {
        include: args.include,
        exclude: args.exclude,
        projectTag,
      });
      return textContent(JSON.stringify({
        ...result,
        errors: result.errors.slice(0, 10),
        errors_truncated: result.errors.length > 10,
      }, null, 2));
    },
  ));

  // ─── berry_code_search ────────────────────────────────────────────────────
  handles.push(server.tool(
    'berry_code_search',
    'Hybrid search across code symbols AND semantic memories. Combines fulltext search (symbol names, signatures, doc comments) with vector search and RRF fusion. Returns blended results ranked by relevance.',
    {
      query: z.string().max(500).describe('Search query (natural language or symbol name)'),
      language: z.string().max(2000).optional().describe('Filter by language'),
      file_path: z.string().max(2000).optional().describe('Filter by file path (substring match)'),
      kind: z.string().max(2000).optional().describe('Filter by symbol kind (function, class, method, interface, type, variable, enum)'),
      project_name: z.string().max(2000).optional().describe('Scope code symbols to project name using indexed file paths'),
      limit: z.number().int().positive().optional().default(20).describe('Max results'),
      include_semantics: z.boolean().optional().default(true).describe('Include semantic memory results alongside code'),
      as_of: z.string().optional().describe('ISO 8601 timestamp for point-in-time queries. When set, semantic memories are filtered to those created before this time.'),
    },
    { readOnlyHint: true } satisfies ToolAnnotations,
    async (args) => {
      if (!codeSearch) throw new Error('Code services not initialised');
      // Scope FIRST by the canonical stored project_tag (project:<slug>); the
      // file_path substring is only an explicit user filter / legacy fallback.
      // When project_name is given we pass ONLY the explicit file_path (not the
      // project-derived path) so the tag drives scoping, not the path heuristic.
      const projectTag = resolveProjectTag(undefined, args.project_name);
      const results = await codeSearch.search(args.query, {
        language: args.language,
        file_path: scopeFilePath(args.file_path, args.project_name, projectTag),
        project_tag: projectTag,
        kind: args.kind,
        limit: args.limit,
        include_semantics: args.include_semantics,
        as_of: args.as_of,
      });

      const formatted = results.map((r) => ({
        name: r.name,
        kind: r.kind,
        source: r.source_type,
        file: r.file_path ? `${r.file_path}:${r.start_line}` : undefined,
        signature: r.signature,
        doc: r.doc_comment?.slice(0, 100) || undefined,
        score: r.score.toFixed(4),
      }));
      return textContent(JSON.stringify(formatted, null, 2));
    },
  ));

  // ─── berry_code_ast_grep ─────────────────────────────────────────────────
  handles.push(server.tool(
    'berry_code_ast_grep',
    'Structural code search powered by ast-grep. Matches AST patterns instead of raw text, returning file/range hits plus captured meta variables. Supports JavaScript, TypeScript, and TSX/JSX files.',
    {
      pattern: z.string().min(1).max(4000).describe('ast-grep pattern, e.g. fetch($URL) or import { $NAME } from $MOD'),
      path: z.string().max(2000).optional().default('.').describe('Project-relative path, directory, or file to search'),
      language: z.enum(['javascript', 'typescript', 'tsx']).optional().describe('Optional language filter; omitted means infer from file extension'),
      include: z.array(z.string().max(500)).optional().describe('Only include relative paths containing one of these substrings'),
      exclude: z.array(z.string().max(500)).optional().describe('Exclude relative paths containing one of these substrings'),
      limit: z.number().int().positive().max(200).optional().default(50).describe('Maximum matches to return'),
      max_file_bytes: z.number().int().positive().max(50 * 1024 * 1024).optional().default(2 * 1024 * 1024).describe('Skip source files larger than this many bytes before reading/parsing'),
    },
    { readOnlyHint: true } satisfies ToolAnnotations,
    async (args) => {
      const baseDir = getReindexBaseDir();
      const resolved = path.resolve(args.path ?? '.');
      if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
        throw new Error(`Path must be within project root: ${args.path}`);
      }

      const result = await structuralSearch(resolved, {
        pattern: args.pattern,
        language: args.language as StructuralSearchLanguage | undefined,
        include: args.include,
        exclude: args.exclude,
        limit: args.limit,
        max_file_bytes: args.max_file_bytes,
      });
      return textContent(JSON.stringify(result, null, 2));
    },
  ));

  // ─── berry_code_symbols ───────────────────────────────────────────────────
  handles.push(server.tool(
    'berry_code_symbols',
    'Query specific symbols in the indexed codebase. Find by file path (all symbols in a file) or by name (across all files). Returns symbol details including kind, signature, doc comment, and line numbers.',
    {
      file_path: z.string().max(2000).optional().describe('Get all symbols in this file'),
      name: z.string().max(2000).optional().describe('Find symbols with this name'),
      kind: z.string().max(2000).optional().describe('Filter by kind (function, class, method, interface, type, variable, enum)'),
      project_name: z.string().max(2000).optional().describe('Scope symbols to project name using indexed file paths'),
      limit: z.number().int().positive().max(100).optional().default(50).describe('Max symbols to return'),
    },
    { readOnlyHint: true } satisfies ToolAnnotations,
    async (args) => {
      if (!symbolStore) throw new Error('Code services not initialised');

      // Scope FIRST by the canonical stored project_tag; the file_path substring
      // is the explicit user filter / legacy fallback (handled in the store).
      const projectTag = resolveProjectTag(undefined, args.project_name);
      const filePathScope = scopeFilePath(args.file_path, args.project_name, projectTag);
      if (!args.name && !filePathScope && !projectTag) throw new Error('Provide name, file_path, or project_name');
      const results = await symbolStore.findSymbols({
        name: args.name,
        file_path: filePathScope,
        project_tag: projectTag,
        kind: args.kind as SymbolKind | undefined,
        limit: args.limit,
      });

      const formatted = results.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        file: `${s.file_path}:${s.start_line}-${s.end_line}`,
        signature: s.signature,
        doc: s.doc_comment?.slice(0, 200) || undefined,
        language: s.language,
      }));
      return textContent(JSON.stringify(formatted, null, 2));
    },
  ));

  // ─── berry_code_deps ──────────────────────────────────────────────────────
  handles.push(server.tool(
    'berry_code_deps',
    'Symbol-level dependency queries. Find what calls a function, what a class inherits from, who imports a module, etc. Traverses SYMBOL_CALLS, SYMBOL_IMPORTS, SYMBOL_INHERITS, and SYMBOL_IMPLEMENTS edges.',
    {
      symbol_name: z.string().max(500).describe('Symbol name to query'),
      direction: z.enum(['callers', 'callees', 'importers', 'inheritance']).describe('Query direction'),
      file_path: z.string().max(2000).optional().describe('Filter returned dependency symbols by file path substring'),
      project_name: z.string().max(2000).optional().describe('Scope returned dependency symbols to project name using indexed file paths'),
      kind: z.string().max(2000).optional().describe('Filter returned dependency symbols by kind'),
      limit: z.number().int().positive().max(100).optional().default(50).describe('Max dependency results to return'),
    },
    { readOnlyHint: true } satisfies ToolAnnotations,
    async (args) => {
      if (!symbolStore) throw new Error('Code services not initialised');

      // Scope FIRST by the canonical stored project_tag; the file_path substring
      // is the explicit user filter / legacy fallback (handled in the store).
      const projectTag = resolveProjectTag(undefined, args.project_name);
      const dependencyOptions: SymbolDependencyOptions = {
        file_path: scopeFilePath(args.file_path, args.project_name, projectTag),
        project_tag: projectTag,
        kind: args.kind as SymbolKind | undefined,
        limit: args.limit,
      };
      let results: SymbolNode[];
      switch (args.direction) {
        case 'callers':
          results = await symbolStore.getCallers(args.symbol_name, dependencyOptions);
          break;
        case 'callees':
          results = await symbolStore.getCallees(args.symbol_name, dependencyOptions);
          break;
        case 'importers':
          results = await symbolStore.getImporters(args.symbol_name, dependencyOptions);
          break;
        case 'inheritance':
          results = await symbolStore.getInheritanceChain(args.symbol_name, dependencyOptions);
          break;
      }

      const formatted = results.map((s) => ({
        name: s.name,
        kind: s.kind,
        file: `${s.file_path}:${s.start_line}`,
        signature: s.signature,
      }));
      return textContent(JSON.stringify({
        symbol: args.symbol_name,
        direction: args.direction,
        count: formatted.length,
        results: formatted,
      }, null, 2));
    },
  ));

  // ─── berry_code_context ───────────────────────────────────────────────────
  handles.push(server.tool(
    'berry_code_context',
    'Build code-aware context for a task. Given a task description, returns relevant code symbols AND semantic memories, ranked and token-budgeted. Use this before making code changes to understand the relevant codebase context.',
    {
      task: z.string().max(5000).describe('Task description (natural language)'),
      max_tokens: z.number().int().positive().optional().default(6000).describe('Max tokens for the context package'),
      as_of: z.string().optional().describe('ISO 8601 timestamp for point-in-time queries. When set, semantic memories are filtered to those created before this time.'),
      language: z.string().max(2000).optional().describe('Filter by language'),
      file_path: z.string().max(2000).optional().describe('Filter by file path (substring match)'),
      kind: z.string().max(2000).optional().describe('Filter by symbol kind (function, class, method, interface, type, variable, enum)'),
      project_name: z.string().max(2000).optional().describe('Scope code symbols to project name using indexed file paths'),
    },
    { readOnlyHint: true } satisfies ToolAnnotations,
    async (args) => {
      if (!codeSearch) throw new Error('Code services not initialised');
      // Scope FIRST by the canonical stored project_tag; the file_path substring
      // is the explicit user filter / legacy fallback.
      const projectTag = resolveProjectTag(undefined, args.project_name);
      const ctx = await codeSearch.buildContext(args.task, args.max_tokens, args.as_of, {
        language: args.language,
        file_path: scopeFilePath(args.file_path, args.project_name, projectTag),
        project_tag: projectTag,
        kind: args.kind,
      });
      const md = codeSearch.renderContextMarkdown(ctx);
      return textContent(md);
    },
  ));

  // ─── berry_code_watch ────────────────────────────────────────────────────
  handles.push(server.tool(
    'berry_code_watch',
    'Start, stop, or check status of the background file watcher that automatically re-indexes source files when they change. Keeps the symbol graph fresh without manual re-indexing.',
    {
      action: z.enum(['start', 'stop', 'status']).describe('start/stop watching or check status'),
      path: z.string().max(2000).optional().describe('Root path to watch. Required for start action.'),
    },
    { openWorldHint: true } satisfies ToolAnnotations,
    async (args) => {
      if (!codeWatcher) throw new Error('Code watcher not initialised');

      switch (args.action) {
        case 'start': {
          if (!args.path) throw new Error('path is required for start action');

          // Validate path is within the allowed base dir (honors
          // MEMBERRY_INGEST_ALLOW_DIR, e.g. /workspace in docker).
          const baseDir = getReindexBaseDir();
          const resolved = path.resolve(args.path);
          if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
            throw new Error(`Path must be within project root: ${args.path}`);
          }

          codeWatcher.watch(resolved);
          return textContent(JSON.stringify({
            action: 'started',
            path: resolved,
            watched_paths: codeWatcher.getWatchedPaths(),
          }, null, 2));
        }

        case 'stop': {
          const paths = codeWatcher.getWatchedPaths();
          codeWatcher.stopAll();
          return textContent(JSON.stringify({
            action: 'stopped',
            stopped_paths: paths,
          }, null, 2));
        }

        case 'status': {
          return textContent(JSON.stringify({
            watched_paths: codeWatcher.getWatchedPaths(),
            pending_reindexes: codeWatcher.getPendingCount(),
          }, null, 2));
        }
      }
    },
  ));

  return handles;
}

function buildCodePathScope(filePath?: string, projectName?: string): string | undefined {
  if (filePath?.trim()) return filePath.trim();
  const trimmed = projectName?.trim();
  if (!trimmed) return undefined;
  const withoutPrefix = trimmed.replace(/^project:/i, '').trim();
  return withoutPrefix || undefined;
}

/**
 * Resolve the file_path filter to pass alongside a canonical project scope
 * (T5/gap-11). The stored `project_tag` is the PRIMARY scope filter, so:
 *
 * - When a `projectTag` resolved: pass ONLY the user's explicit `filePath` (an
 *   additional, optional narrowing). The project NAME is intentionally NOT folded
 *   into the path here — that would re-apply the old path heuristic on top of the
 *   tag. The store/search apply the path-substring heuristic only as a FALLBACK
 *   for symbols that have no stored tag.
 * - When no `projectTag` resolved (e.g. an unusable project_name, or none given):
 *   fall back to the legacy path-substring heuristic via buildCodePathScope, so
 *   behavior is unchanged for unscoped callers.
 */
function scopeFilePath(
  filePath: string | undefined,
  projectName: string | undefined,
  projectTag: string | undefined,
): string | undefined {
  if (projectTag) return filePath?.trim() || undefined;
  return buildCodePathScope(filePath, projectName);
}
