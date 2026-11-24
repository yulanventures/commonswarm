import type { AvatarTone } from '../data/types';

interface AvatarProps {
  label: string;
  tone: AvatarTone;
  shape: 'agent' | 'person';
  size?: 'sm' | 'md' | 'lg';
}

const TONE_CLASSES: Record<AvatarTone, string> = {
  purple: 'bg-avatar-purple-bg text-avatar-purple-ink',
  green: 'bg-avatar-green-bg text-avatar-green-ink',
  blue: 'bg-avatar-blue-bg text-avatar-blue-ink',
  amber: 'bg-avatar-amber-bg text-avatar-amber-ink',
  maya: 'bg-avatar-maya-bg text-avatar-maya-ink',
  jonas: 'bg-avatar-jonas-bg text-avatar-jonas-ink',
};

const AGENT_SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'size-avatar-sm rounded-sm text-xs font-bold',
  md: 'size-avatar-md rounded-control text-sm font-bold',
  lg: 'size-avatar-lg rounded-md text-sm font-bold',
};

const PERSON_SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'size-avatar-sm rounded-full text-xs font-semibold',
  md: 'size-avatar-md rounded-full text-xs font-semibold',
  lg: 'size-avatar-lg rounded-full text-xs font-semibold',
};

export function Avatar({
  label,
  tone,
  shape,
  size = 'lg',
}: AvatarProps) {
  const sizeClass =
    shape === 'agent' ? AGENT_SIZE_CLASSES[size] : PERSON_SIZE_CLASSES[size];

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 select-none items-center justify-center ${sizeClass} ${TONE_CLASSES[tone]}`}
    >
      {label}
    </span>
  );
}
