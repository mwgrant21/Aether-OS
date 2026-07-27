import { readFileSync } from 'fs';

/**
 * Parses `.env` file contents into a key-value object.
 *
 * Handles:
 * - `KEY=value` pairs (splits on first `=` only)
 * - Removes surrounding single or double quotes from values
 * - Skips comment lines (starting with `#`) and blank lines
 * - Strips leading `export ` prefix from keys
 * - Trims whitespace around keys and unquoted values
 *
 * @param contents The raw contents of a `.env` file
 * @returns A Record<string, string> of parsed key-value pairs
 */
export function parseDotEnv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};

  const lines = contents.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Find the first `=`
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      // No `=` found, skip this line
      continue;
    }

    let key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1);

    // Strip leading `export ` from key
    if (key.startsWith('export ')) {
      key = key.substring(7).trim();
    }

    // Trim value
    value = value.trim();

    // Strip surrounding quotes (single or double)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.substring(1, value.length - 1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Loads a `.env` file and assigns its contents to the given target object.
 *
 * Returns silently if the file is missing or unreadable (`.env` is optional).
 * Only assigns values for keys not already set in `target` — existing values
 * (e.g., from shell environment) are never overwritten.
 *
 * @param envPath Path to the `.env` file
 * @param target Target object to assign values to (typically `process.env`)
 */
export function loadDotEnvInto(envPath: string, target: NodeJS.ProcessEnv): void {
  try {
    const contents = readFileSync(envPath, 'utf-8');
    const parsed = parseDotEnv(contents);

    for (const [key, value] of Object.entries(parsed)) {
      // Only assign if not already set (shell-exported variables win)
      if (target[key] === undefined) {
        target[key] = value;
      }
    }
  } catch {
    // Silently ignore: missing file, unreadable file, etc.
    // `.env` is optional by design.
  }
}
