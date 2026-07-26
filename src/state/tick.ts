import type { AetherState, AlarmLevel } from './types';
import { nowShort } from '../utils/format';

const APPROVAL_POOL = [
  { action: 'Install dependency: chart.js@5', detail: 'adds 42KB to bundle · 3 transitive deps', risk: 'LOW' as const },
  { action: 'Force-push rebase to feature branch', detail: 'rewrites 4 commits on origin', risk: 'MED' as const },
  { action: 'Purge CDN cache (all routes)', detail: 'cold cache for ~2 min after purge', risk: 'MED' as const },
  { action: 'Call external pricing API', detail: 'sends anonymized usage rows offsite', risk: 'HIGH' as const },
  { action: 'Raise burn ceiling by 20K/min', detail: 'temporary boost to finish mission faster', risk: 'HIGH' as const },
  { action: 'Delete stale branch cleanup/old-ui', detail: 'last commit 34 days ago', risk: 'LOW' as const },
];

export function computeTick(state: AetherState): Partial<AetherState> {
  const mode = state.cfg.opMode;
  let effectiveRate = state.rate;
  if (state.cfg.autoThrottle) effectiveRate = Math.min(effectiveRate, state.cfg.alarm * 1000 * 0.8);

  const used = state.used + (effectiveRate / 60) * 0.9 * 0.05;

  const weekRaw = state.weekRaw.slice();
  weekRaw[6] = Math.min(72, weekRaw[6] + Math.random() * 0.35);

  const agents = state.agents.map((a) => ({
    ...a,
    pct: a.paused ? a.pct : Math.min(99, a.pct + (Math.random() - 0.3) * 1.5),
    hist: a.paused ? a.hist : a.hist.slice(-15).concat(effectiveRate * a.share * (0.85 + Math.random() * 0.3)),
  }));

  const sys = state.sys.map((m) => {
    const val = Math.max(6, Math.min(96, m.val + (Math.random() - 0.5) * 5));
    return { ...m, val, hist: m.hist.slice(1).concat(val) };
  });

  const memories = state.memories.map((m) => (m.pinned ? m : { ...m, strength: Math.max(0, m.strength - 0.4) }));

  const alarm = state.cfg.alarm;
  const rateK = effectiveRate / 1000;
  const level: AlarmLevel = rateK >= alarm ? 'crit' : rateK >= alarm * 0.85 ? 'warn' : 'ok';

  let notifs = state.notifs;
  let unread = state.unread;
  if (level !== state.alarmLevel && level !== 'ok') {
    notifs = [
      {
        t: nowShort(),
        m: level === 'crit' ? `BURN ALARM — rate exceeds ${alarm}K/min` : 'Burn elevated — approaching alarm threshold',
        c: level === 'crit' ? '#ff6b7a' : '#f5c66b',
      },
      ...notifs,
    ].slice(0, 12);
    unread += 1;
  }

  let approvals = state.approvals;
  let apprSeq = state.apprSeq;
  if (agents.length && approvals.length < 3 && Math.random() < (mode === 'PLAN' ? 0.09 : 0.035)) {
    const req = APPROVAL_POOL[Math.floor(Math.random() * APPROVAL_POOL.length)];
    const ag = agents[Math.floor(Math.random() * agents.length)];
    if (mode === 'AUTO' && req.risk !== 'HIGH') {
      notifs = [{ t: nowShort(), m: `Auto-approved: ${req.action} (${ag.name})`, c: '#3be0a0' }, ...notifs].slice(0, 12);
      unread += 1;
    } else {
      approvals = approvals.concat({ id: apprSeq, agent: ag.name, i: ag.i, hue: ag.hue, ...req });
      apprSeq += 1;
      notifs = [{ t: nowShort(), m: `${ag.name} requests approval: ${req.action}`, c: '#f5c66b' }, ...notifs].slice(0, 12);
      unread += 1;
    }
  }

  return { used, weekRaw, agents, sys, alarmLevel: level, notifs, unread, approvals, apprSeq, memories };
}
