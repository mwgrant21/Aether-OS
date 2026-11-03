import { LAUNCH_EFFORTS, MODEL_ALIASES } from '../../src/shared/aetherChoice/types';
import type { LaunchEffort, ModelAlias } from '../../src/shared/aetherChoice/types';

// Aether-owned launch/resume text. Separate from ptyManager's default launch,
// which stays resume-free. Every launch carries explicit --model and --effort
// because typed /model and /effort rewrite the user's global default. Values
// are checked against closed allow-lists, so no shell quoting is needed.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AetherLaunchOptions = {
  model: ModelAlias;
  effort: LaunchEffort;
  resume?: boolean;
  sessionId?: string;
};

export function buildAetherLaunchCommand(opts: AetherLaunchOptions): string {
  const { model, effort, resume, sessionId } = opts;
  if (!(MODEL_ALIASES as readonly string[]).includes(model)) {
    throw new Error(`model not launchable: ${JSON.stringify(model)}`);
  }
  if (!(LAUNCH_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`effort not accepted by the CLI: ${JSON.stringify(effort)}`);
  }
  if (sessionId !== undefined && !UUID_RE.test(sessionId)) {
    throw new Error(`sessionId is not a UUID: ${JSON.stringify(sessionId)}`);
  }
  if (resume && sessionId !== undefined) {
    throw new Error('resume and sessionId cannot be combined');
  }
  const head = resume ? 'claude --continue' : sessionId ? `claude --session-id ${sessionId}` : 'claude';
  return `${head} --model ${model} --effort ${effort}\r`;
}
