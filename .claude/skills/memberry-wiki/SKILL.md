---
name: memberry-wiki
description: "Wiki operations for MemBerry knowledge bases. Compile the graph into a browsable interlinked wiki, ingest source documents, run health checks. Use when the user wants to: build/update the wiki, ingest research material, check knowledge quality, browse the knowledge base."
allowed-tools: Bash, Read, Write, Glob, Grep, mcp__memberry__berry_tools, mcp__memberry__berry_compile, mcp__memberry__berry_ingest, mcp__memberry__berry_lint, mcp__memberry__berry_braindump, mcp__memberry__berry_wiki_sync, mcp__memberry__berry_query, mcp__memberry__berry_provenance, mcp__memberry__berry_load, mcp__memberry__berry_store, mcp__memberry__berry_arch_relate
argument-hint: "compile [dir] | ingest <path> [type] | braindump <text|path> | sync <path> | lint [checks] | serve [port]"
---

# MemBerry Wiki

Build and maintain a knowledge wiki from the MemBerry graph.

## Subcommands

Every wiki tool is Tier-2. Enable the domain once per session:

```
berry_tools(action: "enable", domain: "wiki")
```

### compile [output_dir]

Compile the knowledge graph into interlinked markdown wiki pages. Publication is
automatic after graph mutations, so run this for explicit verification or recovery
rather than as a routine step.

1. Determine project tag from MemBerry Memory config.
2. Default output dir: `./wiki/`
3. Call:
   ```
   berry_compile(
     project_tag: "project:<tag>",
     output_dir: "<dir>",
     format: "obsidian",
     emit_graph: true
   )
   ```
4. Report: articles compiled, links resolved, index files generated.

**Output structure:**
```
wiki/
  _index.md            # Entity index grouped by type
  _decisions.md        # All claims sorted by confidence
  _graph/
    graph.md           # Mermaid diagram of entity relationships
    entities.json      # Entity metadata for visualization
    edges.json         # All relationships
  <entity-slug>.md     # One article per entity with [[wikilinks]]
```

### ingest <path> [type]

Ingest a source document. Auto-extracts entities and claims.

1. Determine source type: article, paper, repo, dataset, note, reference. Infer from extension or ask.
2. Call:
   ```
   berry_ingest(
     source_path: "<path>",
     source_type: "<type>",
     project_tag: "project:<tag>"
   )
   ```
3. Report: source ID, entities found, claims extracted, citations created.

**Batch ingestion:** For multiple files, loop over them:
```
for each file in <directory>:
  berry_ingest(source_path: file, source_type: "article", project_tag: "project:<tag>")
```

### lint [checks]

Run health checks.

1. Default: run all 10 checks.
2. Specific checks: `lint orphan_pages contradictions`
3. Call:
   ```
   berry_lint(project_tag: "project:<tag>", checks: ["<check1>", "<check2>"])
   ```
4. Present results by severity (ERROR > WARNING > INFO).

### braindump <text|path>

Capture human-authored context — role, preferences, stack, conventions — as durable memory.

1. Pick the scope tag. Any `project:<tag>` works; `project:user-personal` is the usual home for personal context.
2. Call:
   ```
   berry_braindump(
     content: "<verbatim text>",
     scope: "project:<tag>",
     compile: false
   )
   ```
   Pass `source_path` instead of `content` to dump a file.
3. Keep `compile: false` — publication follows the graph mutation on its own.
4. Report: source ID, entities found, claims extracted.

### sync <path>

Reconcile a human-edited wiki page back into the graph. Changed claims become corrections; newly added lines become new human-authored memories, matched through the per-claim anchors `berry_compile` emits.

1. Call:
   ```
   berry_wiki_sync(
     path: "<edited-page>.md",
     project_tag: "project:<tag>"
   )
   ```
   `project_tag` is optional — the file's frontmatter `project:` tag is used when omitted.
2. Verify the mutation landed, then confirm the automatic republication picked it up.

### serve [port]

Start the wiki viewer. Default port: 3200.

The viewer is a self-hosted web app that renders the compiled wiki as navigable HTML:
- Clickable `[[wikilinks]]` between articles
- Sidebar with metadata and TOC
- Full-text search
- Dark theme

## Normal path

Graph mutations schedule a debounced full publication automatically. Verify `/readyz`
publication state and the served content; do not add routine manual compile steps.

```
1. Ingest sources        → berry_ingest (confined source documents)
2. Capture human context → berry_braindump
3. Store agent work      → berry_store (automatic via CLAUDE.md)
4. Reconcile page edits  → berry_wiki_sync
5. Lint for quality      → berry_lint (find issues)
6. Fix issues            → berry_store, berry_arch_relate, berry_ingest
7. Browse                → read markdown or start viewer
```

Each cycle enriches the knowledge base. Queries and explorations compound.

## Recovery and verification

Use `berry_compile(project_tag: "all")` only for explicit verification or recovery.
Scoped output is not the served cross-project generation. Treat recurring pointer,
lock, generation, or publication-counter errors as lifecycle faults rather than
papering over them with repeated compiles.
