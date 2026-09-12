import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AetherStoreProvider } from '../../state/store';
import { CommunicationCard } from './CommunicationCard';
afterEach(() => { cleanup(); localStorage.clear(); });
it('shows a default-off preference and no invented readiness', () => {
  render(<AetherStoreProvider><CommunicationCard /></AetherStoreProvider>);
  const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  expect(screen.getByRole('status').textContent).toContain('status unavailable');
  expect(screen.getByText(/does not launch a session/)).toBeTruthy();
  fireEvent.click(checkbox);
  expect(checkbox.checked).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('status unavailable');
});
