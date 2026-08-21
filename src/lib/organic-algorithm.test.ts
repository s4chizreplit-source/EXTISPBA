import { describe, expect, it } from 'vitest';
import { effectiveMinimum } from './organic-algorithm';

describe('effectiveMinimum', () => {
  it('honors an imported saves minimum of 10', () => {
    expect(effectiveMinimum('saves', 10)).toBe(10);
  });

  it('honors a routed provider minimum above the baseline', () => {
    expect(effectiveMinimum('saves', 100)).toBe(100);
  });

  it('preserves the mandatory views baseline', () => {
    expect(effectiveMinimum('views', 10)).toBe(100);
  });
});