// packages/wiki/src/compile.ts
// V2 compiler: walks the MemBerry graph and compiles a multi-project wiki with
// subdirectory layout, episodic history, library, topics, and portal homepage.

import type { Driver } from 'neo4j-driver';
import { writeFile, mkdir, rm, readdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CompileV2Result,
  EntityInfo,
  EpisodicEntry,
  ProjectData,
  SourceInfo,
  LibraryPage,
  TopicData,
  PortalData,
  ArticleFrontmatter,
  ResolvedClaim,
} from './types.js';
import {
  fetchAllProjects,
  fetchEpisodicProjectScopes,
  fetchProjectEntities,
  fetchEntitiesModifiedByProject,
  fetchSemanticsForEntity,
  fetchEpisodicsForProject,
  fetchEpisodicsForEntities,
  fetchHierarchy,
  fetchBacklinks,
  fetchRelatedEntities,
  fetchSourcesForEntity,
  fetchInboundLinkCount,
  fetchAllSources,
  fetchClaimsForSource,
  fetchAllTags,
  fetchAllSemantics,
  fetchGraphStats,
  fetchRecentEpisodics,
} from './queries.js';
import {
  renderFrontmatter,
  renderEntityArticle,
  renderProjectIndex,
  renderPortalHomepage,
  renderLibraryIndex,
  renderLibraryPage,
  renderTopicIndex,
  renderTopicPage,
  renderDecisionsPage,
  renderPatternsPage,
  renderRecentChanges,
  renderProjectGraph,
  crossProjectPatternTags,
  DECISION_CONFIDENCE_THRESHOLD,
} from './renderers.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── OPT-9: cross-process compile lock ───────────────────────────────────────
//
// The served wiki dir (`/app/wiki`) is a Docker named-volume MOUNT POINT shared
// by TWO writers, each of which calls WikiCompiler.compile():
//   1. the wiki SERVICE container's startup `build` (compile + serve + watch), and
//   2. the MCP container's autorefresh recompile on ingest.
// Both clear-then-rebuild the same directory. Without a lock their child-rm /
// re-emit phases interleave, so one writer deletes files the other just wrote and
// the served wiki is transiently structurally incomplete. An advisory lockfile in
// the output dir, acquired with O_EXCL, serializes the two compiles: whichever
// acquires first runs to completion, the other waits and then runs. Because the
// guard lives INSIDE compile() (which both writers call), one change protects both.

/**
 * OPT-10: top-level sentinel the compiler rewrites LAST on every compile. The
 * served viewer watches for changes to this single top-level file (reliable under
 * fs.watch, unlike the nested project dirs) to trigger a full cache rebuild after
 * an MCP-side recompile. Exported so the viewer references the exact same name.
 */
export const COMPILED_MARKER_FILENAME = '.compiled';

const COMPILE_LOCK_FILENAME = '.compile.lock';
/** A lock older than this (no longer being held by a live compile) is stale → broken. */
const COMPILE_LOCK_STALE_MS = 60_000;
/** Give up acquiring after this long and proceed anyway (don't deadlock a compile). */
const COMPILE_LOCK_TIMEOUT_MS = 120_000;
/** Poll interval while waiting for the holder to release. */
const COMPILE_LOCK_RETRY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lockfile payload: pid + ISO timestamp, so a stale lock can be detected/broken. */
function lockPayload(): string {
  return JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
}

/** Parse a lockfile body; returns null if unreadable/corrupt (treated as stale). */
function parseLockAgeMs(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { at?: unknown };
    if (typeof parsed.at !== 'string') return null;
    const ts = Date.parse(parsed.at);
    if (Number.isNaN(ts)) return null;
    return Date.now() - ts;
  } catch {
    return null;
  }
}

/**
 * Acquire the cross-process compile lock for `outputDir`. Resolves once held.
 * Uses `open(path, 'wx')` (O_EXCL) as the atomic create-or-fail primitive. On
 * contention it waits and retries; if the existing lock is older than the stale
 * threshold (or its timestamp is unreadable), it breaks the lock and retries. After
 * the overall timeout it proceeds without the lock rather than deadlocking — a
 * degraded-but-live recompile beats a hung one. The dir is created first so the
 * lockfile has somewhere to live; this is mount-safe (no rmdir/rename of the mount).
 */
