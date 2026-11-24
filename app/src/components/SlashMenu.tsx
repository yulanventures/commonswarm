import type { SlashCommand } from '../data/types';

interface SlashMenuProps {
  id: string;
  commands: readonly SlashCommand[];
  activeIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHighlight: (index: number) => void;
}

export function SlashMenu({
  id,
  commands,
  activeIndex,
  onSelect,
  onHighlight,
}: SlashMenuProps) {
  if (commands.length === 0) return null;

  return (
    <div
      id={id}
      role="listbox"
      aria-label="Slash commands"
      className="animate-menu-in mb-2 flex w-full max-w-slash-menu flex-col gap-0.5 rounded-surface border border-border bg-popover p-2 text-md shadow-popover"
    >
      {commands.map((item, index) => {
        const isActive = index === activeIndex;
        return (
          <button
            key={item.command}
            id={`${id}-option-${index}`}
            type="button"
            role="option"
            aria-selected={isActive}
            onMouseEnter={() => onHighlight(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(item);
            }}
            className={`flex h-row-lg w-full items-center justify-between rounded-sm px-2.5 text-left transition-quiet ${
              isActive
                ? 'bg-menu-active text-ink'
                : 'bg-transparent text-ink-strong hover:bg-menu-active'
            }`}
          >
            <span className="truncate">
              <span
                className={`font-mono ${
                  isActive ? 'text-accent' : 'text-ink-secondary'
                }`}
              >
                {item.command}
              </span>{' '}
              <span>{item.description}</span>
            </span>
            {item.scopeBadge ? (
              <span className="ml-2 shrink-0 text-xs text-ink-muted">
                {item.scopeBadge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
