import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AetherStoreProvider } from '../../state/store';
import { CommsView } from './CommsView';
import type { DisplayMessage, TranscriptSource } from '../../../electron/transcriptReader';

afterEach(cleanup);

const SOURCE: TranscriptSource = { id: 'sess-1', kind: 'session', label: 'Session', isLive: false };

const MESSAGES: DisplayMessage[] = [
  { id: 'm1', role: 'human', atMs: 1000, text: 'run the test suite', toolCalls: [], toolResults: [] },
  { id: 'm2', role: 'assistant', atMs: 2000, text: null, toolCalls: [{ name: 'Bash', label: 'npm test' }], toolResults: [{ resultLength: 40 }] },
  { id: 'm3', role: 'assistant', atMs: 3000, text: 'All green.', toolCalls: [], toolResults: [] },
];

function renderComms() {
  return render(
    <AetherStoreProvider>
      <CommsView />
    </AetherStoreProvider>,
  );
}

describe('CommsView filter box', () => {
  beforeEach(() => {
    (window as any).aetherElectron = {
      transcript: {
        sources: vi.fn().mockResolvedValue([SOURCE]),
        read: vi.fn().mockResolvedValue({ messages: MESSAGES, nextBefore: null }),
      },
    };
  });

  it('renders the full unfiltered message set on the AETHER channel', async () => {
    renderComms();
    await waitFor(() => expect(screen.getByText('All green.')).toBeTruthy());
    expect(screen.getByText('run the test suite')).toBeTruthy();
    expect(screen.getByText('Bash')).toBeTruthy();
  });

  it('narrows the rendered set to a bare-text filter match', async () => {
    renderComms();
    await waitFor(() => expect(screen.getByText('All green.')).toBeTruthy());

    const input = screen.getByPlaceholderText(/Filter AETHER/i);
    fireEvent.change(input, { target: { value: 'green' } });

    expect(screen.getByText('All green.')).toBeTruthy();
    expect(screen.queryByText('run the test suite')).toBeNull();
    expect(screen.queryByText('Bash')).toBeNull();
  });

  it('narrows the rendered set to a /tool <name> filter', async () => {
    renderComms();
    await waitFor(() => expect(screen.getByText('All green.')).toBeTruthy());

    const input = screen.getByPlaceholderText(/Filter AETHER/i);
    fireEvent.change(input, { target: { value: '/tool Bash' } });

    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.queryByText('run the test suite')).toBeNull();
    expect(screen.queryByText('All green.')).toBeNull();
  });

  it('narrows the rendered set to /human', async () => {
    renderComms();
    await waitFor(() => expect(screen.getByText('All green.')).toBeTruthy());

    const input = screen.getByPlaceholderText(/Filter AETHER/i);
    fireEvent.change(input, { target: { value: '/human' } });

    expect(screen.getByText('run the test suite')).toBeTruthy();
    expect(screen.queryByText('All green.')).toBeNull();
    expect(screen.queryByText('Bash')).toBeNull();
  });

  it('clearing the filter box restores the full set', async () => {
    renderComms();
    await waitFor(() => expect(screen.getByText('All green.')).toBeTruthy());

    const input = screen.getByPlaceholderText(/Filter AETHER/i);
    fireEvent.change(input, { target: { value: 'green' } });
    expect(screen.queryByText('run the test suite')).toBeNull();

    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('run the test suite')).toBeTruthy();
    expect(screen.getByText('All green.')).toBeTruthy();
  });
});