async function acquireCompileLock(outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const lockPath = join(outputDir, COMPILE_LOCK_FILENAME);
  const deadline = Date.now() + COMPILE_LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(lockPayload(), 'utf-8');
      } finally {
        await handle.close();
      }
      return; // lock held
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      // Contention: inspect the holder. Break it if it looks stale.
      let ageMs: number | null = null;
      try {
        ageMs = parseLockAgeMs(await readFile(lockPath, 'utf-8'));
      } catch {
        ageMs = null; // unreadable (e.g. removed mid-read) → retry below
      }
      if (ageMs === null || ageMs > COMPILE_LOCK_STALE_MS) {
        // Stale or corrupt lock — remove and retry immediately. force:true so a
        // concurrent breaker that already removed it doesn't make us throw.
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) return; // give up waiting; proceed lock-less
      await sleep(COMPILE_LOCK_RETRY_MS);
    }
  }
}

/** Release the compile lock. Best-effort; a missing lockfile is not an error. */
async function releaseCompileLock(outputDir: string): Promise<void> {
  try {
    await unlink(join(outputDir, COMPILE_LOCK_FILENAME));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[wiki-compile] Failed to release compile lock:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * gap-13: extract the bare project name from the STRUCTURED fields berry_store
 * persists — `ep.scope` (e.g. "project:agent-assist-cr") first, then any
 * `project:*` entry in `ep.tags`. Returns '' if neither carries a project scope.
 * This is the canonical association; the task/content `[project:…]` prefix and
 * the session_id heuristic remain only as fallbacks (see deriveEpisodicScope).
 */
export function structuredEpisodicScope(ep: EpisodicEntry): string {
  if (ep.scope && /^project:/i.test(ep.scope)) return ep.scope.replace(/^project:/i, '');
  const tag = (ep.tags ?? []).find((t) => /^project:/i.test(t));
  if (tag) return tag.replace(/^project:/i, '');
  return '';
}

/**
 * Best-effort project attribution for an episode. gap-13: PREFER the structured
 * `ep.scope`/`ep.tags` (canonical, set by berry_store); only when absent fall
 * back to the `[project:…]` task prefix, then a `[project:…]` prefix in content,
 * then a known project name appearing as a token in its session_id
 * (e.g. session-20260608-ag3ntic-morph → ag3ntic). Returns '' if none match.
 */
export function deriveEpisodicScope(ep: EpisodicEntry, knownSlugs: string[]): string {
  const structured = structuredEpisodicScope(ep);
  if (structured) return structured;
  if (ep.project_scope) return ep.project_scope;
  const fromContent = (ep.content ?? '').match(/^\[project:([^\]]+)\]/);
  if (fromContent) return fromContent[1];
  const sid = (ep.session_id ?? '').toLowerCase();
  for (const slug of knownSlugs) { // caller sorts longest-first → most specific wins
    if (slug.length < 3) continue;
    if (new RegExp('(^|[^a-z0-9])' + escapeRegExp(slug) + '($|[^a-z0-9])').test(sid)) return slug;
  }
  return '';
}

/** Resolve entity references in claim text to [[wikilinks]] */
export function resolveInlineLinks(text: string, entityRefs: string[], projectSlug: string): string {
  let resolved = text;
  const sorted = [...entityRefs].sort((a, b) => b.length - a.length);
  for (const ref of sorted) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    const entitySlug = slugify(ref);
    const wikilink = `[[projects/${projectSlug}/${entitySlug}|${ref}]]`;
    resolved = resolved.replace(re, (match, offset) => {
      // Avoid double-linking: skip if this match is inside an existing [[wikilink]]
      const before = resolved.slice(0, offset);
      const openCount = (before.match(/\[\[/g) ?? []).length;
      const closeCount = (before.match(/\]\]/g) ?? []).length;
      if (openCount > closeCount) return match;
      return wikilink;
    });
  }
  return resolved;
}

async function writeMarkdown(filePath: string, content: string): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function projectNameScore(name: string): number {
  const trimmed = name.trim();
  let score = 0;
  if (!/^__.*__$/.test(trimmed)) score += 100;
  if (/[A-Z]/.test(trimmed)) score += 10;
  if (/\s/.test(trimmed)) score += 5;
  if (!trimmed.includes('_')) score += 3;
  if (!/^[a-z0-9-]+$/.test(trimmed)) score += 2;
  return score;
}

