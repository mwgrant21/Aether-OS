export const MANAGED_BEGIN = '<!-- token-tracker:begin -->';
export const MANAGED_END = '<!-- token-tracker:end -->';
export const HEADING = '## Token Tracker suggestions';

export const GUIDANCE_BY_ID: Record<string, string> = {
  'opus-on-trivial-turns':
    'Prefer Sonnet for short/trivial turns; reserve Opus for complex reasoning.',
  'unpinned-config-re-reads':
    'Pin frequently re-read files into context instead of re-reading them each turn.',
  'uncapped-bash-output':
    'Cap large command output (pipe through head/tail or Select-Object -First).',
};

export function guidanceFor(findingId: string | undefined): string | null {
  if (findingId !== undefined && Object.prototype.hasOwnProperty.call(GUIDANCE_BY_ID, findingId)) {
    return GUIDANCE_BY_ID[findingId];
  }
  return null;
}

function buildBlock(guidance: string): string {
  return `${MANAGED_BEGIN}\n${HEADING}\n- ${guidance}\n${MANAGED_END}`;
}

export function isGuidanceApplied(content: string, findingId: string): boolean {
  const guidance = guidanceFor(findingId);
  if (guidance === null || !content) return false;

  const beginIdx = content.indexOf(MANAGED_BEGIN);
  const endIdx = content.indexOf(MANAGED_END);
  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) return false;

  const bullet = `- ${guidance}`;
  return content
    .slice(beginIdx, endIdx)
    .split('\n')
    .some((line) => line.trim() === bullet);
}

export function upsertGuidance(content: string, findingId: string): { content: string; added: boolean } {
  const guidance = guidanceFor(findingId);
  if (guidance === null) {
    return { content, added: false };
  }

  const bullet = `- ${guidance}`;
  const beginIdx = content.indexOf(MANAGED_BEGIN);
  const endIdx = content.indexOf(MANAGED_END);
  const hasBlock = beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx;

  if (!hasBlock) {
    let sep: string;
    if (content.length === 0) {
      sep = '';
    } else if (content.endsWith('\n')) {
      sep = '\n';
    } else {
      sep = '\n\n';
    }
    const nextContent = `${content}${sep}${buildBlock(guidance)}\n`;
    return { content: nextContent, added: true };
  }

  const blockInner = content.slice(beginIdx, endIdx);
  const alreadyPresent = blockInner
    .split('\n')
    .some((line) => line.trim() === bullet);
  if (alreadyPresent) {
    return { content, added: false };
  }

  const nextContent = `${content.slice(0, endIdx)}${bullet}\n${content.slice(endIdx)}`;
  return { content: nextContent, added: true };
}
