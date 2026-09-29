import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Button } from './Button';
import { AetherStoreProvider } from '../../state/store';
import { colors } from '../../styles/tokens';

afterEach(cleanup);

function renderButton(style: React.CSSProperties) {
  return render(
    <AetherStoreProvider>
      <Button onClick={vi.fn()} style={style}>
        label
      </Button>
    </AetherStoreProvider>,
  );
}

describe('Button', () => {
  it('keeps RESET_STYLE background when the caller style explicitly sets an undefined value', () => {
    const { getByRole } = renderButton({ background: undefined });
    expect(getByRole('button').style.background).toBe('none');
  });

  it('lets a real caller-supplied background value win over the reset', () => {
    const { getByRole } = renderButton({ background: 'red' });
    expect(getByRole('button').style.background).toBe('red');
  });

  it('keeps RESET_STYLE cursor when the caller style explicitly sets an undefined cursor', () => {
    const { getByRole } = renderButton({ cursor: undefined });
    expect(getByRole('button').style.cursor).toBe('pointer');
  });

  // jsdom's `:focus-visible` heuristic does not distinguish input modality the
  // way a real browser does (a probe confirmed it matches true even after a
  // simulated mousedown-then-focus sequence), so these tests drive the gate
  // directly by mocking `matches` -- exercising Button's OWN branching on the
  // gate's result, not the browser's un-testable heuristic itself.
  describe('keyboard focus ring', () => {
    it('shows the ring and the lit hover treatment when :focus-visible matches', () => {
      const { getByRole } = renderButton({ background: 'black' });
      const btn = getByRole('button');
      vi.spyOn(btn, 'matches').mockReturnValue(true);
      fireEvent.focus(btn);
      expect(btn.style.outline).toBe(`2px solid ${colors.textPrimary}`);
      expect(btn.style.outlineOffset).toBe('3px');
      expect(btn.style.filter).toBe('brightness(1.1)');
    });

    it('removes the ring and lit treatment on blur', () => {
      const { getByRole } = renderButton({ background: 'black' });
      const btn = getByRole('button');
      vi.spyOn(btn, 'matches').mockReturnValue(true);
      fireEvent.focus(btn);
      fireEvent.blur(btn);
      expect(btn.style.outline).toBe('');
      expect(btn.style.filter).toBe('');
    });

    it('does not show the ring for a mouse-triggered focus (:focus-visible does not match)', () => {
      const { getByRole } = renderButton({ background: 'black' });
      const btn = getByRole('button');
      vi.spyOn(btn, 'matches').mockReturnValue(false);
      fireEvent.focus(btn);
      expect(btn.style.outline).toBe('');
    });
  });

  it('forwards aria-pressed and aria-current to the rendered button', () => {
    const { getAllByRole } = render(
      <AetherStoreProvider>
        <Button onClick={vi.fn()} style={{}} aria-pressed={true}>
          pressed
        </Button>
        <Button onClick={vi.fn()} style={{}} aria-current="page">
          current
        </Button>
      </AetherStoreProvider>,
    );
    const [pressed, current] = getAllByRole('button');
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    expect(current.getAttribute('aria-current')).toBe('page');
  });

  it('stays focusable but ignores activation while aria-disabled, and forwards aria-describedby', () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <AetherStoreProvider>
        <Button onClick={onClick} style={{}} aria-disabled aria-describedby="why">
          label
        </Button>
      </AetherStoreProvider>,
    );
    const btn = getByRole('button');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('aria-describedby')).toBe('why');
    expect(btn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