function chooseProjectEntity(a: EntityInfo, b: EntityInfo): EntityInfo {
  const preferred = projectNameScore(b.name) > projectNameScore(a.name) ? b : a;
  const fallback = preferred === a ? b : a;
  return {
    ...preferred,
    description: preferred.description ?? fallback.description,
    aliases: preferred.aliases ?? fallback.aliases,
    created_at: preferred.created_at ?? fallback.created_at,
  };
}

function mergeProjectData(a: ProjectData, b: ProjectData): ProjectData {
  const substantive = uniqueById([...a.substantive_entities, ...b.substantive_entities]);
  const substantiveIds = new Set(substantive.map((e) => e.id));
  const sparse = uniqueById([...a.sparse_entities, ...b.sparse_entities])
    .filter((e) => !substantiveIds.has(e.id));
  const episodics = uniqueById([...a.episodics, ...b.episodics])
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const semantics = uniqueById([...a.semantics, ...b.semantics]);

  return {
    entity: chooseProjectEntity(a.entity, b.entity),
    entities: uniqueById([...a.entities, ...b.entities]),
    substantive_entities: substantive,
    sparse_entities: sparse,
    episodics,
    semantics,
  };
}

function isInternalProjectName(name: string): boolean {
  return name.trim().startsWith('__');
}

function hasHumanNavigableContent(project: ProjectData): boolean {
  return project.entities.length > 0 || project.semantics.length > 0 || project.episodics.length > 0;
}

function canonicalizeHumanProjects(projects: ProjectData[]): ProjectData[] {
  const bySlug = new Map<string, ProjectData>();
  for (const project of projects) {
    const slug = slugify(project.entity.name);
    const key = slug || project.entity.name.trim().toLowerCase();
    const existing = bySlug.get(key);
    bySlug.set(key, existing ? mergeProjectData(existing, project) : project);
  }

  return [...bySlug.values()]
    .filter((project) => !isInternalProjectName(project.entity.name))
    .filter(hasHumanNavigableContent)
    .sort((a, b) => a.entity.name.localeCompare(b.entity.name));
}

function normalizeCompileScope(projectTag: string | undefined): string | null {
  const trimmed = projectTag?.trim();
  if (!trimmed || trimmed === 'all' || trimmed === '*' || trimmed.toLowerCase() === 'project:all') {
    return null;
  }
  return trimmed.replace(/^project:/i, '');
}

function sameProjectScope(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase() || slugify(left) === slugify(right);
}

function semanticMatchesScope(sem: { tags: string[] }, projectScope: string | null): boolean {
  if (!projectScope) return true;
  return sem.tags.some((tag) => tag.startsWith('project:') && sameProjectScope(tag.replace(/^project:/, ''), projectScope));
}

function entityMatchesScope(entity: EntityInfo, projectScope: string | null): boolean {
  return !projectScope || sameProjectScope(entity.name, projectScope) || sameProjectScope(entity.slug, projectScope);
}

function episodicMatchesScope(ep: EpisodicEntry, projectScope: string | null): boolean {
  if (!projectScope) return true;
  // gap-13: structured `ep.scope`/`ep.tags` is the primary association; the
  // task-prefix-derived `project_scope` stays as a back-compat fallback. Both
  // sides are normalized through sameProjectScope (lowercase + slugify) so
  // `project:agent-assist-cr` compares equal regardless of which source it came
  // from.
  const structured = structuredEpisodicScope(ep);
  if (structured && sameProjectScope(structured, projectScope)) return true;
  return ep.project_scope != null && sameProjectScope(ep.project_scope, projectScope);
}

function sourceMatchesScope(source: SourceInfo, projectScope: string | null): boolean {
  if (!projectScope) return true;
  const sourceScope = source.project_tag.replace(/^project:/i, '');
  return sameProjectScope(sourceScope, projectScope);
}

// ─── Main compiler ──────────────────────────────────────────────────────────

export class WikiCompiler {
  constructor(private driver: Driver) {}

