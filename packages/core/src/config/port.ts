// packages/core/src/config/port.ts
//
// Single source of truth for resolving the MCP server port. Three call sites
// must agree on it: server.ts (binds the port), readyz-check.ts (probes it for
// readiness), and the CLI's resolveUrl (composes the URL clients connect to).
// When they disagreed, two real failures occurred:
//   1. Empty-string env. A systemd EnvironmentFile started from .env.example
//      sets `PORT=` (empty). `??` only coalesces `undefined`, so
//      `'' ?? MCP_PORT` kept the empty string → `parseInt('')` is NaN →
//      `listen(NaN)` bound a RANDOM ephemeral port while /readyz probed 3101
//      and reported the server down.
//   2. Inverted precedence. server.ts preferred PORT while readyz-check.ts
//      preferred MCP_PORT, so when both were set to different values the bound
//      port and the readiness probe targeted different ports.
// Precedence is PORT, then MCP_PORT, then the fallback — matching .env.example's
// documented "PORT is checked first (PaaS compatibility)".

const DEFAULT_MCP_PORT = 3101;

/**
 * Resolve the MCP port from an env map. Uses `||` (not `??`) so an empty string
 * from a systemd EnvironmentFile falls through to the next source instead of
 * poisoning the parse, then validates the range, falling back (with a warning on
 * a present-but-invalid value) to `fallback`.
 */
export function resolvePort(
  env: Record<string, string | undefined> = process.env,
  fallback: number = DEFAULT_MCP_PORT,
): number {
  const raw = (env['PORT'] || env['MCP_PORT'] || '').trim();
  if (raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  console.warn(`[memberry] ignoring invalid port "${raw}"; using ${fallback}`);
  return fallback;
}
