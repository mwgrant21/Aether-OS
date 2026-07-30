export type DensityLevel = 'normal' | 'verbose' | 'summary';

// One shared collapse rule for every Summary-density consumer (AgentDetailCard's
// prompt, roster rows, Memory's dispatch entries) -- not three separate
// implementations. Falls back to the full content if no headline exists yet
// (e.g. the Haiku call hasn't landed or failed), so Summary never shows blank.
export function applyDensity(fullContent: string, level: DensityLevel, headline: string | null): string {
  if (level !== 'summary') return fullContent;
  return headline ?? fullContent;
}
