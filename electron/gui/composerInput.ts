import { GUI_MAX_COMPOSER_CHARS } from './guiTypes';

export type FramedInput = { ok: true; writes: string[] } | { ok: false };

// C0 controls except \t (0x09) and \n (0x0a), plus DEL. Stripping ESC means pasted text cannot carry a
// bracketed-paste terminator or any other escape sequence into the PTY.
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Turn composer text into PTY writes: one line -> text + CR; several lines -> a bracketed-paste block, then Enter as its own write. */
export function frameComposerInput(text: string): FramedInput {
  const clean = text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
  if (clean.length === 0 || clean.length > GUI_MAX_COMPOSER_CHARS) return { ok: false };
  if (!clean.includes('\n')) return { ok: true, writes: [clean + '\r'] };
  return { ok: true, writes: ['\x1b[200~' + clean + '\x1b[201~', '\r'] };
}
