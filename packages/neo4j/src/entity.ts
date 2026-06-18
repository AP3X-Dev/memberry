// packages/neo4j/src/entity.ts
// Minimal entity ops used by AMPService project-tag enforcement (Bucket B).
// Kept narrow — broader entity manipulation lives in EntityResolver / arch package.

import { type Driver } from 'neo4j-driver';

export class EntityStore {
  constructor(private driver: Driver) {}

  /** Return all project Entity names (lowercased dedup not applied — caller can normalize). */
  async listProjectNames(): Promise<string[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (e:Entity {type: 'project'}) RETURN e.name AS name ORDER BY name`,
      );
      return result.records.map((r) => r.get('name') as string);
    } finally {
      await session.close();
    }
  }

  /**
   * Idempotent upsert of a project Entity. Used to auto-create a placeholder
   * when berry_store sees a never-before-seen project tag.
   * - If an Entity with the same name already exists, PROMOTE it to type='project'
   *   (gap-14) so it becomes visible to wiki/lint, which only match
   *   Entity{type:'project'}. It only ever sets type TO 'project' (a same-named
   *   module/concept IS promoted, since that name is now serving as a project
   *   root); it never sets the type to anything else.
   * - Otherwise create a new Entity with type='project'.
   */
  async upsertProject(name: string, description?: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (e:Entity {name: $name})
         ON CREATE SET
           e.id = $id,
           e.type = 'project',
           e.description = $description,
           e.created_at = datetime(),
           e.auto_created = true
         ON MATCH SET
           e.last_seen = datetime(),
           e.type = 'project'`,
        {
          name,
          id: `auto-proj-${name.toLowerCase().replace(/[^\w-]/g, '-')}-${Date.now()}`,
          description: description ?? null,
        },
      );
    } finally {
      await session.close();
    }
  }
}