  async compile(outputDir: string, projectTag = 'all'): Promise<CompileV2Result> {
    const projectScope = normalizeCompileScope(projectTag);
    const result: CompileV2Result = {
      projects_compiled: 0,
      articles_compiled: 0,
      episodics_rendered: 0,
      library_pages: 0,
      topic_pages: 0,
      cross_project_pages: 0,
      output_dir: outputDir,
    };

    // OPT-9: serialize the clear-then-rebuild against any other writer (the MCP
    // autorefresh vs the wiki-service startup build both call compile() on the
    // shared mount). Acquired before the clear, released in the finally below, so
    // an overlapping compile waits its turn instead of deleting files mid-write.
    await acquireCompileLock(outputDir);
    try {
      return await this.compileLocked(outputDir, projectScope, result);
    } finally {
      await releaseCompileLock(outputDir);
    }
  }

  private async compileLocked(
    outputDir: string,
    projectScope: string | null,
    result: CompileV2Result,
  ): Promise<CompileV2Result> {
    // Clean the output directory's CONTENTS without removing the directory
    // itself. `outputDir` may be a Docker volume MOUNT POINT (the gap-15 shared
    // wiki_output volume); rm-ing a mount point fails with EBUSY. Clearing the
    // children is mount-point-safe and equivalent to starting from a fresh dir.
    // Skip the lockfile itself — it's how we hold this run's exclusivity, and
    // deleting it mid-compile would let an overlapping writer barge in.
    await mkdir(outputDir, { recursive: true });
    for (const entry of await readdir(outputDir)) {
      if (entry === COMPILE_LOCK_FILENAME) continue;
      await rm(join(outputDir, entry), { recursive: true, force: true });
    }

    // ── Phase 0: Pre-fetch shared data ─────────────────────────────

    // Fetch all semantics ONCE and build indexes for O(1) lookups
    const allSemantics = (await fetchAllSemantics(this.driver))
      .filter((sem) => semanticMatchesScope(sem, projectScope));

    // Index: entity name (lowercase) → semantics ABOUT that entity
    const semanticsByEntity = new Map<string, typeof allSemantics>();
    // Index: entity name (lowercase) → semantics that MENTION entity in content
    const semanticsMentioningEntity = new Map<string, typeof allSemantics>();
    // Index: tag → semantics carrying that tag
    const semanticsByTag = new Map<string, typeof allSemantics>();

    for (const sem of allSemantics) {
      // Build entity index (by ABOUT relationship)
      for (const entityName of sem.entities) {
        const key = entityName.toLowerCase();
        const existing = semanticsByEntity.get(key) ?? [];
        existing.push(sem);
        semanticsByEntity.set(key, existing);
      }

      // Build tag index
      for (const tag of sem.tags) {
        const existing = semanticsByTag.get(tag) ?? [];
        existing.push(sem);
        semanticsByTag.set(tag, existing);
      }
    }

    // Build mention index (which semantics mention an entity by name in content)
    // We need all unique entity names first, so defer this until after entity discovery

    // ── Phase 1: Discover all projects ────────────────────────────────

    const projectEntities = (await fetchAllProjects(this.driver))
      .filter((project) => entityMatchesScope(project, projectScope));
    const episodicOnlyScopes = (await fetchEpisodicProjectScopes(this.driver))
      .filter((scope) => !projectScope || sameProjectScope(scope, projectScope));

    // Build full project list: entity-based + episodic-only (virtual)
    let allProjectData: ProjectData[] = [];

    // OPT-58: accumulate every entity's episodics fetched in Phase 1 (the OPT-22
    // batched fetchEpisodicsForEntities scan) into a global name→episodics map, so
    // Phase 2 can REUSE it instead of re-running fetchEpisodicsForEntity per entity
    // (the per-entity result is identical — same predicate/ORDER/LIMIT, proven in
    // queries.test.ts). Keyed by entity NAME, which is project-independent, so it
    // stays correct across canonicalizeHumanProjects' project merges.
    const entityEpisodicsByName = new Map<string, EpisodicEntry[]>();

    // Entity-based projects
    for (const projectEntity of projectEntities) {
      const projectName = projectEntity.name;
      const projectScope = projectName; // e.g. "mars-fps"

      const [containedEntities, modifiedEntities, episodics] = await Promise.all([
        fetchProjectEntities(this.driver, projectName),
        fetchEntitiesModifiedByProject(this.driver, projectScope),
        fetchEpisodicsForProject(this.driver, projectScope),
      ]);

      // Merge contained and modified entities, dedup by id
      const entityMap = new Map<string, EntityInfo>();
      for (const e of containedEntities) entityMap.set(e.id, e);
      for (const e of modifiedEntities) {
        if (!entityMap.has(e.id)) entityMap.set(e.id, e);
      }
      const entities = [...entityMap.values()];

      // Build mention index for this project's entities (lazy, cached)
      for (const entity of entities) {
        const key = entity.name.toLowerCase();
        if (!semanticsMentioningEntity.has(key)) {
          const mentions = allSemantics.filter(
            (s) => s.content.toLowerCase().includes(key),
          );
          semanticsMentioningEntity.set(key, mentions);
        }
      }

      // Classify: substantive = 1+ semantic OR 1+ episodic mention
      const substantive: EntityInfo[] = [];
      const sparse: EntityInfo[] = [];

      // Batch-fetch episodics for all entities in this project in ONE :Episodic
      // scan (vs one full-label scan per entity). Same per-entity ORDER/LIMIT.
      const entityEpisodicMap = await fetchEpisodicsForEntities(
        this.driver,
        entities.map((e) => e.name),
      );
      // OPT-58: feed the global map so Phase 2 reuses these results.
      for (const [name, eps] of entityEpisodicMap) entityEpisodicsByName.set(name, eps);

      for (const entity of entities) {
        const key = entity.name.toLowerCase();
        const semCount = (semanticsByEntity.get(key) ?? []).length;
        const entityEpisodics = entityEpisodicMap.get(entity.name) ?? [];
        const semMentions = semanticsMentioningEntity.get(key) ?? [];
        if (semCount > 0 || entityEpisodics.length > 0 || semMentions.length > 0) {
          substantive.push(entity);
        } else {
          sparse.push(entity);
        }
      }

      // Build semantics for project-level data from pre-fetched index
      const semantics: ProjectData['semantics'] = [];
      const seenSemanticIds = new Set<string>();
      for (const entity of entities) {
        const sems = semanticsByEntity.get(entity.name.toLowerCase()) ?? [];
        for (const sem of sems) {
          if (seenSemanticIds.has(sem.id)) continue;
          seenSemanticIds.add(sem.id);
          semantics.push({
            id: sem.id,
            content: sem.content,
            confidence: sem.confidence,
            tags: sem.tags,
            entities: sem.entities.filter((e) => e !== entity.name),
          });
        }
      }

      allProjectData.push({
        entity: projectEntity,
        entities,
        substantive_entities: substantive,
        sparse_entities: sparse,
        episodics,
        semantics,
      });
    }

    // Episodic-only projects (virtual)
    for (const scope of episodicOnlyScopes) {
      const episodics = await fetchEpisodicsForProject(this.driver, scope);
      if (episodics.length === 0) continue;

      const virtualEntity: EntityInfo = {
        id: `virtual-${scope}`,
        name: scope,
        type: 'project',
        slug: slugify(scope),
        description: `Project discovered from episodic entries (no Entity node).`,
        created_at: episodics[episodics.length - 1]?.created_at ?? new Date().toISOString(),
      };

      allProjectData.push({
        entity: virtualEntity,
        entities: [],
        substantive_entities: [],
        sparse_entities: [],
        episodics,
        semantics: [],
      });
    }

    allProjectData = canonicalizeHumanProjects(allProjectData);

    // ── Phase 2: Build entity articles per project ────────────────────

    for (const project of allProjectData) {
      const projectSlug = slugify(project.entity.name);
      const projectDir = join(outputDir, 'projects', projectSlug);

      // Build articles for substantive entities
      for (const entity of project.substantive_entities) {
        // OPT-58: reuse the Phase-1 batched episodics (identical per-entity result)
        // instead of re-fetching per entity — one fewer DB round-trip per article.
        const entityEpisodics = entityEpisodicsByName.get(entity.name) ?? [];
        const [entitySemantics, hierarchy, backlinks, seeAlso, sources, inboundCount] =
          await Promise.all([
            fetchSemanticsForEntity(this.driver, entity.name),
            fetchHierarchy(this.driver, entity.name),
            fetchBacklinks(this.driver, entity.name),
            fetchRelatedEntities(this.driver, entity.name),
            fetchSourcesForEntity(this.driver, entity.name),
            fetchInboundLinkCount(this.driver, entity.name),
          ]);
        const semantics = entitySemantics.filter((sem) => semanticMatchesScope(sem, projectScope));

        // Group semantics by domain tag into sections
        const sectionMap = new Map<string, ResolvedClaim[]>();
        let totalConfidence = 0;
        let confidenceCount = 0;

        for (const sem of semantics) {
          const otherRefs = sem.entity_refs.filter((r) => r !== entity.name);
          const claim: ResolvedClaim = {
            content: resolveInlineLinks(sem.content, otherRefs, projectSlug),
            confidence: sem.confidence,
            memberry_id: sem.id,
            source_refs: [],
            entity_refs: otherRefs,
          };

          totalConfidence += sem.confidence;
          confidenceCount++;

          const domainTag = sem.tags.find((t) => !t.startsWith('project:')) ?? 'general';
          const existing = sectionMap.get(domainTag) ?? [];
          existing.push(claim);
          sectionMap.set(domainTag, existing);
        }

        const sections = [...sectionMap.entries()].map(([tag, claims]) => ({
          heading: tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, ' '),
          claims,
        }));

        const allTags = [...new Set(semantics.flatMap((s) => s.tags))];
        const avgConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : 0;

        const frontmatter: ArticleFrontmatter = {
          entity: slugify(entity.name),
          type: entity.type,
          confidence: avgConfidence,
          sources: sources.length,
          inbound_links: inboundCount,
          last_compiled: new Date().toISOString().split('T')[0],
          memberry_id: entity.id,
          aliases: entity.aliases ?? [],
          tags: allTags,
          parent: hierarchy.parent,
          children: hierarchy.children.length > 0 ? hierarchy.children : undefined,
        };

        const articleData = {
          entity,
          frontmatter,
          sections,
          backlinks,
          see_also: seeAlso,
          sources,
          hierarchy,
          projectSlug,
        };

        const markdown = renderEntityArticle(articleData, entityEpisodics);
        await writeMarkdown(join(projectDir, `${slugify(entity.name)}.md`), markdown);
        result.articles_compiled++;
        result.episodics_rendered += entityEpisodics.length;
      }

      // Graph page
      const graphMarkdown = renderProjectGraph(project);
      await writeMarkdown(join(projectDir, '_graph.md'), graphMarkdown);

      // Project index
      const indexMarkdown = renderProjectIndex(project);
      await writeMarkdown(join(projectDir, '_index.md'), indexMarkdown);

      result.projects_compiled++;
    }

