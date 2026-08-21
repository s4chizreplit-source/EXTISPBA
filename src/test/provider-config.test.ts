import { describe, expect, it } from 'vitest';
import { isValidProviderApiUrl } from '../../server/src/provider-config.js';

describe('provider API URL validation', () => {
  it('accepts HTTP and HTTPS provider endpoints', () => {
    expect(isValidProviderApiUrl('https://provider.example/api/v2')).toBe(true);
    expect(isValidProviderApiUrl('http://provider.example/api')).toBe(true);
  });

  it('rejects malformed and non-HTTP values', () => {
    expect(isValidProviderApiUrl('not-a-url')).toBe(false);
    expect(isValidProviderApiUrl('ftp://provider.example/api')).toBe(false);
    expect(isValidProviderApiUrl('')).toBe(false);
  });
});