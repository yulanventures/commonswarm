import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  SafeText,
  escapeBidiControlsPlain,
  parseSafeLink,
} from '../components/SafeText';
import type { ResolvedMention } from '../data/types';

describe('SafeText hostile input and formatting', () => {
  it('renders script tags and raw HTML strictly as text nodes with zero injected elements', () => {
    const hostile =
      '<script>alert(1)</script> <img src=x onerror=alert(1)> <svg onload=alert(2)> <iframe src="https://evil.test"></iframe>';
    const { container } = render(<SafeText text={hostile} />);

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.textContent).toContain('<svg onload=alert(2)>');
  });

  it('refuses javascript:, data:, vbscript:, file:, and mixed-case unsafe schemes as plain text', () => {
    const hostile = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(2)',
      'data:text/html,<script>alert(3)</script>',
      'DATA:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.com/123',
      'ftp://example.com/secret',
    ].join(' ');

    const { container } = render(<SafeText text={hostile} />);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('javascript:alert(1)');
    expect(container.textContent).toContain('JaVaScRiPt:alert(2)');
    expect(container.textContent).toContain('DATA:text/html;base64,PHNjcmlwdD4=');
  });

  it('allows https:, http:, and mailto: (including mixed-case schemes) with rel="noopener noreferrer" and target="_blank"', () => {
    const text =
      'Check HTTPS://Example.COM/docs?q=1, http://example.org/a(b). and MaIlTo:team@example.com!';
    const { container } = render(<SafeText text={text} />);

    const links = Array.from(container.querySelectorAll('a'));
    expect(links).toHaveLength(3);

    expect(links[0]).toHaveAttribute('href', 'https://example.com/docs?q=1');
    expect(links[0]).toHaveTextContent('HTTPS://Example.COM/docs?q=1');
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');

    expect(links[1]).toHaveAttribute('href', 'http://example.org/a(b)');
    expect(links[1]).toHaveTextContent('http://example.org/a(b)');
    expect(links[1]).toHaveAttribute('target', '_blank');
    expect(links[1]).toHaveAttribute('rel', 'noopener noreferrer');

    expect(links[2]).toHaveAttribute('href', 'mailto:team@example.com');
    expect(links[2]).toHaveTextContent('MaIlTo:team@example.com');
    expect(links[2]).toHaveAttribute('target', '_blank');
    expect(links[2]).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders URLs with credentials (including empty-user @ form) as plain text, never links', () => {
    const samples = [
      'https://user:pass@evil.example/login',
      'https://alice@evil.example/path',
      'http://admin:secret@127.0.0.1/',
      'https://@evil.example/spoof',
      'HTTPS://user:pw@example.com:8443/x',
    ];
    for (const sample of samples) {
      expect(parseSafeLink(sample)).toBeNull();
    }
    const { container } = render(<SafeText text={samples.join(' ')} />);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('https://user:pass@evil.example/login');
    expect(container.textContent).toContain('https://@evil.example/spoof');
  });

  it('renders inline code and code fences as <code>/<pre> with inert text and never parses nested markup or links inside code', () => {
    const text = [
      'Run `npm test && https://not-a-link.test <script>x</script>` then:',
      '```ts',
      'const html = "<img src=x onerror=alert(1)>";',
      'const url = "https://also-not-a-link.test";',
      '```',
      'Nested markdown [evil](javascript:alert(1)) and <a href="javascript:alert(1)">click</a> stay text.',
    ].join('\n');

    const { container } = render(<SafeText text={text} />);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.querySelector('code')?.textContent).toContain(
      'const html = "<img src=x onerror=alert(1)>";',
    );
    expect(pre!.querySelector('code')?.textContent).toContain(
      'https://also-not-a-link.test',
    );

    const inlineCodes = Array.from(container.querySelectorAll('code')).filter(
      (el) => el.parentElement?.tagName !== 'PRE',
    );
    expect(inlineCodes).toHaveLength(1);
    expect(inlineCodes[0]!.textContent).toBe(
      'npm test && https://not-a-link.test <script>x</script>',
    );
  });

  it('handles very long tokens quickly without catastrophic backtracking or oversized links', () => {
    const longToken = 'a'.repeat(25_000);
    const longUrl = `https://example.com/${'b'.repeat(4_000)}`;
    const start = performance.now();
    const { container } = render(<SafeText text={`${longToken} ${longUrl}`} />);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain(longToken);
  });

  it('renders bidirectional control characters visibly inert as [U+XXXX] (never strips silently and never linkifies bidi URLs)', () => {
    const rlo = '\u202E';
    const pdf = '\u202C';
    const lri = '\u2066';
    const pdi = '\u2069';
    const text = `Check ${rlo}gpj.exe${pdf} and ${lri}safe${pdi} and https://example.com/${rlo}spoof and \`code${rlo}end\``;

    const { container } = render(<SafeText text={text} />);

    // Zero raw bidi control characters survive in rendered text.
    expect(container.textContent).not.toMatch(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
    // Explicit visible escape markers are present (not silently stripped).
    expect(container.textContent).toContain('[U+202E]');
    expect(container.textContent).toContain('[U+202C]');
    expect(container.textContent).toContain('[U+2066]');
    expect(container.textContent).toContain('[U+2069]');
    expect(container.querySelectorAll('[data-bidi-escape="U+202E"]').length).toBeGreaterThanOrEqual(2);
    // URL containing bidi control is NOT turned into a link.
    expect(container.querySelectorAll('a')).toHaveLength(0);
    // Code span escapes bidi to plain [U+202E].
    expect(escapeBidiControlsPlain(`code${rlo}end`)).toBe('code[U+202E]end');
  });

  it('renders resolved mentions safely as text nodes (inline for author mentions, chip row for unmatched/unknown)', () => {
    const mentions: ResolvedMention[] = [
      { id: 'agent-1', kind: 'agent', name: 'Atlas', tone: 'purple', source: 'author' },
      { id: 'user-2', kind: 'person', name: '<script>xss</script>', tone: 'maya', source: 'lead' },
      { id: 'user-3', kind: 'person', name: 'Unknown', tone: 'jonas', source: 'author' },
    ];
    const { container } = render(
      <SafeText text="@Atlas please check this" mentions={mentions} />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('@Atlas')).toBeInTheDocument();
    expect(screen.getByText('@<script>xss</script>')).toBeInTheDocument();
    expect(screen.getByText('@Unknown')).toBeInTheDocument();
  });
});
