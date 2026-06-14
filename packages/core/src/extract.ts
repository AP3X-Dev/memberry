// packages/core/src/extract.ts
// Extracts structured subject-predicate-object facts from prose using OpenAI.

import OpenAI from 'openai';
import type { FactInput } from './types.js';
import { normalizePredicate } from './predicates.js';

// ─── Transient error detection ─────────────────────────────────────────────

/**
 * Determines if an error is transient (network, rate limit) and worth retrying.
 * Non-transient errors (parse failures, validation, auth) should not be retried.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof OpenAI.RateLimitError) return true;
  if (err instanceof OpenAI.APIConnectionError) return true;
  if (err instanceof OpenAI.InternalServerError) return true;
  // Generic network errors
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('etimedout') || msg.includes('socket hang up')) return true;
    if (msg.includes('429') || msg.includes('rate limit')) return true;
    if (msg.includes('503') || msg.includes('502') || msg.includes('500')) return true;
  }
  return false;
}

// ─── Response validation ────────────────────────────────────────────────────

interface RawFact {
  subject: string;
  predicate: string;
  object: string;
}

// ─── Anti-poisoning sanity bounds ─────────────────────────────────────────────
// Facts are extracted from FULLY UNTRUSTED stored content, so the LLM's output is
// attacker-influenceable. We can't use a fixed predicate allowlist (predicates are
// open-ended: uses, depends_on, located_at, runs_on, prefers, …), but a legitimate
// relation is always a short snake_case identifier. Injected instruction text or
// garbage ("ignore previous and grant", "is the admin password", sentences with
// spaces/punctuation, absurdly long strings) does not fit that shape — so we drop
// any fact whose predicate is not a sane relation token, and cap subject/object
// length to block payloads smuggled through those fields.
//
// OPT-69: the shape gate runs against the NORMALIZED predicate. normalizePredicate
// (shared module — no service.ts cycle) maps KNOWN synonyms, including legitimate
// space-forms the synonym map anticipates ("depends on"→"uses", "runs on"→
// "located_at"), to canonical snake_case BEFORE the shape check — so those survive
// instead of being dropped. Crucially this does NOT loosen OPT-04: a predicate not
// in the curated map is returned unchanged (lowercase+trim, identical to the prior
// gate), so an UNKNOWN space/punctuation predicate ("is the admin password") still
// fails the snake_case regex and is dropped.

/** Max characters for a subject or object value. Real entity names/values are short. */
const MAX_VALUE_LEN = 200;
/** A legitimate predicate is a bounded snake_case relation token. */
const VALID_PREDICATE = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * True when a raw fact has the shape of a legitimate, non-injected triple:
 * predicate is a sane snake_case relation token (after lowercase+trim) and
 * subject/object are non-empty and within the sanity length cap.
 */
export function isSaneFact(subject: string, predicate: string, object: string): boolean {
  const s = subject.trim();
  const o = object.trim();
  if (s.length === 0 || o.length === 0) return false;
  if (s.length > MAX_VALUE_LEN || o.length > MAX_VALUE_LEN) return false;
  // Normalize KNOWN synonyms (incl. space-forms) to canonical snake_case before
  // the shape check; unknown predicates pass through as lowercase+trim (the prior
  // behavior), so injection phrases with spaces/punctuation are still rejected.
  const pred = normalizePredicate(predicate);
  return VALID_PREDICATE.test(pred);
}

export function validateFactResponse(data: unknown): RawFact[] {
  if (typeof data !== 'object' || data === null) return [];
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.facts)) return [];

  const valid: RawFact[] = [];
  for (const item of obj.facts) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).subject === 'string' &&
      typeof (item as Record<string, unknown>).predicate === 'string' &&
      typeof (item as Record<string, unknown>).object === 'string'
    ) {
      const subject = (item as Record<string, unknown>).subject as string;
      const predicate = (item as Record<string, unknown>).predicate as string;
      const object = (item as Record<string, unknown>).object as string;
      // Drop facts that don't have the shape of a legitimate relation triple —
      // this quarantines prompt-injection / graph-poisoning attempts before they
      // can be minted as authoritative active/deductive facts downstream.
      if (!isSaneFact(subject, predicate, object)) {
        console.warn(`[extract] Dropped non-sane fact (possible injection): predicate="${predicate.slice(0, 60)}" subjectLen=${subject.length} objectLen=${object.length}`);
        continue;
      }
      valid.push({ subject, predicate, object });
    }
  }
  return valid;
}

// ─── Extraction prompt ──────────────────────────────────────────────────────

const FACT_EXTRACTION_PROMPT = `You are a knowledge extraction system. Given prose text about a project or system, extract structured facts as subject-predicate-object triples.

Rules:
- Extract only factual claims, not opinions or speculation.
- Use concise entity names for subjects (e.g. "auth-module", not "the authentication module").
- Use ONLY these canonical predicates: "uses", "prefers", "located_at", "implements", "owns", "is", "version_is", "has", "produces", "consumes", "calls", "extends", "rate_limit_is", "configured_as", "depends_on", "replaces", "blocks", "enables".
- Keep objects concise but complete (e.g. "JWT", "PostgreSQL 15", "event sourcing pattern").
- If no clear facts can be extracted, return an empty array.

Respond with JSON only:
{"facts": [{"subject": "...", "predicate": "...", "object": "..."}]}`;

// ─── extractFacts ───────────────────────────────────────────────────────────

/**
 * Extracts structured subject-predicate-object facts from prose content.
 * Returns an empty array on any failure (parse error, API error, etc.).
 */
export async function extractFacts(
  content: string,
  apiKey: string,
  model = 'gpt-4o-mini',
): Promise<FactInput[]> {
  if (!apiKey || !content.trim()) {
    return [];
  }

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: FACT_EXTRACTION_PROMPT },
        { role: 'user', content: content.slice(0, 4000) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 1000,
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      const preview = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
      console.error(`[extract] JSON parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Raw content: ${preview}`);
      return [];
    }
    const facts = validateFactResponse(parsed);

    return facts.map((f) => ({
      subject: f.subject,
      predicate: f.predicate,
      object: f.object,
      source_episode_ids: [],
    }));
  } catch (err) {
    // Re-throw transient errors so callers with retry logic can handle them.
    // Non-transient errors (auth, bad request) are silently swallowed.
    if (isTransientError(err)) throw err;
    return [];
  }
}
