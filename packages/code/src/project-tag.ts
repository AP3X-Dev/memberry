// packages/code/src/project-tag.ts
// Canonical project-tag normalization, shared by the indexer, tools, and search
// scope filtering. A project tag is normalized ONCE here to `project:<slug>` so
// the value stored on Symbol nodes (s.project_tag) and the value a query filters
// by are byte-identical regardless of which surface produced it.

/**
 * Slugify a raw project name to a tag-safe slug: lowercase, non-alphanumeric
 * runs collapsed to a single '-', and leading/trailing '-' stripped. Mirrors the
 * wiki/core slug semantics so the same name yields the same slug everywhere.
 */
function slugifyTag(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalize a project identifier to the canonical `project:<slug>` form.
 *
 * Accepts either a raw project name ("My App") or an already-prefixed tag
 * ("project:my-app"). A leading `project:` (any case) is stripped before
 * slugifying so it is never doubled. Returns `undefined` when the input is
 * empty/whitespace or slugifies to nothing — callers treat that as "no scope",
 * preserving backward-compatible behavior when no project is supplied.
 */
export function canonicalProjectTag(raw: string | undefined | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const withoutPrefix = trimmed.replace(/^project:/i, '').trim();
  const slug = slugifyTag(withoutPrefix);
  return slug ? `project:${slug}` : undefined;
}

/**
 * Resolve the canonical project tag from a tool's two optional inputs.
 * An explicit `project_tag` wins (normalized); otherwise it is derived from
 * `project_name`. Returns `undefined` when neither is usable.
 */
export function resolveProjectTag(
  projectTag: string | undefined | null,
  projectName: string | undefined | null,
): string | undefined {
  return canonicalProjectTag(projectTag) ?? canonicalProjectTag(projectName);
}
