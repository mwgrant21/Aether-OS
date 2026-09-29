import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { OperatingModeCard } from './OperatingModeCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(cleanup);

describe('OperatingModeCard mode pills', () => {
  it('share the TopBar pattern: labelled group, aria-pressed, glyph hidden, text-presentation bolt', () => {
    render(
      <AetherStoreProvider>
        <OperatingModeCard />
      </AetherStoreProvider>,
    );
    const group = screen.getByRole('group', { name: 'Operating mode (synced with top bar)' });
    const auto = within(group).getByRole('button', { name: 'AUTO' });
    expect(auto.textContent).toContain('⚡︎');
    expect(auto.querySelector('[aria-hidden="true"]')?.textContent).toBe('⚡︎');

    fireEvent.click(auto);
    const pressed = within(group).getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toBe(within(group).getByRole('button', { name: 'AUTO' }));
  });
});

describe('OperatingModeCard group name', () => {
  it('is distinct from the TopBar "Operating mode" group so Settings never exposes two identically named groups', () => {
    render(
      <AetherStoreProvider>
        <OperatingModeCard />
      </AetherStoreProvider>,
    );
    expect(screen.queryByRole('group', { name: 'Operating mode' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Operating mode (synced with top bar)' })).toBeTruthy();
  });
});

describe('OperatingModeCard permission auto-allow toggle', () => {
  it('shows LOW+MED as active by default', () => {
    render(
      <AetherStoreProvider>
        <OperatingModeCard />
      </AetherStoreProvider>,
    );
    const lowMedButton = screen.getByText('LOW+MED');
    expect(lowMedButton.style.background).toContain('linear-gradient');
  });

  it('clicking NONE updates cfg.permissionAutoAllow', () => {
    render(
      <AetherStoreProvider>
        <OperatingModeCard />
      </AetherStoreProvider>,
    );
    fireEvent.click(screen.getByText('NONE'));

    const noneButton = screen.getByText('NONE');
    const lowMedButton = screen.getByText('LOW+MED');
    expect(noneButton.style.background).toContain('linear-gradient');
    expect(lowMedButton.style.background).not.toContain('linear-gradient');
  });
});
