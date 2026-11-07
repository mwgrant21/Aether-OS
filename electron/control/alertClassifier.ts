import type { AlertKind } from '../../src/shared/remote/types';

const CLOSERS = /[)"'*_\s]+$/;
const YES_NO_CUE = /\(y\/n\)|\[y\/n\]|\byes or no\b|\by\/n\b/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/**
 * Pure three-label classifier for a stopped assistant turn. Only a trailing "?" or an
 * explicit yes/no cue yields `question`; anything uncertain is `input`. `truncated` means
 * the text was head-cut, so its end (and meaning) is unknown.
 */
export function classifyStop(lastAssistantText: string | null, truncated?: boolean): AlertKind {
  if (truncated === true || lastAssistantText === null) return 'input';
  const text = lastAssistantText.trim();
  if (text === '') return 'input';

  const stripped = text.replace(CLOSERS, '');
  if (stripped.endsWith('?')) return 'question';

  const paragraphs = text.split(/\n\s*\n/);
  const lastParagraph = paragraphs.at(-1) ?? '';
  if (YES_NO_CUE.test(lastParagraph)) return 'question';

  const fences = text.split('\n').filter((l) => l.trimStart().startsWith('```')).length;
  if (fences % 2 === 1) return 'input';
  const lines = text.split('\n');
  const lastLine = (lines.at(-1) ?? '').trim();
  if (lastLine.startsWith('```') || LIST_ITEM.test(lastLine)) return 'input';
  if (/[.!]$/.test(stripped)) return 'finished';
  return 'input';
}
