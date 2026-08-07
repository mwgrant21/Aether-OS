import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import path from 'path';
import { AetherStoreProvider } from '../../state/store';
import { MessageThread } from './MessageThread';
import type { CommsChannel } from './commsChannels';
import type { DisplayMessage } from './transcriptFilter';
import { readTranscript } from '../../../electron/transcriptReader';

const FIXTURE = path.join(__dirname, '../../../electron/__fixtures__/transcript-sample.jsonl');

afterEach(cleanup);

const channel: CommsChannel = {
  id: 'AETHER',
  kind: 'aether',
  name: 'AETHER',
  initials: 'AE',
  hue: '#7ef0ff',
  archived: false,
  transcriptSourceId: '__session__',
};

function renderThread(messages: DisplayMessage[]) {
  return render(
    <AetherStoreProvider>
      <MessageThread channel={channel} messages={messages} />
    </AetherStoreProvider>,
  );
}

describe('MessageThread', () => {
  it('renders a human message', () => {
    const messages: DisplayMessage[] = [{ id: '1', role: 'human', atMs: 1000, text: 'hello there', toolCalls: [], toolResults: [] }];
    const { getByText } = renderThread(messages);
    expect(getByText('hello there')).toBeTruthy();
    expect(getByText('YOU')).toBeTruthy();
  });

  it('renders an assistant text message under the channel name', () => {
    const messages: DisplayMessage[] = [{ id: '2', role: 'assistant', atMs: 1000, text: 'On it.', toolCalls: [], toolResults: [] }];
    const { getByText, getAllByText } = renderThread(messages);
    expect(getByText('On it.')).toBeTruthy();
    expect(getAllByText('AETHER').length).toBeGreaterThan(0);
  });

  it('renders a compact tool row as name · label, with a size chip when a result is correlated', () => {
    const messages: DisplayMessage[] = [
      {
        id: '3',
        role: 'assistant',
        atMs: 1000,
        text: null,
        toolCalls: [{ name: 'Bash', label: 'npm test', toolUseId: 'tool-1', resultLength: 420 }],
        toolResults: [],
      },
    ];
    const { getByText } = renderThread(messages);
    expect(getByText('Bash')).toBeTruthy();
    expect(getByText('npm test')).toBeTruthy();
    expect(getByText('420c')).toBeTruthy();
  });

  it('does not render a size chip when no matching tool result exists', () => {
    const messages: DisplayMessage[] = [
      {
        id: '4',
        role: 'assistant',
        atMs: 1000,
        text: null,
        toolCalls: [{ name: 'Read', label: 'reducer.ts', resultLength: null }],
        toolResults: [],
      },
    ];
    const { queryByText } = renderThread(messages);
    expect(queryByText(/c$/)).toBeNull();
  });

  it('shows an empty-state message when there are no messages', () => {
    const { container } = renderThread([]);
    expect(container.textContent).toMatch(/waiting on|backing transcript/i);
  });

  // Post-hoc fix (final review, findings 1/2): built from the REAL
  // readTranscript path over the fixture, not a hand-authored DisplayMessage
  // literal -- this is what would have caught the original bug, where no
  // production DisplayMessage ever had both toolCalls and toolResults
  // populated together, so the size chip could never render and a
  // tool-result-only line rendered as a blank SYSTEM row.
  it('correlates a real tool_use/tool_result pair from the fixture into a rendered size chip, and drops the now-redundant tool-result-only row', async () => {
    const { messages } = await readTranscript(FIXTURE, { limit: 50 });
    const { getByText, queryByText } = renderThread(messages);

    // u2's Bash call (tool-1) has its result (from u3) correlated onto it.
    expect(getByText('Bash')).toBeTruthy();
    expect(getByText(/^\d+c$/)).toBeTruthy();

    // u3 was a pure tool-result carrier for tool-1 and is fully consumed by
    // the correlation above -- it must not render as a separate blank row.
    expect(queryByText('tool result (call not in view)')).toBeNull();

    // u2's Read call (tool-2) has no result anywhere in the fixture, so it
    // renders with no size chip -- distinct from the failure mode above.
    expect(getByText('Read')).toBeTruthy();
  });
});
