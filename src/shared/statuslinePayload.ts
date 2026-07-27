export interface RateLimitWindow {
  usedPercentage: number;   // 0-100
  resetsAtMs: number;       // epoch MILLISECONDS (converted from the payload's seconds)
}

export interface ContextWindowUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface StatuslineSnapshot {
  capturedAtMs: number;
  sessionId: string | null;
  modelId: string | null;
  modelDisplayName: string | null;
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  contextUsedPercentage: number | null;      // input-only, per the payload's own definition
  contextWindowSize: number | null;
  contextUsage: ContextWindowUsage | null;   // null before first API call and right after /compact
  totalCostUsd: number | null;
  currentDir: string | null;
  projectDir: string | null;
}

/**
 * Parses a raw statusline payload into a typed snapshot.
 *
 * This is a defensive parser: it receives whatever JSON.parse produced and must
 * never throw. Returns null only when raw is not a non-null object. Every
 * individual field is independently optional — a payload missing rate_limits
 * entirely still yields a valid snapshot with fiveHour: null, sevenDay: null.
 *
 * Claude Code's payload shape has changed across versions and will change again;
 * a parser that hard-fails on one unexpected field takes the whole feature down.
 */
export function parseStatuslinePayload(raw: unknown, capturedAtMs: number): StatuslineSnapshot | null {
  // Guard: raw must be a non-null object (not an array)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }

  const payload = raw as Record<string, unknown>;

  // Helper to safely extract a rate limit window
  const parseRateLimitWindow = (obj: unknown): RateLimitWindow | null => {
    if (typeof obj !== 'object' || obj === null) {
      return null;
    }
    const window = obj as Record<string, unknown>;
    const usedPercentage = window.used_percentage;
    const resetsAt = window.resets_at;

    // Only produce a RateLimitWindow when BOTH used_percentage and resets_at are finite numbers
    if (typeof usedPercentage === 'number' && isFinite(usedPercentage) &&
        typeof resetsAt === 'number' && isFinite(resetsAt)) {
      return {
        usedPercentage,
        resetsAtMs: resetsAt * 1000, // Convert seconds to milliseconds
      };
    }
    return null;
  };

  // Helper to safely extract context window usage
  const parseContextWindowUsage = (obj: unknown): ContextWindowUsage | null => {
    if (typeof obj !== 'object' || obj === null) {
      return null;
    }
    const usage = obj as Record<string, unknown>;
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    const cacheCreationInputTokens = usage.cache_creation_input_tokens;
    const cacheReadInputTokens = usage.cache_read_input_tokens;

    // All four fields must be numbers
    if (typeof inputTokens === 'number' && typeof outputTokens === 'number' &&
        typeof cacheCreationInputTokens === 'number' && typeof cacheReadInputTokens === 'number') {
      return {
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
      };
    }
    return null;
  };

  // Extract rate_limits
  let fiveHour: RateLimitWindow | null = null;
  let sevenDay: RateLimitWindow | null = null;
  const rateLimits = payload.rate_limits;
  if (typeof rateLimits === 'object' && rateLimits !== null) {
    const limits = rateLimits as Record<string, unknown>;
    fiveHour = parseRateLimitWindow(limits['five_hour']);
    sevenDay = parseRateLimitWindow(limits['seven_day']);
  }

  // Extract context_window fields
  let contextUsedPercentage: number | null = null;
  let contextWindowSize: number | null = null;
  let contextUsage: ContextWindowUsage | null = null;
  const contextWindow = payload.context_window;
  if (typeof contextWindow === 'object' && contextWindow !== null) {
    const ctx = contextWindow as Record<string, unknown>;
    const usedPerc = ctx.used_percentage;
    if (typeof usedPerc === 'number' && isFinite(usedPerc)) {
      contextUsedPercentage = usedPerc;
    }
    const windowSize = ctx.context_window_size;
    if (typeof windowSize === 'number' && isFinite(windowSize)) {
      contextWindowSize = windowSize;
    }
    // current_usage: null in the payload must produce contextUsage: null
    // (don't substitute a zeroed object, because "no data" and "zero tokens" are different states)
    const currentUsage = ctx.current_usage;
    if (currentUsage !== null && typeof currentUsage === 'object') {
      contextUsage = parseContextWindowUsage(currentUsage);
    }
  }

  // Extract session_id
  let sessionId: string | null = null;
  const sid = payload.session_id;
  if (typeof sid === 'string') {
    sessionId = sid;
  }

  // Extract model.id and model.display_name
  let modelId: string | null = null;
  let modelDisplayName: string | null = null;
  const model = payload.model;
  if (typeof model === 'object' && model !== null) {
    const m = model as Record<string, unknown>;
    const mid = m.id;
    if (typeof mid === 'string') {
      modelId = mid;
    }
    const mdisplay = m.display_name;
    if (typeof mdisplay === 'string') {
      modelDisplayName = mdisplay;
    }
  }

  // Extract cost.total_cost_usd
  let totalCostUsd: number | null = null;
  const cost = payload.cost;
  if (typeof cost === 'object' && cost !== null) {
    const c = cost as Record<string, unknown>;
    const tcost = c.total_cost_usd;
    if (typeof tcost === 'number' && isFinite(tcost)) {
      totalCostUsd = tcost;
    }
  }

  // Extract workspace.current_dir and workspace.project_dir
  let currentDir: string | null = null;
  let projectDir: string | null = null;
  const workspace = payload.workspace;
  if (typeof workspace === 'object' && workspace !== null) {
    const ws = workspace as Record<string, unknown>;
    const cdir = ws.current_dir;
    if (typeof cdir === 'string') {
      currentDir = cdir;
    }
    const pdir = ws.project_dir;
    if (typeof pdir === 'string') {
      projectDir = pdir;
    }
  }

  return {
    capturedAtMs,
    sessionId,
    modelId,
    modelDisplayName,
    fiveHour,
    sevenDay,
    contextUsedPercentage,
    contextWindowSize,
    contextUsage,
    totalCostUsd,
    currentDir,
    projectDir,
  };
}
