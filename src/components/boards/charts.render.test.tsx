import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LinePanel } from './LinePanel';
import { BarPanel } from './BarPanel';

afterEach(cleanup);
const rows = [{ day: '2026-10-11', input_tokens: 10, output_tokens: 3 }];
const y = ['input_tokens', 'output_tokens'];

describe('multi-series charts', () => {
  it('a line chart names each series in a legend and in point tooltips', () => {
    const { container } = render(<LinePanel rows={rows} x="day" y={y} />);
    expect(screen.getByText('input_tokens')).toBeTruthy();
    expect(screen.getByText('output_tokens')).toBeTruthy();
    const titles = [...container.querySelectorAll('title')].map((t) => t.textContent);
    expect(titles).toContain('2026-10-11 · output_tokens: 3');
  });
  it('a bar chart names each series in a legend and on each bar', () => {
    const { container } = render(<BarPanel rows={rows} x="day" y={y} />);
    expect(screen.getByText('output_tokens')).toBeTruthy();
    expect(container.querySelector('[title="output_tokens: 3"]')).not.toBeNull();
  });
  it('a single-series chart has no legend', () => {
    render(<LinePanel rows={rows} x="day" y={['input_tokens']} />);
    expect(screen.queryByText('input_tokens')).toBeNull();
  });
});
