// Pure helpers: turn composed text into the bytes a terminal paste would produce.
const ESC = '\x1b';

export function pasteBytes(text, bracketed) {
  const body = String(text).split(ESC).join('').replace(/\r\n|\r|\n/g, '\r');
  if (body === '') return '';
  // A lone slash command must arrive as typed keys, or Claude Code treats it as pasted text.
  if (/^\/[^\x00-\x1f\x7f]*$/.test(String(text))) return body;
  return bracketed ? `${ESC}[200~${body}${ESC}[201~` : body;
}

export function composeInputs(slot, text, enter, bracketed) {
  const out = [];
  const d = pasteBytes(text, bracketed);
  if (d !== '') out.push({ t: 'input', s: slot, d });
  if (enter) out.push({ t: 'input', s: slot, d: '\r' });
  return out;
}
