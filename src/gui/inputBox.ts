/** Rows scanned from the bottom of the screen (non-empty rows only). */
export const GUI_INPUT_BOX_SCAN_ROWS = 12;

const RULE_ROW = /^\s*\u2500{20,}\s*$/u;
const INPUT_ROW = /^\s*[\u276f>](?:\s|$)/u;

/**
 * True when the last GUI_INPUT_BOX_SCAN_ROWS non-empty screen rows hold Claude's
 * input box: a rule row, an input row, then (after at most 2 wrapped input rows)
 * a closing rule row. Means "the box has been drawn", not "Claude is idle".
 */
export function claudeInputReady(text: string): boolean {
  const rows = text
    .split('\n')
    .filter((r) => r.trim() !== '')
    .slice(-GUI_INPUT_BOX_SCAN_ROWS);
  for (let i = 0; i + 2 < rows.length; i++) {
    if (!RULE_ROW.test(rows[i]) || !INPUT_ROW.test(rows[i + 1])) continue;
    for (let j = i + 2; j <= i + 4 && j < rows.length; j++) {
      if (RULE_ROW.test(rows[j])) return true;
    }
  }
  return false;
}
