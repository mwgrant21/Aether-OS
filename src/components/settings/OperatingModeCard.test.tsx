import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { OperatingModeCard } from './OperatingModeCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(cleanup);

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
