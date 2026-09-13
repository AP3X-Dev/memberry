/** Legacy unit drivers model the data query only. Keep those assertions, and
 * provide the separate authoritative epoch receipt inside executeWrite. The
 * rollback/receipt protocol itself is covered in knowledge-mutation.test.ts. */
export function withKnowledgeTransactions<T extends { run: (...args: never[]) => unknown }>(session: T) {
  return Object.assign(session, {
    executeWrite: async (work: (tx: { run: (query: string, parameters: Record<string, unknown>) => unknown }) => Promise<unknown>) => work({
      run: (query: string, parameters: Record<string, unknown>) =>
        query.includes('AS knowledgeEpoch')
          ? Promise.resolve({ records: [{ get: () => '1' }] })
          : (session.run as (query: string, parameters: Record<string, unknown>) => unknown)(query, parameters),
    }),
  });
}
