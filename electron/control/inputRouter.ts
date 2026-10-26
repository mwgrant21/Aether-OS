// electron/control/inputRouter.ts
//
// The ONLY place a phone-originated byte reaches a pty. Per device ref it keeps the last applied cseq per slot
// (memory only, one entry per device, replaced when the epoch changes), so ordering is exact and at-most-once:
// c === last + 1 is validated, written once and acked; c <= last is a duplicate (re-acked, never written); a gap
// or an invalid payload is a violation; a burst over the per-second frame or byte budget is a rate-limit result.
// All of those are decided BEFORE any write. A frame that cannot be applied (typing is switched off, or the port
// reports the slot is not running) still consumes its cseq but is rejected, not acked: nothing is written, the
// result carries the reason for a nak, and one fixed line is logged per session and reason. Logged lines carry slot
// names, reasons and counts only, never the typed data.
import type { InputPort, InputResult, InputSession, NakReason, TerminalSlotId, TerminalWritePort } from '../../src/shared/remote/types';
import { CONTROL_INPUT_MAX_BYTES_PER_SEC, CONTROL_INPUT_MAX_FRAMES_PER_SEC } from '../../src/shared/remote/types';
import { validateInput } from './protocol';

const WINDOW_MS = 1000;

interface Counters { epoch: string; last: Map<TerminalSlotId, number> }

export function createInputRouter(opts: { terminals: TerminalWritePort; now: () => number; log?: (msg: string, ref: string) => void; typingEnabled?: () => boolean }): InputPort {
  const { terminals, now, log } = opts;
  const typingEnabled = opts.typingEnabled ?? (() => true);
  const byRef = new Map<string, Counters>();

  return {
    open(ref: string, epoch: string): InputSession {
      let entry = byRef.get(ref);
      if (!entry || entry.epoch !== epoch) {
        entry = { epoch, last: new Map() };
        byRef.set(ref, entry);
      }
      const counters = entry;
      let windowStart = now();
      let frames = 0;
      let bytes = 0;
      let announced = false;
      const rejectLogged = new Set<NakReason>();

      return {
        input(s: TerminalSlotId, c: number, d: string): InputResult {
          const last = counters.last.get(s) ?? 0;
          if (c <= last) return { kind: 'duplicate', ack: last };
          if (c > last + 1) return { kind: 'violation', why: 'control: input gap' };
          try { validateInput(d); } catch { return { kind: 'violation', why: 'control: invalid input' }; }
          const data = validateInput(d); // pure; bound once so the write below takes the validator's own output
          const t = now();
          if (t - windowStart >= WINDOW_MS) { windowStart = t; frames = 0; bytes = 0; }
          const n = Buffer.byteLength(data, 'utf8');
          if (frames + 1 > CONTROL_INPUT_MAX_FRAMES_PER_SEC || bytes + n > CONTROL_INPUT_MAX_BYTES_PER_SEC) return { kind: 'rate-limit' };
          frames += 1;
          bytes += n;
          const reject = (reason: NakReason): InputResult => {
            counters.last.set(s, c);
            if (!rejectLogged.has(reason)) { rejectLogged.add(reason); log?.(`control: input rejected slot=${s} reason=${reason}`, ref); }
            return { kind: 'rejected', c, reason };
          };
          if (!typingEnabled()) return reject('typing-off');
          const written = terminals.write(s, data);
          if (!written) return reject('not-running');
          counters.last.set(s, c);
          if (!announced) { announced = true; log?.(`control: first input slot=${s} bytes=${n}`, ref); }
          return { kind: 'applied', ack: c };
        },
        applied(): Record<string, number> {
          return Object.fromEntries(counters.last);
        },
        close(): void { /* counters outlive the socket on purpose: a second socket of the same epoch resumes them */ },
      };
    },
  };
}
