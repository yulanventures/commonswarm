import { describe, expect, it } from 'vitest';
import {
  MULTI_ACCOUNT_STORAGE_KEY_PREFIXES,
  multiAccountInUse,
  sessionStorageKeyForDeployment,
} from '../../../shared/browser-session/index.js';

describe('shared browser-session resolution', () => {
  it('derives the exact single-account storage key for a deployment URL', () => {
    expect(sessionStorageKeyForDeployment('https://api.commonswarm.com')).toBe('sb-api-auth-token');
    expect(sessionStorageKeyForDeployment('http://127.0.0.1:54321')).toBe('sb-127-auth-token');
  });

  it('distinguishes absent, in_use, and unknown storage states', () => {
    const url = 'https://api.commonswarm.com';
    localStorage.clear();
    localStorage.setItem('sb-api-auth-token', '{}');
    expect(MULTI_ACCOUNT_STORAGE_KEY_PREFIXES.length).toBeGreaterThan(0);
    expect(multiAccountInUse(localStorage)).toBe('absent');
    expect(multiAccountInUse(localStorage, url)).toBe('absent');
    localStorage.setItem('commonswarm:accounts:v1:0123456789ab', '{}');
    expect(multiAccountInUse(localStorage)).toBe('in_use');
    localStorage.clear();

    expect(multiAccountInUse(null)).toBe('unknown');
    expect(multiAccountInUse(undefined, url)).toBe('unknown');

    const throwingLength = {
      get length(): number {
        throw new Error('storage blocked');
      },
      key(): string | null {
        return null;
      },
    };
    expect(multiAccountInUse(throwingLength)).toBe('unknown');
    expect(multiAccountInUse(throwingLength, url)).toBe('unknown');

    const throwingFirstKey = {
      length: 1,
      key(): string | null {
        throw new Error('key blocked');
      },
    };
    expect(multiAccountInUse(throwingFirstKey)).toBe('unknown');
    expect(multiAccountInUse(throwingFirstKey, url)).toBe('unknown');

    const throwingLaterKey = {
      length: 3,
      key(index: number): string | null {
        if (index === 0) return 'sb-api-auth-token';
        throw new Error('partial enumeration failure');
      },
    };
    expect(multiAccountInUse(throwingLaterKey)).toBe('unknown');
    expect(multiAccountInUse(throwingLaterKey, url)).toBe('unknown');
  });
});