    // ── Phase 3: Library ──────────────────────────────────────────────

    const allSources = (await fetchAllSources(this.driver))
      .filter((source) => sourceMatchesScope(source, projectScope));

    if (allSources.length > 0) {
      const libraryDir = join(outputDir, 'library');
      const claimCounts = new Map<string, number>();

      for (const source of allSources) {
        const claims = await fetchClaimsForSource(this.driver, source.id);
        claimCounts.set(source.id, claims.length);

        const entityLinks = [...new Set(claims.flatMap((c) => c.entity_refs))];

        const page: LibraryPage = {
          source,
          claims,
          entity_links: entityLinks,
        };

        const markdown = renderLibraryPage(page);
        await writeMarkdown(join(libraryDir, `${slugify(source.title)}.md`), markdown);
        result.library_pages++;
      }

      // Library index
      const libraryIndexMarkdown = renderLibraryIndex(allSources, claimCounts);
      await writeMarkdown(join(libraryDir, '_index.md'), libraryIndexMarkdown);
    } else {
      // Always create library directory with empty-state index
      const libraryDir = join(outputDir, 'library');
      const emptyLibrary = renderFrontmatter({ title: 'Source Library', compiled: new Date().toISOString().split('T')[0], sources: 0 }) + '\n\n# Source Library\n\n*No sources indexed yet. Sources will appear here as they are added to the knowledge graph.*\n';
      await writeMarkdown(join(libraryDir, '_index.md'), emptyLibrary);
    }

