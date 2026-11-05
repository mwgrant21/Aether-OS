// The "decided" classifier. Conservative: barred wins over question, question over ready.
// D3: delete, force-push and cleanup are NOT decided. False positives are accepted (the item is
// held, never run); a false negative is the defect, so every family below matches on a broad stem
// or a bare command token rather than on an exact phrase.
//
// Text is normalised first (see normalise) so unicode tricks and odd whitespace cannot hide a
// phrase. Gaps between words use a bounded `.{0,400}` so matching stays linear on long input.
const G = '.{0,400}';
const r = (src, code) => [new RegExp(src, 'i'), code];

const BARRED = [
  // delete / remove stems (word-prefix: deletion, removal, pruning, erasing, wiped, ...)
  r('\\b(delet|remov|prun|eras|unlink|destroy|wip|nuk|trash|shred|truncat|purg|discard)\\w*', 'barred:delete'),
  // bare delete commands, no flag requirement
  r('\\b(rm|rmi|del|erase|rd|rmdir|rimraf)\\b', 'barred:delete'),
  r('\\bFormat-Volume\\b|\\bClear-(Content|RecycleBin|Disk|Item)\\b', 'barred:delete'),
  r('\\bdrop\\s+(table|database|schema|index)\\b', 'barred:delete'),
  // git subcommands that destroy refs or work
  r('\\bgit\\b' + G + '\\b(clean|rm)\\b', 'barred:delete'),
  r('\\bclean\\s+-[a-z]*[fd]', 'barred:delete'),
  r('\\bstash\\s+(drop|clear)\\b', 'barred:delete'),
  r('\\btag\\s+(-[a-z]*d|--delete)\\b', 'barred:delete'),
  r('\\bupdate-ref\\s+-[a-z]*d\\b', 'barred:delete'),
  r('\\bremote\\s+(rm|remove)\\b', 'barred:delete'),
  r('\\bworktree\\s+remove\\b', 'barred:delete'),
  r('\\bbranch\\b' + G + '\\s-[a-z]*[dfm]', 'barred:delete'),
  r('--delete\\b', 'barred:delete'),
  r('\\breset\\b' + G + '--hard', 'barred:delete'),
  r('\\bcheckout\\b' + G + '(\\s-[a-z]*f|\\s--\\s*\\.)', 'barred:delete'),
  r('\\brestore\\b' + G + '\\s\\.(\\s|$)', 'barred:delete'),
  r('\\bfilter-(branch|repo)\\b|\\breflog\\s+expire\\b', 'barred:delete'),
  r('\\bpush\\b' + G + '\\s:\\S', 'barred:delete'),
  r('\\bpush\\b' + G + '\\s-[a-z]*d\\b', 'barred:delete'),
  r('\\bhard[\\s_-]*reset|\\breset\\b' + G + '\\bhard\\b', 'barred:delete'),
  // force-push in any spelling
  r('forc(e|ed|ing|ibly|efully)[\\s_-]*push', 'barred:force-push'),
  r('\\bpush\\w*\\W+(\\w+\\W+){0,3}with\\W+force', 'barred:force-push'),
  r('--force|--mirror', 'barred:force-push'),
  r('\\bpush\\b' + G + '\\s-[a-z]*f', 'barred:force-push'),
  r('\\bpush\\b' + G + '\\s\\+\\S', 'barred:force-push'),
  // cleanup
  r('\\b(clean|tidy)\\w*', 'barred:cleanup'),
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

// NFKD folds fullwidth/compatibility forms and splits accents off, so stripping marks leaves the
// base letters; zero-width and bidi controls are dropped; every whitespace run (nbsp, tab,
// newline) becomes one space.
// Unicode hyphens (U+2010-U+2015, minus U+2212) fold to '-', '_' folds to a space (\b treats it as
// a word char, so old_delete.md would otherwise hide "delete"), and lookalike Cyrillic/Greek
// letters fold to ASCII. The homoglyph table is deliberately short, not exhaustive.
const HOMOGLYPHS = {
  // Cyrillic lowercase
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x',
  '\u0443': 'y', '\u0456': 'i', '\u0455': 's', '\u0458': 'j', '\u043A': 'k', '\u043C': 'm',
  '\u0442': 't', '\u04BB': 'h', '\u0501': 'd', '\u04CF': 'l', '\u0131': 'i',
  // Cyrillic uppercase
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M', '\u041D': 'H',
  '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u0406': 'I',
  '\u0405': 'S', '\u0408': 'J', '\u04C0': 'I',
  // Greek
  '\u03BF': 'o', '\u03BD': 'v', '\u039F': 'O', '\u039D': 'N', '\u0391': 'A', '\u0392': 'B',
  '\u0395': 'E', '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u03A1': 'P', '\u03A4': 'T',
  '\u03A7': 'X', '\u03A5': 'Y', '\u0396': 'Z', '\u0397': 'H',
};
const HOMOGLYPH_RE = new RegExp('[' + Object.keys(HOMOGLYPHS).join('') + ']', 'g');

function normalise(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\p{M}]/gu, '')
    .replace(/[\u2010-\u2015\u2043\u2212\u2E3A\u2E3B\u058A\u05BE\u1806\u02D7\u2796]/g, '-')
    .replace(/_/g, ' ')
    .replace(HOMOGLYPH_RE, (c) => HOMOGLYPHS[c])
    .replace(/\s+/g, ' ');
}

export function classifyItem(text) {
  const s = normalise(text);
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
