import { DropdownMenu } from 'radix-ui';
import { useId, useState, type KeyboardEvent } from 'react';
import {
  MODEL_OPTIONS,
  PERMISSION_MODES,
  SLASH_COMMANDS,
} from '../data/fixtures';
import type { PermissionMode, SlashCommand } from '../data/types';
import { useIsPhone } from '../hooks/useIsPhone';
import { appActions, useAppStore } from '../store/appStore';
import { SlashMenu } from './SlashMenu';

interface ComposerProps {
  targetKey: string;
  placeholder: string;
  phonePlaceholder?: string;
  inputLabel: string;
  sendActiveWhenEmpty?: boolean;
  onSend: () => void;
  agentControls?: {
    agentId: string;
    model: string;
    mode: PermissionMode;
  };
  channelChipLabel?: string;
}

export function Composer({
  targetKey,
  placeholder,
  phonePlaceholder,
  inputLabel,
  sendActiveWhenEmpty = false,
  onSend,
  agentControls,
  channelChipLabel,
}: ComposerProps) {
  const isPhone = useIsPhone();
  const draft = useAppStore((state) => state.composerDrafts[targetKey] ?? '');
  const [dismissedSlash, setDismissedSlash] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();

  const startsWithSlash = draft.startsWith('/') && !draft.includes(' ');
  const slashQuery = startsWithSlash ? draft.slice(1).toLowerCase() : '';
  const filteredCommands = startsWithSlash
    ? SLASH_COMMANDS.filter((item) =>
        item.command.slice(1).toLowerCase().startsWith(slashQuery),
      )
    : [];

  const isSlashOpen =
    startsWithSlash && !dismissedSlash && filteredCommands.length > 0;
  const safeActiveIndex =
    filteredCommands.length > 0 ? activeIndex % filteredCommands.length : 0;

  const handleDraftChange = (nextValue: string): void => {
    appActions.setComposerDraft(targetKey, nextValue);
    setDismissedSlash(false);
    setActiveIndex(0);
  };

  const handleSelectCommand = (command: SlashCommand): void => {
    appActions.setComposerDraft(targetKey, `${command.command} `);
    setDismissedSlash(true);
    setActiveIndex(0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (isSlashOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((prev) => (prev + 1) % filteredCommands.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex(
          (prev) =>
            (prev - 1 + filteredCommands.length) % filteredCommands.length,
        );
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedSlash(true);
        return;
      }
      if (event.key === 'Enter') {
        const selected = filteredCommands[safeActiveIndex];
        if (selected) {
          event.preventDefault();
          handleSelectCommand(selected);
          return;
        }
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (draft.trim()) {
        onSend();
      }
    }
  };

  const hasText = draft.trim().length > 0;
  const sendEnabled = hasText || sendActiveWhenEmpty;
  const activeOptionId = isSlashOpen
    ? `${listboxId}-option-${safeActiveIndex}`
    : undefined;

  if (isPhone) {
    return (
      <div className="relative px-3.5 pt-2.5 pb-3">
        {isSlashOpen ? (
          <SlashMenu
            id={listboxId}
            commands={filteredCommands}
            activeIndex={safeActiveIndex}
            onSelect={handleSelectCommand}
            onHighlight={setActiveIndex}
          />
        ) : null}

        <div className="flex h-btn-phone items-center gap-2 rounded-pill border border-border bg-elevated pr-2 pl-4">
          <input
            type="text"
            role="combobox"
            aria-label={inputLabel}
            aria-autocomplete="list"
            aria-expanded={isSlashOpen}
            aria-controls={isSlashOpen ? listboxId : undefined}
            aria-activedescendant={activeOptionId}
            value={draft}
            onChange={(event) => handleDraftChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={phonePlaceholder ?? placeholder}
            className={`min-w-0 flex-1 border-0 bg-transparent text-lg text-ink placeholder:text-ink-muted focus:outline-none ${
              startsWithSlash ? 'font-mono text-md' : ''
            }`}
          />
          <button
            type="button"
            aria-label="Send"
            onClick={onSend}
            className={`flex h-btn-md w-touch shrink-0 items-center justify-center rounded-modal border-0 text-phone-title font-bold leading-none transition-quiet ${
              sendEnabled
                ? 'bg-accent text-on-accent hover:opacity-90'
                : 'bg-border text-ink-muted'
            }`}
          >
            ↑
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {isSlashOpen ? (
        <SlashMenu
          id={listboxId}
          commands={filteredCommands}
          activeIndex={safeActiveIndex}
          onSelect={handleSelectCommand}
          onHighlight={setActiveIndex}
        />
      ) : null}

      <div className="flex flex-col gap-3.5 rounded-composer border border-border bg-elevated px-4 pt-3.5 pb-3 transition-quiet focus-within:border-border-strong">
        <input
          type="text"
          role="combobox"
          aria-label={inputLabel}
          aria-autocomplete="list"
          aria-expanded={isSlashOpen}
          aria-controls={isSlashOpen ? listboxId : undefined}
          aria-activedescendant={activeOptionId}
          value={draft}
          onChange={(event) => handleDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={`w-full border-0 bg-transparent text-ink placeholder:text-ink-muted focus:outline-none ${
            startsWithSlash ? 'font-mono text-md' : 'text-base'
          }`}
        />

        <div className="flex items-center gap-2">
          {agentControls ? (
            <>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    aria-label="Select model"
                    className="flex h-chip items-center rounded-sm bg-active px-2.5 text-sm text-ink-strong transition-quiet hover:bg-menu-active hover:text-ink"
                  >
                    {agentControls.model}
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    sideOffset={6}
                    align="start"
                    className="animate-menu-in z-50 min-w-44 rounded-card border border-border bg-popover p-1.5 text-sm text-ink shadow-popover"
                  >
                    {MODEL_OPTIONS.map((modelOption) => (
                      <DropdownMenu.Item
                        key={modelOption}
                        onSelect={() =>
                          appActions.setAgentModel(
                            agentControls.agentId,
                            modelOption,
                          )
                        }
                        className={`flex h-row-md cursor-pointer items-center justify-between rounded-sm px-2.5 outline-none transition-quiet data-[highlighted]:bg-menu-active ${
                          agentControls.model === modelOption
                            ? 'font-semibold text-accent'
                            : 'text-ink-strong'
                        }`}
                      >
                        <span>{modelOption}</span>
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>

              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    aria-label="Select permission mode"
                    className="flex h-chip items-center rounded-sm bg-active px-2.5 text-sm text-ink-strong transition-quiet hover:bg-menu-active hover:text-ink"
                  >
                    {agentControls.mode}
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    sideOffset={6}
                    align="start"
                    className="animate-menu-in z-50 min-w-52 rounded-card border border-border bg-popover p-1.5 text-sm text-ink shadow-popover"
                  >
                    {PERMISSION_MODES.map((modeOption) => (
                      <DropdownMenu.Item
                        key={modeOption}
                        onSelect={() =>
                          appActions.setAgentMode(
                            agentControls.agentId,
                            modeOption,
                          )
                        }
                        className={`flex h-row-md cursor-pointer items-center rounded-sm px-2.5 outline-none transition-quiet data-[highlighted]:bg-menu-active ${
                          agentControls.mode === modeOption
                            ? 'font-semibold text-accent'
                            : 'text-ink-strong'
                        }`}
                      >
                        {modeOption}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </>
          ) : null}

          {channelChipLabel ? (
            <span className="flex h-chip items-center rounded-sm bg-active px-2.5 text-sm text-ink-strong">
              {channelChipLabel}
            </span>
          ) : null}

          <div className="flex-1" />

          <button
            type="button"
            aria-label="Send"
            onClick={onSend}
            className={`flex size-avatar-lg shrink-0 items-center justify-center rounded-full border-0 text-phone-title font-bold leading-none transition-quiet ${
              sendEnabled
                ? 'bg-accent text-on-accent hover:opacity-90'
                : 'bg-border text-ink-muted'
            }`}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
