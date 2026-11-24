import { Fragment, type ReactNode } from 'react';
import type { AvatarTone, ResolvedMention } from '../data/types';

/**
 * Bidirectional control code points (Trojan Source / spoofing controls):
 * ALM (061C), LRM (200E), RLM (200F), LRE/RLE/PDF/LRO/RLO (202A-202E),
 * LRI/RLI/FSI/PDI (2066-2069).
 *
 * Rather than stripping them silently or emitting them raw (which could reorder
 * surrounding characters), every bidi control code point is replaced with an
 * explicit visible escape token `[U+XXXX]` so it is completely inert and visible.
 */
const BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const HAS_BIDI_OR_CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

const ALLOWED_LINK_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);
const MAX_URL_CANDIDATE_LENGTH = 2048;

/**
 * Linear-time URL candidate pattern (no nested quantifiers).
 * Matches an explicit URI scheme followed by non-whitespace/non-delimiter characters.
 */
const URL_CANDIDATE_RE = /[A-Za-z][A-Za-z0-9+.-]{0,31}:[^\s<>"]+?/g;
const FULL_URL_TOKEN_RE = /[A-Za-z][A-Za-z0-9+.-]{0,31}:[^\s<>"]+/g;

const MENTION_TONE_CLASSES: Record<AvatarTone, string> = {
  purple: 'bg-avatar-purple-bg text-avatar-purple-ink',
  green: 'bg-avatar-green-bg text-avatar-green-ink',
  blue: 'bg-avatar-blue-bg text-avatar-blue-ink',
  amber: 'bg-avatar-amber-bg text-avatar-amber-ink',
  maya: 'bg-avatar-maya-bg text-avatar-maya-ink',
  jonas: 'bg-avatar-jonas-bg text-avatar-jonas-ink',
};

function formatCodePointToken(ch: string): string {
  const hex = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
  return `[U+${hex}]`;
}

/**
 * Replace bidirectional control characters with visible inert `[U+XXXX]` text
 * for contexts that only accept plain text (such as `<code>` / `<pre>`).
 */
export function escapeBidiControlsPlain(text: string): string {
  return text.replace(BIDI_CONTROL_RE, (ch) => formatCodePointToken(ch));
}

/**
 * Render a plain string as React text nodes with every bidirectional control
 * character replaced by a visibly styled inert `[U+XXXX]` marker.
 */
function renderInertText(text: string, keyPrefix: string): ReactNode {
  if (!text) return null;
  BIDI_CONTROL_RE.lastIndex = 0;
  let match = BIDI_CONTROL_RE.exec(text);
  if (!match) return text;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let idx = 0;
  while (match) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    const label = formatCodePointToken(match[0]);
    const code = label.slice(1, -1);
    nodes.push(
      <span
        key={`${keyPrefix}-bidi-${idx}`}
        data-bidi-escape={code}
        className="rounded-tag bg-elevated px-1 font-mono text-2xs text-ink-muted"
      >
        {label}
      </span>,
    );
    idx += 1;
    cursor = match.index + match[0].length;
    match = BIDI_CONTROL_RE.exec(text);
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

/**
 * Trim trailing prose punctuation (`.`, `,`, `;`, `:`, `!`, `?`, `'`, unmatched `)`/`]`/`}`)
 * from a candidate URL so sentences like `See https://example.com.` link cleanly.
 */
function trimTrailingUrlPunctuation(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1]!;
    if (ch === '.' || ch === ',' || ch === ';' || ch === ':' || ch === '!' || ch === '?' || ch === "'") {
      end -= 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      const slice = raw.slice(0, end);
      let opens = 0;
      let closes = 0;
      for (let i = 0; i < slice.length; i += 1) {
        if (slice[i] === open) opens += 1;
        else if (slice[i] === ch) closes += 1;
      }
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return raw.slice(0, end);
}

/**
 * Parse and validate an untrusted URL token.
 * Only `https:`, `http:`, and `mailto:` without embedded credentials, control
 * characters, or bidi characters become clickable links. Everything else returns `null`.
 */
export function parseSafeLink(rawCandidate: string): string | null {
  if (!rawCandidate || rawCandidate.length > MAX_URL_CANDIDATE_LENGTH) {
    return null;
  }
  if (HAS_BIDI_OR_CONTROL_RE.test(rawCandidate)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawCandidate);
  } catch {
    return null;
  }

  if (!ALLOWED_LINK_PROTOCOLS.has(parsed.protocol)) {
    return null;
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }

  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
    if (!parsed.hostname) return null;
    // Reject empty-credential authority forms like `https://@example.com` as well
    // as any `@` inside the raw authority before the first `/`, `?`, or `#`.
    const schemeSep = rawCandidate.indexOf('://');
    if (schemeSep === -1) return null;
    const afterScheme = rawCandidate.slice(schemeSep + 3);
    const authorityEnd = afterScheme.search(/[/?#]/);
    const authority =
      authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
    if (authority.includes('@')) {
      return null;
    }
    return parsed.href;
  }

  // mailto: must specify an address body (not bare `mailto:`) and no whitespace.
  const addr = rawCandidate.slice('mailto:'.length);
  if (!addr || !addr.includes('@') || addr.startsWith('@') || addr.endsWith('@')) {
    return null;
  }
  return parsed.href;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderMentionsInPlainText(
  text: string,
  mentions: readonly ResolvedMention[],
  matchedMentionKeys: Set<string>,
  keyPrefix: string,
): ReactNode {
  if (!text) return null;
  const authorMentions = mentions
    .filter((m) => m.source === 'author' && m.name !== 'Unknown' && m.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);

  if (authorMentions.length === 0) {
    return renderInertText(text, keyPrefix);
  }

  const pattern = new RegExp(
    `@(?:${authorMentions.map((m) => escapeRegExp(m.name)).join('|')})(?![A-Za-z0-9_])`,
    'gi',
  );
  const byLowerName = new Map<string, ResolvedMention>();
  for (const m of authorMentions) {
    const key = m.name.toLowerCase();
    if (!byLowerName.has(key)) byLowerName.set(key, m);
  }

  let match = pattern.exec(text);
  if (!match) {
    return renderInertText(text, keyPrefix);
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let idx = 0;
  while (match) {
    const start = match.index;
    const prevChar = start > 0 ? text[start - 1]! : '';
    // Avoid matching inside email addresses or identifiers like `foo@Atlas`.
    if (prevChar && /[A-Za-z0-9_]/.test(prevChar)) {
      match = pattern.exec(text);
      continue;
    }
    if (start > cursor) {
      nodes.push(
        <Fragment key={`${keyPrefix}-t-${idx}`}>
          {renderInertText(text.slice(cursor, start), `${keyPrefix}-t-${idx}`)}
        </Fragment>,
      );
    }
    const matchedText = match[0];
    const mention = byLowerName.get(matchedText.slice(1).toLowerCase());
    if (mention) {
      matchedMentionKeys.add(`${mention.kind}:${mention.id}`);
      nodes.push(
        <span
          key={`${keyPrefix}-m-${idx}`}
          data-mention-id={mention.id}
          className={`rounded-tag px-1.5 py-0.5 ${MENTION_TONE_CLASSES[mention.tone]}`}
        >
          @{renderInertText(mention.name, `${keyPrefix}-mn-${idx}`)}
        </span>,
      );
    } else {
      nodes.push(renderInertText(matchedText, `${keyPrefix}-mt-${idx}`));
    }
    idx += 1;
    cursor = start + matchedText.length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) {
    nodes.push(
      <Fragment key={`${keyPrefix}-tail`}>
        {renderInertText(text.slice(cursor), `${keyPrefix}-tail`)}
      </Fragment>,
    );
  }
  return nodes;
}

function renderProseRun(
  text: string,
  mentions: readonly ResolvedMention[],
  matchedMentionKeys: Set<string>,
  keyPrefix: string,
): ReactNode {
  if (!text) return null;

  // Quick scan using the non-backtracking token regex.
  FULL_URL_TOKEN_RE.lastIndex = 0;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let idx = 0;
  let match = FULL_URL_TOKEN_RE.exec(text);
  void URL_CANDIDATE_RE;

  while (match) {
    const tokenStart = match.index;
    const rawToken = match[0];
    const candidate = trimTrailingUrlPunctuation(rawToken);
    const safeHref = parseSafeLink(candidate);

    if (safeHref !== null) {
      if (tokenStart > cursor) {
        nodes.push(
          <Fragment key={`${keyPrefix}-pre-${idx}`}>
            {renderMentionsInPlainText(
              text.slice(cursor, tokenStart),
              mentions,
              matchedMentionKeys,
              `${keyPrefix}-pre-${idx}`,
            )}
          </Fragment>,
        );
      }
      nodes.push(
        <a
          key={`${keyPrefix}-a-${idx}`}
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-link underline decoration-link/40 underline-offset-2 transition-quiet hover:text-link-hover [overflow-wrap:anywhere]"
        >
          {candidate}
        </a>,
      );
      cursor = tokenStart + candidate.length;
      idx += 1;
    }

    match = FULL_URL_TOKEN_RE.exec(text);
  }

  if (cursor === 0) {
    return renderMentionsInPlainText(
      text,
      mentions,
      matchedMentionKeys,
      `${keyPrefix}-plain`,
    );
  }

  if (cursor < text.length) {
    nodes.push(
      <Fragment key={`${keyPrefix}-end`}>
        {renderMentionsInPlainText(
          text.slice(cursor),
          mentions,
          matchedMentionKeys,
          `${keyPrefix}-end`,
        )}
      </Fragment>,
    );
  }
  return nodes;
}

function renderInlineCodeAndProse(
  text: string,
  mentions: readonly ResolvedMention[],
  matchedMentionKeys: Set<string>,
  keyPrefix: string,
): ReactNode {
  if (!text) return null;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let idx = 0;

  while (cursor < text.length) {
    const open = text.indexOf('`', cursor);
    if (open === -1) {
      nodes.push(
        <Fragment key={`${keyPrefix}-p-${idx}`}>
          {renderProseRun(
            text.slice(cursor),
            mentions,
            matchedMentionKeys,
            `${keyPrefix}-p-${idx}`,
          )}
        </Fragment>,
      );
      break;
    }

    // Find a matching closing backtick on the same line (non-empty content).
    const nextNewline = text.indexOf('\n', open + 1);
    const close = text.indexOf('`', open + 1);
    const hasInlineClose =
      close !== -1 &&
      close > open + 1 &&
      (nextNewline === -1 || close < nextNewline);

    if (!hasInlineClose) {
      // Unmatched backtick: treat up to and including it as ordinary prose.
      const nextCursor = open + 1;
      nodes.push(
        <Fragment key={`${keyPrefix}-u-${idx}`}>
          {renderProseRun(
            text.slice(cursor, nextCursor),
            mentions,
            matchedMentionKeys,
            `${keyPrefix}-u-${idx}`,
          )}
        </Fragment>,
      );
      cursor = nextCursor;
      idx += 1;
      continue;
    }

    if (open > cursor) {
      nodes.push(
        <Fragment key={`${keyPrefix}-p-${idx}`}>
          {renderProseRun(
            text.slice(cursor, open),
            mentions,
            matchedMentionKeys,
            `${keyPrefix}-p-${idx}`,
          )}
        </Fragment>,
      );
    }

    const codeText = text.slice(open + 1, close);
    nodes.push(
      <code
        key={`${keyPrefix}-c-${idx}`}
        className="rounded-tag bg-elevated px-1 py-0.5 font-mono text-sm text-ink-body [overflow-wrap:anywhere]"
      >
        {escapeBidiControlsPlain(codeText)}
      </code>,
    );
    cursor = close + 1;
    idx += 1;
  }

  return nodes;
}

interface TextBlock {
  readonly kind: 'prose' | 'code_fence';
  readonly value: string;
}

function splitCodeFences(input: string): TextBlock[] {
  const normalized = input.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const blocks: TextBlock[] = [];
  let proseLines: string[] = [];
  let fenceLines: string[] | null = null;
  let fenceOpeningLine = '';

  const flushProse = () => {
    if (proseLines.length > 0) {
      blocks.push({ kind: 'prose', value: proseLines.join('\n') });
      proseLines = [];
    }
  };

  for (const line of lines) {
    if (fenceLines === null) {
      if (/^```[^\n`]*$/.test(line.trimEnd())) {
        flushProse();
        fenceLines = [];
        fenceOpeningLine = line;
      } else {
        proseLines.push(line);
      }
    } else if (/^```\s*$/.test(line)) {
      blocks.push({ kind: 'code_fence', value: fenceLines.join('\n') });
      fenceLines = null;
      fenceOpeningLine = '';
    } else {
      fenceLines.push(line);
    }
  }

  // Unclosed fence stays plain prose rather than swallowing the rest of the message.
  if (fenceLines !== null) {
    proseLines.push(fenceOpeningLine, ...fenceLines);
  }
  flushProse();
  return blocks;
}

export interface SafeTextProps {
  readonly text: string;
  readonly mentions?: readonly ResolvedMention[];
  readonly className?: string;
}

/**
 * Untrusted message body renderer:
 * - Strictly React text nodes and safe elements (`<code>`, `<pre>`, `<a>`, `<span>`).
 * - Zero `dangerouslySetInnerHTML`, zero HTML parsing, zero markdown library.
 * - Links ONLY for `https:`, `http:`, `mailto:` parsed via `new URL()`, with credentials
 *   and bidi/control characters rejected back to plain text.
 * - Bidirectional control characters rendered visibly inert as `[U+XXXX]`.
 */
export function SafeText({ text, mentions = [], className }: SafeTextProps) {
  const blocks = splitCodeFences(text);
  const matchedMentionKeys = new Set<string>();

  const renderedBlocks = blocks.map((block, index) => {
    if (block.kind === 'code_fence') {
      return (
        <pre
          key={`b-${index}`}
          className="my-1.5 max-w-full overflow-x-auto rounded-sm border border-card-border bg-raised px-3 py-2 font-mono text-sm text-ink-body"
        >
          <code className="whitespace-pre">
            {escapeBidiControlsPlain(block.value)}
          </code>
        </pre>
      );
    }
    return (
      <div
        key={`b-${index}`}
        className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
      >
        {renderInlineCodeAndProse(
          block.value,
          mentions,
          matchedMentionKeys,
          `b-${index}`,
        )}
      </div>
    );
  });

  // Any resolved mentions not already matched inline in the body (e.g. server-added
  // mentions, renamed targets, or unknown targets) appear as quiet resolved chips.
  const unmatchedMentions = mentions.filter(
    (m) => !matchedMentionKeys.has(`${m.kind}:${m.id}`),
  );

  return (
    <div className={className}>
      {unmatchedMentions.length > 0 ? (
        <div
          data-testid="message-mentions"
          className="mb-1 flex flex-wrap gap-1.5"
        >
          {unmatchedMentions.map((mention) => (
            <span
              key={`${mention.kind}:${mention.id}`}
              data-mention-id={mention.id}
              className={`rounded-tag px-1.5 py-0.5 text-sm ${MENTION_TONE_CLASSES[mention.tone]}`}
            >
              @{renderInertText(mention.name, `chip-${mention.id}`)}
            </span>
          ))}
        </div>
      ) : null}
      {renderedBlocks}
    </div>
  );
}
