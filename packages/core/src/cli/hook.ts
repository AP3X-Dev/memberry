// packages/core/src/cli/hook.ts
//
// `memberry hook <agent> <event>` — the harness-driven entry point. Reads the hook
// payload as JSON on stdin, dispatches to the agent adapter, and writes the
// adapter's output JSON on stdout. ALWAYS exits 0 with at least `{}` so a hook
// can never block or fail the user's turn.

import { createCoreServices } from '../services-factory.js';
import {
  claudeSessionStart,
  claudeUserPrompt,
  claudePreCompact,
  claudeSessionEnd,
  type ClaudeHookEvent,
  type ClaudeHookInput,
} from './adapters/claude.js';

const CLAUDE_EVENTS: ClaudeHookEvent[] = ['session-start', 'user-prompt', 'pre-compact', 'session-end'];

/** Idle window (ms): how long stdin may stay silent before we give up waiting. */
const STDIN_IDLE_MS = 1000;

/**
 * Read all of stdin as a string. Returns '' immediately if stdin is a TTY.
 *
 * The guard is an IDLE timeout, not an absolute cap: every incoming chunk resets
 * it, so a large payload that streams in slowly (each chunk < the idle window) is
 * read in full. The timer only fires when stdin is genuinely silent — i.e. the
 * upstream never closes the pipe. This prevents the silent truncation that an
 * absolute setTimeout caused for slow/large payloads.
 */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let settled = false;
    let guard: ReturnType<typeof setTimeout>;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(data);
    };
    const arm = (): void => {
      clearTimeout(guard);
      guard = setTimeout(done, STDIN_IDLE_MS);
      guard.unref?.();
    };
    // Arm the idle guard, then reset it on every chunk so an in-flight payload is
    // never cut off mid-stream.
    arm();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; arm(); });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function dispatchClaude(
  event: ClaudeHookEvent,
  input: ClaudeHookInput,
): Promise<Record<string, unknown>> {
  const core = createCoreServices();
  try {
    switch (event) {
      case 'session-start': return await claudeSessionStart(core, input);
      case 'user-prompt': return await claudeUserPrompt(core, input);
      case 'pre-compact': return await claudePreCompact(core, input);
      case 'session-end': return await claudeSessionEnd(core, input);
    }
  } finally {
    await core.close();
  }
}

/** Entry: argv is everything after `memberry hook`, i.e. [agent, event]. */
export async function runHookCommand(argv: string[]): Promise<void> {
  const [agent, event] = argv;
  let output: Record<string, unknown> = {};

  try {
    const raw = await readStdin();
    const input = raw.trim() ? (JSON.parse(raw) as ClaudeHookInput) : {};

    if (agent === 'claude') {
      if (CLAUDE_EVENTS.includes(event as ClaudeHookEvent)) {
        output = await dispatchClaude(event as ClaudeHookEvent, input);
      } else {
        process.stderr.write(`[memberry-hook] unknown claude event: ${event}\n`);
      }
    } else {
      process.stderr.write(`[memberry-hook] unknown agent: ${agent} (expected: claude)\n`);
    }
  } catch (err) {
    // Fail-open: log to stderr, emit empty context, exit 0.
    process.stderr.write(`[memberry-hook] error: ${err instanceof Error ? err.message : String(err)}\n`);
    output = {};
  }

  process.stdout.write(JSON.stringify(output));
}
