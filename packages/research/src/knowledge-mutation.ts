import type { Session } from 'neo4j-driver';
import { bumpKnowledgeEpoch } from '@memberry/neo4j';

/** Research writers currently own the default-tenant graph. Their evidence and
 * shared Entity topology invalidate the tenant aggregate used by rendered
 * contexts; no project-specific authorization is inferred from this epoch. */
export function runResearchMutation(
  session: Session,
  query: string,
  parameters: Record<string, unknown> = {},
) {
  return session.executeWrite(async (tx) => {
    const result = await tx.run(query, parameters);
    await bumpKnowledgeEpoch(tx, { tenantId: 'default', projectScope: null });
    return result;
  });
}