    // ── Phase 4: Topics ───────────────────────────────────────────────

    const allTags = projectScope
      ? [...semanticsByTag.entries()].map(([tag, sems]) => ({
          tag,
          count: sems.length,
          projects: [projectScope],
        }))
      : await fetchAllTags(this.driver);
    const qualifiedTags = allTags.filter((t) => projectScope ? t.count > 0 : (t.count >= 3 || t.projects.length >= 2));

    // Build tag→projects map from pre-fetched allSemantics (no extra query)
    const tagProjectMap = new Map<string, Set<string>>();
    for (const sem of allSemantics) {
      const projectTag = sem.tags.find((t) => t.startsWith('project:'));
      const proj = projectTag ? projectTag.replace('project:', '') : null;
      for (const tag of sem.tags) {
        if (tag.startsWith('project:')) continue;
        const projects = tagProjectMap.get(tag) ?? new Set();
        if (proj) projects.add(proj);
        tagProjectMap.set(tag, projects);
      }
    }

    // Merge: count >= 3 OR 2+ projects
    const topicTagSet = new Set(qualifiedTags.map((t) => t.tag));
    for (const [tag, projects] of tagProjectMap) {
      if (projects.size >= 2) topicTagSet.add(tag);
    }

    // Pre-build co-occurring tag map: for each tag, which other topic-tags co-occur
    // This avoids the O(topics * allSemantics) nested scan
    const coTagMap = new Map<string, Set<string>>();
    for (const sem of allSemantics) {
      const nonProjectTags = sem.tags.filter((t) => !t.startsWith('project:'));
      for (const tag of nonProjectTags) {
        if (!topicTagSet.has(tag)) continue;
        for (const other of nonProjectTags) {
          if (other !== tag && topicTagSet.has(other)) {
            const existing = coTagMap.get(tag) ?? new Set();
            existing.add(other);
            coTagMap.set(tag, existing);
          }
        }
      }
    }

