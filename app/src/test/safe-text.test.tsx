import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  MAX_URL_CANDIDATE_LENGTH,
  SafeText,
  createSafeTextScanMetrics,
  escapeBidiControlsPlain,
  parseSafeLink,
  scanInlineCodeSegments,
  trimTrailingUrlPunctuation,
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

  it('bounds URL punctuation work at max signal size (8,000 chars) and max candidate length (2,048 chars) in linear passes', () => {
    const SIGNAL_BODY_MAX = 8_000;
    const PAGE_SIZE = 50;

    // 1. Oversized URL with thousands of trailing closing delimiters: cap applied BEFORE trimming -> zero trim work.
    const oversizedUrl = `https://example.com/${')'.repeat(SIGNAL_BODY_MAX - 'https://example.com/'.length)}`;
    expect(oversizedUrl.length).toBe(SIGNAL_BODY_MAX);

    const oversizedMetrics = createSafeTextScanMetrics();
    const { container: oversizedContainer } = render(
      <SafeText text={oversizedUrl} _scanMetrics={oversizedMetrics} />,
    );
    expect(oversizedContainer.querySelectorAll('a')).toHaveLength(0);
    expect(oversizedMetrics.urlTokensInspected).toBe(1);
    expect(oversizedMetrics.urlTokensTrimmed).toBe(0);
    expect(oversizedMetrics.urlTrimCharsVisited).toBe(0);
    expect(oversizedMetrics.inlineCodeCharsVisited).toBe(SIGNAL_BODY_MAX);

    // 2. Max-capped URL (exactly 2,048 chars) packed with trailing unmatched delimiters:
    // strictly linear (<= 2 * 2,048 + 1 char visits vs > 2,000,000 quadratic).
    const maxCappedUrl = `https://example.com/${')'.repeat(MAX_URL_CANDIDATE_LENGTH - 'https://example.com/'.length)}`;
    expect(maxCappedUrl.length).toBe(MAX_URL_CANDIDATE_LENGTH);

    const cappedMetrics = createSafeTextScanMetrics();
    const { container: cappedContainer } = render(
      <SafeText text={maxCappedUrl} _scanMetrics={cappedMetrics} />,
    );
    const cappedLinks = cappedContainer.querySelectorAll('a');
    expect(cappedLinks).toHaveLength(1);
    expect(cappedLinks[0]).toHaveAttribute('href', 'https://example.com/');
    expect(cappedMetrics.urlTokensInspected).toBe(1);
    expect(cappedMetrics.urlTokensTrimmed).toBe(1);
    expect(cappedMetrics.urlTrimCharsVisited).toBeLessThanOrEqual(
      2 * MAX_URL_CANDIDATE_LENGTH + 1,
    );

    // 3. Packed 8,000-char message with multiple max-capped URLs across ), ], } delimiters,
    // repeated across a full 50-message page.
    const urlA = `https://a.test/${')'.repeat(MAX_URL_CANDIDATE_LENGTH - 'https://a.test/'.length)}`;
    const urlB = `https://b.test/${']'.repeat(MAX_URL_CANDIDATE_LENGTH - 'https://b.test/'.length)}`;
    const urlC = `https://c.test/${'}'.repeat(MAX_URL_CANDIDATE_LENGTH - 'https://c.test/'.length)}`;
    const packedBase = `${urlA} ${urlB} ${urlC} `;
    const packedMessage = packedBase + 'x'.repeat(SIGNAL_BODY_MAX - packedBase.length);
    expect(packedMessage.length).toBe(SIGNAL_BODY_MAX);

    const pageMetrics = createSafeTextScanMetrics();
    for (let i = 0; i < PAGE_SIZE; i += 1) {
      trimTrailingUrlPunctuation(urlA, pageMetrics);
      trimTrailingUrlPunctuation(urlB, pageMetrics);
      trimTrailingUrlPunctuation(urlC, pageMetrics);
    }
    expect(pageMetrics.urlTrimCharsVisited).toBeLessThanOrEqual(
      PAGE_SIZE * 3 * (2 * MAX_URL_CANDIDATE_LENGTH + 1),
    );

    const renderedPackedMetrics = createSafeTextScanMetrics();
    const { container: packedContainer } = render(
      <SafeText text={packedMessage} _scanMetrics={renderedPackedMetrics} />,
    );
    expect(packedContainer.querySelectorAll('a')).toHaveLength(3);
    expect(renderedPackedMetrics.urlTrimCharsVisited).toBeLessThanOrEqual(
      2 * SIGNAL_BODY_MAX + 3,
    );

    // 4. Balanced vs unmatched delimiter semantics remain exact.
    expect(trimTrailingUrlPunctuation('https://example.com/a(b))).')).toBe(
      'https://example.com/a(b)',
    );
    expect(trimTrailingUrlPunctuation('https://example.com/x[1]]')).toBe(
      'https://example.com/x[1]',
    );
    expect(trimTrailingUrlPunctuation('https://example.com/{k}}.')).toBe(
      'https://example.com/{k}',
    );
  });

  it('bounds inline-code backtick scanning at max signal size (8,000 chars) and full page (50 messages) to a single forward pass', () => {
    const SIGNAL_BODY_MAX = 8_000;
    const PAGE_SIZE = 50;

    // 1. Single-line message packed with backtick pairs and zero newlines (previously O(n^2) via indexOf('\n')).
    const pairUnit = '`a`';
    const manyPairs =
      pairUnit.repeat(Math.floor(SIGNAL_BODY_MAX / pairUnit.length)) +
      'x'.repeat(SIGNAL_BODY_MAX % pairUnit.length);
    expect(manyPairs.length).toBe(SIGNAL_BODY_MAX);

    const pairMetrics = createSafeTextScanMetrics();
    const { container: pairContainer } = render(
      <SafeText text={manyPairs} _scanMetrics={pairMetrics} />,
    );
    expect(pairContainer.querySelectorAll('code')).toHaveLength(
      Math.floor(SIGNAL_BODY_MAX / pairUnit.length),
    );
    expect(pairMetrics.inlineCodeCharsVisited).toBe(SIGNAL_BODY_MAX);

    // 2. Single-line message of 8,000 consecutive backticks (unmatched empty backticks).
    const allBackticks = '`'.repeat(SIGNAL_BODY_MAX);
    const backtickMetrics = createSafeTextScanMetrics();
    const { container: backtickContainer } = render(
      <SafeText text={allBackticks} _scanMetrics={backtickMetrics} />,
    );
    expect(backtickContainer.querySelectorAll('code')).toHaveLength(0);
    expect(backtickContainer.textContent).toBe(allBackticks);
    expect(backtickMetrics.inlineCodeCharsVisited).toBe(SIGNAL_BODY_MAX);

    // 3. Full 50-message page of 8,000-char pathological backtick inputs visits each char exactly once.
    const pageMetrics = createSafeTextScanMetrics();
    for (let i = 0; i < PAGE_SIZE; i += 1) {
      scanInlineCodeSegments(i % 2 === 0 ? manyPairs : allBackticks, pageMetrics);
    }
    expect(pageMetrics.inlineCodeCharsVisited).toBe(PAGE_SIZE * SIGNAL_BODY_MAX);

    // 4. Edge-case semantics: adjacent backtick before valid span, and newline terminating unclosed backtick.
    expect(scanInlineCodeSegments('``foo`')).toEqual([
      { kind: 'prose', value: '`' },
      { kind: 'code', value: 'foo' },
    ]);
    expect(scanInlineCodeSegments('`unclosed line 1\n`ok`')).toEqual([
      { kind: 'prose', value: '`unclosed line 1\n' },
      { kind: 'code', value: 'ok' },
    ]);
  });
});
