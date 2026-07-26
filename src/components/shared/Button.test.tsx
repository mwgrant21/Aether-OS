import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Button } from './Button';
import { AetherStoreProvider } from '../../state/store';

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
});