    if (topicTagSet.size > 0) {
      const topicsDir = join(outputDir, 'topics');
      const topicDataList: TopicData[] = [];

      for (const tag of topicTagSet) {
        // Use pre-indexed semanticsByTag instead of per-tag DB query
        const tagSems = semanticsByTag.get(tag) ?? [];

        // Determine projects this tag appears in
        const projects = new Set<string>();
        const entities = new Set<string>();
        const semanticsWithProject: TopicData['semantics'] = [];

        for (const sem of tagSems) {
          for (const e of sem.entities) entities.add(e);
          // Project is already available from the full semantic data (no .find() needed)
          const projectTag = sem.tags.find((t) => t.startsWith('project:'));
          const proj = projectTag ? projectTag.replace('project:', '') : 'unscoped';
          projects.add(proj);

          semanticsWithProject.push({
            content: sem.content,
            confidence: sem.confidence,
            project: proj,
            entities: sem.entities,
          });
        }

        // Use pre-built co-tag map instead of scanning allSemantics
        const coTags = coTagMap.get(tag) ?? new Set<string>();

        const topicData: TopicData = {
          tag,
          slug: slugify(tag),
          semantics: semanticsWithProject,
          episodics: [], // Could fetch scoped episodics but keeping it light
          projects: [...projects],
          related_tags: [...coTags],
          related_entities: [...entities],
        };

        topicDataList.push(topicData);

        const markdown = renderTopicPage(topicData);
        await writeMarkdown(join(topicsDir, `${slugify(tag)}.md`), markdown);
        result.topic_pages++;
      }

      // Topics index
      const topicIndexMarkdown = renderTopicIndex(topicDataList);
      await writeMarkdown(join(topicsDir, '_index.md'), topicIndexMarkdown);
    } else {
      // Always create topics directory with empty-state index
      const topicsDir = join(outputDir, 'topics');
      const emptyTopics = renderFrontmatter({ title: 'Topics', compiled: new Date().toISOString().split('T')[0], topics: 0 }) + '\n\n# Topics\n\n*No topics discovered yet. Topics emerge when tags appear across multiple projects or reach critical mass.*\n';
      await writeMarkdown(join(topicsDir, '_index.md'), emptyTopics);
    }

    // ── Phase 5: Cross-project pages ──────────────────────────────────

    // Decisions page
    const decisionsMarkdown = renderDecisionsPage(allSemantics);
    await writeMarkdown(join(outputDir, '_decisions.md'), decisionsMarkdown);
    result.cross_project_pages++;

