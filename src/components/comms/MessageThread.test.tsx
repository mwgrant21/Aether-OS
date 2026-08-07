import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AetherStoreProvider } from '../../state/store';
import { MessageThread } from './MessageThread';
import type { CommsChannel } from './commsChannels';
import type { DisplayMessage } from './transcriptFilter';

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

  it('renders a compact tool row as name · label, with a size chip when a result exists', () => {
    const messages: DisplayMessage[] = [
      {
        id: '3',
        role: 'assistant',
        atMs: 1000,
        text: null,
        toolCalls: [{ name: 'Bash', label: 'npm test' }],
        toolResults: [{ resultLength: 420 }],
      },
    ];
    const { getByText } = renderThread(messages);
    expect(getByText('Bash')).toBeTruthy();
    expect(getByText('npm test')).toBeTruthy();
    expect(getByText('420c')).toBeTruthy();
  });

  it('does not render a size chip when no matching tool result exists', () => {
    const messages: DisplayMessage[] = [
      { id: '4', role: 'assistant', atMs: 1000, text: null, toolCalls: [{ name: 'Read', label: 'reducer.ts' }], toolResults: [] },
    ];
    const { queryByText } = renderThread(messages);
    expect(queryByText(/c$/)).toBeNull();
  });

  it('shows an empty-state message when there are no messages', () => {
    const { container } = renderThread([]);
    expect(container.textContent).toMatch(/waiting on|backing transcript/i);
  });
});
