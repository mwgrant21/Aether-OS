// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import qrcode from 'qrcode-generator';
import type { ChatEvent, ServerMessage } from './types';

describe('remote deps and contract', () => {
  it('ws exposes WebSocketServer', () => {
    expect(typeof WebSocketServer).toBe('function');
  });

  it('qrcode-generator builds an SVG', () => {
    const qr = qrcode(0, 'M');
    qr.addData('http://100.64.0.1:47821/pair#c=ABCD-EFGH');
    qr.make();
    expect(qr.createSvgTag()).toMatch(/^<svg/);
  });

  it('contract literals compile', () => {
    const msg: ChatEvent = { k: 'msg', id: '0:0', atMs: 1, role: 'you', text: 'hi', truncated: false, tools: [] };
    const traffic: ChatEvent = {
      k: 'traffic', id: '1:0', atMs: 2, kind: 'dispatch', from: 'Claude', to: 'agent',
      subject: null, text: 't', truncated: false, status: null,
    };
    const all: ServerMessage[] = [
      { t: 'session', attached: true, title: null },
      { t: 'history', events: [msg, traffic] },
      { t: 'event', event: msg },
      { t: 'bye', reason: 'revoked' },
    ];
    expect(all).toHaveLength(4);
  });
});
