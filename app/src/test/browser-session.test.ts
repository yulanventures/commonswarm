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

  it('detects multi-account storage keys without touching single-account storage', () => {
    localStorage.clear();
    localStorage.setItem('sb-api-auth-token', '{}');
    expect(MULTI_ACCOUNT_STORAGE_KEY_PREFIXES.length).toBeGreaterThan(0);
    expect(multiAccountInUse(localStorage)).toBe(false);
    localStorage.setItem('commonswarm:accounts:v1:0123456789ab', '{}');
    expect(multiAccountInUse(localStorage)).toBe(true);
    localStorage.clear();
  });
});
