// Handoff "Next steps" and ledger todo parsers. Pure text in, plain data out.
const START = /^#{2,3}\s+Next steps\b(.*)$/i;
const TOP_HEADING = /^#{1,2}\s/;
const ANY_HEADING = /^#{1,6}\s/;
const ITEM = /^\s{0,1}(\d+)\.\s+(.*)$/;

export function parseNextSteps(markdown) {
  const out = { found: false, headingNote: null, items: [] };
  let inFence = false;
  let inSection = false;
  let cur = null;
  for (const line of String(markdown).split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; cur = null; continue; }
    if (inFence) continue;
    if (!inSection) {
      const m = START.exec(line);
      if (m) {
        inSection = true;
        out.found = true;
        const note = m[1].trim().replace(/^\(\s*/, '').replace(/\s*\)$/, '').trim();
        out.headingNote = note === '' ? null : note;
      }
      continue;
    }
    if (TOP_HEADING.test(line)) break;
    if (ANY_HEADING.test(line)) { cur = null; continue; }
    const im = ITEM.exec(line);
    if (im) {
      cur = { n: Number(im[1]), text: im[2].trim() };
      out.items.push(cur);
    } else if (line.trim() === '') {
      cur = null;
    } else if (cur) {
      cur.text = `${cur.text} ${line.trim()}`;
    }
  }
  return out;
}

export function parseLedgerTodos(markdown) {
  const out = [];
  for (const line of String(markdown).split(/\r?\n/)) {
    const m = /^- \[(todo|pending[^\]]*)\]\s*(.*)$/i.exec(line);
    if (!m) continue;
    const tag = m[1];
    if (/^todo$/i.test(tag)) {
      out.push({ state: 'todo', note: null, text: m[2].trim() });
    } else {
      const note = tag.replace(/^pending/i, '').trim();
      out.push({ state: 'pending', note: note === '' ? null : note, text: m[2].trim() });
    }
  }
  return out;
}
