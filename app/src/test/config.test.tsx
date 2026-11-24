import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { readRuntimeConfig } from '../data/config';

function setConfigMeta(url?: string, anonKey?: string): void {
  document
    .querySelectorAll(
      'meta[name="commonswarm:url"], meta[name="commonswarm:anon-key"]',
    )
    .forEach((node) => node.remove());

  if (url !== undefined) {
    const urlMeta = document.createElement('meta');
    urlMeta.setAttribute('name', 'commonswarm:url');
    urlMeta.setAttribute('content', url);
    document.head.appendChild(urlMeta);
  }
  if (anonKey !== undefined) {
    const keyMeta = document.createElement('meta');
    keyMeta.setAttribute('name', 'commonswarm:anon-key');
    keyMeta.setAttribute('content', anonKey);
    document.head.appendChild(keyMeta);
  }
}

afterEach(() => {
  setConfigMeta(undefined, undefined);
});

describe('Runtime configuration reader', () => {
  it('returns not_configured when both meta tags are absent and shows the Sample data marker', () => {
    expect(readRuntimeConfig()).toEqual({ status: 'not_configured' });

    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('sample-data-marker')).toHaveTextContent(
      'Sample data',
    );
  });

  it('returns configured for a valid https url and non-empty anon key and hides the Sample data marker', () => {
    setConfigMeta('https://api.commonswarm.com/', 'anon-public-key');

    expect(readRuntimeConfig()).toEqual({
      status: 'configured',
      url: 'https://api.commonswarm.com',
      anonKey: 'anon-public-key',
    });

    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('sample-data-marker')).not.toBeInTheDocument();
  });

  it('returns invalid when only one meta tag is present or the url is not https', () => {
    setConfigMeta('https://api.commonswarm.com', undefined);
    expect(readRuntimeConfig().status).toBe('invalid');

    setConfigMeta(undefined, 'anon-public-key');
    expect(readRuntimeConfig().status).toBe('invalid');

    setConfigMeta('http://api.commonswarm.com', 'anon-public-key');
    expect(readRuntimeConfig().status).toBe('invalid');

    setConfigMeta('not-a-url', 'anon-public-key');
    expect(readRuntimeConfig().status).toBe('invalid');
  });
});
