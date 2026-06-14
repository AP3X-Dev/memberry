// packages/mcp/src/safe-regex.ts
//
// Conservative, best-effort ReDoS screen for agent-supplied regex patterns.
//
// SECURITY CONTEXT (OPT-06): berry_grep compiles a semi-trusted `pattern` with
// `new RegExp(...)` and runs `.test()/.exec()` JS-side on the single-threaded
// MCP event loop against untrusted stored node content. A pattern with
// catastrophic backtracking (e.g. `(a+)+$`) can pin the event loop for an
// unbounded time — one call becomes a whole-deployment DoS.
//
// This module is a NO-DEPENDENCY INTERIM mitigation, NOT a proof of safety:
//   1. assertSafeRegex() statically rejects patterns whose SHAPE is a classic
//      catastrophic-backtracking footgun (nested quantifiers, quantified
//      alternations, huge bounded repetitions) before they ever compile/run.
//   2. capScanText() bounds the length of any string handed to .test()/.exec()
//      so even a pattern that slips the screen has bounded input.
//
// The heuristic is intentionally SIMPLE and conservative. It cannot catch every
// exponential pattern (see KNOWN GAPS at the bottom). The robust fix is a
// linear-time regex engine (e.g. the `re2` package, which never backtracks);
// that requires a new runtime dependency and is DEFERRED to a separate, human-
// approved cycle (tracked as a Blocked backlog item). Until then, this screen
// plus the input cap removes the practical event-loop-DoS surface.

/**
 * Max characters of any single value/content handed to a JS RegExp.
 * Kept deliberately small: the shape screen does NOT catch *polynomial* ReDoS
 * (sequential non-nested quantifiers like `a*a*c`), which is bounded only by
 * this cap — at O(n^2), 50k chars is a multi-second event-loop stall, 4k is low
 * single-digit ms. Grep snippets only need ~±100 chars of match context, so a
 * 4k scan window costs ~nothing in usefulness. The robust fix (re2 linear-time
 * engine) is deferred to a human-approved cycle; until then this tight cap is
 * the main defense against polynomial/lookaround backtracking that slips the
 * shape screen.
 */
export const MAX_SCAN_TEXT_LEN = 4_000;

/** Reject quantifier upper/lower bounds larger than this (e.g. `a{2000}`). */
export const MAX_REPETITION = 1000;

/** Thrown when a pattern is rejected by the static ReDoS screen. */
export class UnsafeRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeRegexError';
  }
}

/**
 * Slice a string to MAX_SCAN_TEXT_LEN before it is matched against a JS RegExp.
 * Bounds the work any single .test()/.exec() can do, independent of the screen.
 */
export function capScanText(text: string, max: number = MAX_SCAN_TEXT_LEN): string {
  if (!text) return text;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Static, conservative ReDoS screen. Throws UnsafeRegexError if `pattern` shows
 * a classic catastrophic-backtracking shape. Best-effort only — see module doc.
 *
 * Rules (any one fires → reject):
 *   1. Nested quantifier: a quantifier applied to a group whose body itself
 *      contains a quantifier — e.g. `(a+)+`, `(a*)*`, `(a+)*`, `(.*)+`,
 *      `((a)*)*`. Detected as `)` followed by a quantifier (`*`,`+`,`?`,`{`)
 *      where the matched group's body contains `*`,`+`, or `{`.
 *   2. Quantified alternation: a group containing `|` immediately followed by a
 *      quantifier — e.g. `(a|a)*`, `(a|ab)+`, `(a|aa){2,}`. Overlapping
 *      branches under a quantifier are the textbook exponential case; we reject
 *      ALL quantified alternations as a conservative over-approximation.
 *   3. Huge repetition: any `{n}` / `{n,}` / `{n,m}` bound with n or m above
 *      MAX_REPETITION — e.g. `a{2000}`, `a{1001,}`.
 */
export function assertSafeRegex(pattern: string): void {
  // Rule 3: excessive numeric repetition bounds anywhere in the pattern.
  // Matches {n}, {n,}, {n,m}; checks every captured number against the cap.
  const repRe = /\{\s*(\d+)\s*(?:,\s*(\d*)\s*)?\}/g;
  for (let m = repRe.exec(pattern); m !== null; m = repRe.exec(pattern)) {
    const lo = Number(m[1]);
    const hi = m[2] != null && m[2] !== '' ? Number(m[2]) : undefined;
    if (lo > MAX_REPETITION || (hi != null && hi > MAX_REPETITION)) {
      throw new UnsafeRegexError(
        `repetition bound {${m[1]}${m[2] != null ? ',' + m[2] : ''}} exceeds the maximum of ${MAX_REPETITION}`,
      );
    }
  }

  // Rules 1 & 2 work on group bodies. Walk the string tracking parenthesis
  // depth so each ')' can be paired with the '(' that opened it, then inspect
  // the group body and the character immediately following the ')'. Escaped
  // parens (`\(` / `\)`) and character classes (`[...]`, where parens are
  // literal) are skipped so they don't create phantom groups.
  const groupStart: number[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (ch === '\\') {
      i++; // skip the escaped character
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      groupStart.push(i);
      continue;
    }
    if (ch === ')') {
      const start = groupStart.pop();
      if (start == null) continue; // unbalanced ')' — let new RegExp surface it
      const body = pattern.slice(start + 1, i);
      const next = pattern[i + 1];
      const quantified = next === '*' || next === '+' || next === '?' || next === '{';

      if (quantified) {
        // Rule 2: quantified alternation (overlapping-branch exponential).
        if (containsTopLevelAlternation(body)) {
          throw new UnsafeRegexError(
            'quantified alternation group (e.g. "(a|b)*") can backtrack catastrophically and is rejected',
          );
        }
        // Rule 1: nested quantifier — group body itself contains a quantifier.
        if (bodyContainsQuantifier(body)) {
          throw new UnsafeRegexError(
            'nested quantifier (e.g. "(a+)+") can backtrack catastrophically and is rejected',
          );
        }
      }
    }
  }
}

/** True if the group body contains a quantifier metachar (`*`, `+`, or `{`) at
 *  any nesting level, ignoring escapes and character-class contents. */
function bodyContainsQuantifier(body: string): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '*' || ch === '+' || ch === '{') return true;
  }
  return false;
}

/** True if the group body has a top-level `|` alternation (not inside a nested
 *  group or character class), ignoring escapes. */
function containsTopLevelAlternation(body: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { if (depth > 0) depth--; continue; }
    if (ch === '|' && depth === 0) return true;
  }
  return false;
}
