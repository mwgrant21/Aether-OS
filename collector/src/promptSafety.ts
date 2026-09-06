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

/** Strips control characters, then strips tags REPEATEDLY until the string
 *  stops changing.
 *
 *  A single `.replace()` pass is not enough, and the failure is not subtle: it
 *  can RECONSTRUCT a tag out of the text on either side of the one it removed.
 *  `"<scr<script>ipt>"` has `<script>` removed from the middle, and the
 *  surviving `"<scr"` and `"ipt>"` join into `"<script>"`. Measured before the
 *  fix:
 *
 *    "<scr<script>ipt>alert(1)</scr</script>ipt>" -> "<script>alert(1)</script>"
 *    "<im<div>g src=x onerror=1>"                 -> "<img src=x onerror=1>"
 *
 *  That matters here specifically because `fence()` below wraps untrusted
 *  content into a prompt, so a surviving tag is a fence escape - exactly what
 *  TAG_RE's own comment says it exists to prevent.
 *
 *  Terminates: every iteration that changes the string removes at least one
 *  character, so at most `content.length` iterations can change anything. The
 *  loop bound is derived from the input for exactly that reason.
 *
 *  It must NOT be a constant. A first version of this fix capped the loop at
 *  1000 passes, which reintroduced the very bug it was fixing at a slightly
 *  higher price: nesting a split tag more than 1000 deep exits the loop with a
 *  tag still reconstructible. Measured - a 3,014-byte payload built by
 *  wrapping `<x>` 999 times and embedding it in `</run_su...mmary>` left a
 *  literal `</run_summary>` in the output, closing the fence early. The
 *  comment attached to that cap even claimed termination was bounded by input
 *  length while capping below it; the reasoning was right and the code did not
 *  match it. */
export function sanitizeUntrusted(content: string): string {
  let out = content.replace(CONTROL_CHARS_RE, '');
  // +1 so a single no-op confirming pass always fits.
  const maxPasses = content.length + 1;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const next = out.replace(TAG_RE, '');
    if (next === out) return out;
    out = next;
  }
  return out;
}

export function fence(tag: string, content: string): string {
  const clean = sanitizeUntrusted(content);
  return `<${tag}>\n${clean}\n</${tag}>`;
}
