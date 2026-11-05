// The "decided" classifier. Conservative: barred wins over question, question over ready.
// False positives are accepted (the item is held, never run).
const BARRED = [
  [/\bdelet(e|ing)\b/i, 'barred:delete'],
  [/\brm -rf?\b/i, 'barred:delete'],
  [/\bRemove-Item\b/i, 'barred:delete'],
  [/\bprune\b/i, 'barred:delete'],
  [/force[- ]push/i, 'barred:force-push'],
  [/--force/i, 'barred:force-push'],
  [/reset --hard/i, 'barred:delete'],
  [/branch (-d|--delete)\b/i, 'barred:delete'],
  [/worktree remove/i, 'barred:delete'],
  [/\bcleanup\b/i, 'barred:cleanup'],
  [/\bremov(e|ing)\b/i, 'barred:delete'],
  [/\bpurge\b/i, 'barred:delete'],
  [/\brmdir\b/i, 'barred:delete'],
  [/git clean/i, 'barred:delete'],
  [/git rm\b/i, 'barred:delete'],
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
  if (s.includes('?')) reasons.push('question:mark');
  if (reasons.length) return { verdict: 'question', reasons };
  return { verdict: 'ready', reasons: [] };
}
