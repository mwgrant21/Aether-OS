/**
 * Aether OS — Layer 2 prompt-safety fencing.
 *
 * Design: AETHER_MEMORY_LAYER_2.md §2 "Prompt-safety fencing" (ported from
 * Miriel's memory-engine.js) and §4.1 (the extractor consumes untrusted
 * run-derived text). Two functions, deliberately separate:
 *
 *  - `sanitizeUntrusted` strips control characters and anything that looks
 *    like an XML/HTML tag, so text that reaches the model cannot forge a
 *    fence boundary or inject a fake system-style directive.
 *  - `fence` wraps sanitized content in a named tag the model is told (in
 *    the surrounding prompt, not here) to treat as inert data.
 *
 * The spec's own audit note applies: port the module, then audit call sites
 * independently rather than assuming every string reaching a prompt is
 * fenced. `memoryExtractPrompt.ts` is the only call site this plan adds, and
 * it fences every piece of run-derived text it embeds.
 */

const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
// Matches any HTML/XML-style tag: <name>, </name>, <name/>, with or without
// attributes. Deliberately broad -- a false-positive strip of literal
// "<3" or "a<b" in free text costs nothing here; a missed tag costs a
// fence escape.
const TAG_RE = /<\/?[a-zA-Z][^<>]*>/g;

export function sanitizeUntrusted(content: string): string {
  return content.replace(CONTROL_CHARS_RE, '').replace(TAG_RE, '');
}

export function fence(tag: string, content: string): string {
  const clean = sanitizeUntrusted(content);
  return `<${tag}>\n${clean}\n</${tag}>`;
}
