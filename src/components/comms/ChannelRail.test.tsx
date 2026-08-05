import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { AetherStoreProvider } from '../../state/store';
import { ChannelRail } from './ChannelRail';
import type { CommsChannel } from './commsChannels';

afterEach(cleanup);

function renderRail(props: ComponentProps<typeof ChannelRail>) {
  return render(
    <AetherStoreProvider>
      <ChannelRail {...props} />
    </AetherStoreProvider>,
  );
}

function channel(id: string, name: string): CommsChannel {
  return { id, name, initials: name.slice(0, 2).toUpperCase(), hue: '#7ef0ff', kind: 'aether', archived: false };
}

const baseProps = {
  channels: [channel('c1', 'Operator')],
  activeChannelId: 'c1',
  unreadCounts: {},
  recentCompletedDispatches: [],
  dispatchChannels: [],
  onCreateDispatchChannel: vi.fn(),
  onRemoveDispatchChannel: vi.fn(),
};

describe('ChannelRail keyboard access', () => {
  it('calls onSelect when Enter is pressed on a focused channel row', () => {
    const onSelect = vi.fn();
    const { getByRole } = renderRail({ ...baseProps, onSelect });
    const row = getByRole('button', { name: /Operator/i });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('calls onSelect when Space is pressed on a focused channel row', () => {
    const onSelect = vi.fn();
    const { getByRole } = renderRail({ ...baseProps, onSelect });
    const row = getByRole('button', { name: /Operator/i });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('pressing Enter on the remove control does not also fire onSelect on the row', () => {
    const onSelect = vi.fn();
    const dispatchChannel: CommsChannel = { ...channel('c2', 'Dispatch'), kind: 'dispatch', toolUseId: 'tu_1' };
    const { getByRole } = renderRail({
      ...baseProps,
      channels: [dispatchChannel],
      activeChannelId: 'c2',
      onSelect,
    });
    const removeButton = getByRole('button', { name: 'Remove channel' });
    fireEvent.keyDown(removeButton, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
