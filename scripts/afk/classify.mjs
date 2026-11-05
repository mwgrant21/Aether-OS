// The "decided" classifier. Conservative: barred wins over question, question over ready.
// False positives are accepted (the item is held, never run).
const BARRED = [
  [/\bdelet(e|es|ed|ing)\b/i, 'barred:delete'],
  [/\brm\s+-[a-z]*(rf|fr|r)[a-z]*\b/i, 'barred:delete'],
  [/\bRemove-Item\b/i, 'barred:delete'],
  [/\bprune\b/i, 'barred:delete'],
  [/force[- ]push/i, 'barred:force-push'],
  [/--force/i, 'barred:force-push'],
  [/\bpush\b[^\n]*\s-[a-z]*f\b/i, 'barred:force-push'],
  [/\bpush\b[^\n]*\s\+\S/i, 'barred:force-push'],
  [/\bpush\b[^\n]*\s:\S/, 'barred:delete'],
  [/reset\s+--hard/i, 'barred:delete'],
  [/branch\s+(-d|--delete)\b/i, 'barred:delete'],
  [/worktree\s+remove/i, 'barred:delete'],
  [/\bclean\s?-?up\b/i, 'barred:cleanup'],
  [/\bremov(e|es|ed|ing)\b/i, 'barred:delete'],
  [/\bpurge\b/i, 'barred:delete'],
  [/\brmdir\b/i, 'barred:delete'],
  [/\bclean\s+-[a-z]*[fd]/i, 'barred:delete'],
  [/git\s+clean/i, 'barred:delete'],
  [/git\s+rm\b/i, 'barred:delete'],
  [/\b(del|rd)\s+\/[sq]\b/i, 'barred:delete'],
  [/stash\s+(drop|clear)/i, 'barred:delete'],
];

const NEEDS_MATT = [
  /ask Matt/i,
  /needs? (a )?(fresh )?(go|approval)/i,
  /Matt'?s? (call|decision|go|approval)/i,
  /pending Matt/i,
  /awaiting Matt/i,
  /fresh go/i,
  /all need Matt/i,
];

const MARKERS = /\b(TBD|UNVERIFIED|unconfirmed|unclear|decide|open question|options?|either|whether|optional|maybe|consider|possibly)\b/i;

export function classifyItem(text) {
  const s = String(text);
  const barred = [];
  for (const [re, code] of BARRED) if (re.test(s) && !barred.includes(code)) barred.push(code);
  if (barred.length) return { verdict: 'barred', reasons: barred };
  const reasons = [];
  if (MARKERS.test(s)) reasons.push('question:marker');
  if (NEEDS_MATT.some((re) => re.test(s))) reasons.push('question:needs-matt');
  if (/[?\uFF1F]/.test(s)) reasons.push('question:mark');
  if (reasons.length) return { verdict: 'question', reasons };
  return { verdict: 'ready', reasons: [] };
}