    // Patterns page
    const patternsMarkdown = renderPatternsPage(allSemantics);
    await writeMarkdown(join(outputDir, '_patterns.md'), patternsMarkdown);
    result.cross_project_pages++;

    // Recent changes — attribute each episode to its project: task prefix, else a
    // [project:…] prefix in content, else a known project named in the session_id.
    const knownProjectSlugs = [...new Set([
      ...allProjectData.map((p) => slugify(p.entity.name)),
      ...episodicOnlyScopes.map((s) => slugify(s)),
    ])].filter(Boolean).sort((a, b) => b.length - a.length);
    const recentEpisodics = (await fetchRecentEpisodics(this.driver, 50))
      .map((ep) => ({ ...ep, project_scope: deriveEpisodicScope(ep, knownProjectSlugs) }))
      .filter((ep) => episodicMatchesScope(ep, projectScope));
    const recentMarkdown = renderRecentChanges(recentEpisodics);
    await writeMarkdown(join(outputDir, '_recent.md'), recentMarkdown);
    result.cross_project_pages++;

    // ── Phase 6: Portal homepage ──────────────────────────────────────

    const graphStats = await fetchGraphStats(this.driver);
    const portalStats = projectScope
      ? {
          total_entities: allProjectData.reduce((sum, project) => sum + project.entities.length, 0),
          // Raw Fact nodes aren't tracked per-project here; fall back to the global count.
          total_facts: graphStats.total_facts,
          total_semantics: allSemantics.length,
          total_episodics: allProjectData.reduce((sum, project) => sum + project.episodics.length, 0),
          total_sources: allSources.length,
        }
      : graphStats;

    // Derived counts, computed from the same in-scope data the pages render — so the
    // portal tiles always match the pages and auto-update on every recompile.
    const totalPatterns = crossProjectPatternTags(allSemantics).length;
    const totalDecisions = allSemantics.filter((sem) => {
      if (sem.confidence < DECISION_CONFIDENCE_THRESHOLD) return false;
      const project = (sem.tags.find((t) => t.startsWith('project:')) ?? 'project:unscoped').replace('project:', '');
      return !isInternalProjectName(project);
    }).length;
    const totalTopics = result.topic_pages;
    const humanRecentEpisodics = recentEpisodics.filter(
      (ep) => !ep.project_scope || !isInternalProjectName(ep.project_scope),
    );

    const portalData: PortalData = {
      projects: allProjectData.map((p) => ({
        name: p.entity.name,
        slug: slugify(p.entity.name),
        description: p.entity.description ?? null,
        entity_count: p.entities.length,
        semantic_count: p.semantics.length,
        episodic_count: p.episodics.length,
        last_activity: p.episodics[0]?.created_at ?? null,
      })),
      recent_changes: humanRecentEpisodics.slice(0, 10),
      top_decisions: allSemantics
        .filter((s) => s.confidence >= 0.7)
        .filter((s) => {
          const project = (s.tags.find((t) => t.startsWith('project:')) ?? 'project:unscoped').replace('project:', '');
          return !isInternalProjectName(project);
        })
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 15)
        .map((s) => ({
          content: s.content,
          confidence: s.confidence,
          project: (s.tags.find((t) => t.startsWith('project:')) ?? 'project:unscoped').replace('project:', ''),
          entities: s.entities,
        })),
      stats: {
        ...portalStats,
        total_projects: allProjectData.length,
        total_decisions: totalDecisions,
        total_patterns: totalPatterns,
        total_topics: totalTopics,
      },
    };

    const portalMarkdown = renderPortalHomepage(portalData);
    await writeMarkdown(join(outputDir, '_index.md'), portalMarkdown);

    // OPT-10: write a SINGLE TOP-LEVEL sentinel LAST, after every page is on disk.
    // The served viewer watches the wiki dir with fs.watch, which is unreliable for
    // nested dirs (projects/<slug>/<entity>.md) on Linux — so an MCP-side recompile
    // could leave the viewer's sidebar/search cache stale. A top-level file is the
    // one path fs.watch reliably reports; the viewer rebuilds its full cache when
    // this marker changes. Written last so its mtime bump means "compile is done".
    await writeFile(join(outputDir, COMPILED_MARKER_FILENAME), new Date().toISOString(), 'utf-8');

    return result;
  }
}
