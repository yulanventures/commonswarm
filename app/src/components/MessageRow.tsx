import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { AvatarTone, MessageSegment } from '../data/types';
import { Avatar } from './Avatar';

interface MessageRowProps {
  authorName: string;
  avatarLabel: string;
  avatarTone: AvatarTone;
  authorType: 'person' | 'agent';
  timestamp: string;
  segments?: MessageSegment[];
  children?: ReactNode;
}

const MENTION_TONE_CLASSES: Record<AvatarTone, string> = {
  purple: 'bg-avatar-purple-bg text-avatar-purple-ink',
  green: 'bg-avatar-green-bg text-avatar-green-ink',
  blue: 'bg-avatar-blue-bg text-avatar-blue-ink',
  amber: 'bg-avatar-amber-bg text-avatar-amber-ink',
  maya: 'bg-avatar-maya-bg text-avatar-maya-ink',
  jonas: 'bg-avatar-jonas-bg text-avatar-jonas-ink',
};

export function MessageRow({
  authorName,
  avatarLabel,
  avatarTone,
  authorType,
  timestamp,
  segments,
  children,
}: MessageRowProps) {
  return (
    <div className="flex gap-3.5">
      <Avatar
        label={avatarLabel}
        tone={avatarTone}
        shape={authorType}
        size="lg"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-ink">{authorName}</span>
          <span className="text-xs text-ink-muted">{timestamp}</span>
        </div>

        {segments && segments.length > 0 ? (
          <div className="max-w-message-max text-ink-body">
            {segments.map((segment, index) => {
              if (segment.type === 'text') {
                return <span key={index}>{segment.value}</span>;
              }
              if (segment.type === 'code') {
                return (
                  <code
                    key={index}
                    className="font-mono text-sm text-ink-body"
                  >
                    {segment.value}
                  </code>
                );
              }
              return (
                <Link
                  key={index}
                  to={`/agents/${segment.agentId}`}
                  className={`rounded-tag px-1.5 py-0.5 no-underline transition-quiet hover:opacity-90 ${MENTION_TONE_CLASSES[segment.tone]}`}
                >
                  {segment.label}
                </Link>
              );
            })}
          </div>
        ) : null}

        {children}
      </div>
    </div>
  );
}
