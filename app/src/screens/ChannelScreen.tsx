import { useLayoutEffect, useMemo, useRef } from 'react';
import { Link, useParams } from 'react-router';
import { AppFrame } from '../components/AppFrame';
import { ChannelDetailsPanel } from '../components/ChannelDetailsPanel';
import { Composer } from '../components/Composer';
import { EmptyWorkspaceState } from '../components/EmptyWorkspaceState';
import { MessageRow } from '../components/MessageRow';
import { ReviewCard } from '../components/ReviewCard';
import { WorkingCard } from '../components/WorkingCard';
import { groupByDay } from '../data/contracts/signals';
import { PEOPLE } from '../data/fixtures';
import {
  CONVERSATION_UNAVAILABLE_TEXT,
  WORKSPACE_UNAVAILABLE_TEXT,
  useRealConversationData,
  useRealSidebarData,
  useSessionSnapshot,
} from '../data/queries';
import { appActions, useAppStore } from '../store/appStore';

const SCROLL_TOP_LOAD_THRESHOLD_PX = 80;
const SCROLL_BOTTOM_STICK_THRESHOLD_PX = 60;
const NOOP = () => undefined;

function PrivateLockIcon() {
  return (
    <svg
      aria-label="Private"
      role="img"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="mr-1 inline-block size-3.5 shrink-0 text-ink-muted"
    >
      <path d="M5 7V5a3 3 0 1 1 6 0v2h1a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h1Zm2-2v2h2V5a1 1 0 1 0-2 0Z" />
    </svg>
  );
}

function MessageListSkeleton() {
  return (
    <div
      data-testid="conversation-loading"
      aria-busy="true"
      className="flex flex-col gap-5"
    >
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex gap-3.5">
          <div className="size-avatar-lg shrink-0 animate-pulse rounded-full bg-elevated" />
          <div className="flex flex-1 flex-col gap-2 pt-0.5">
            <div className="flex items-center gap-2">
              <div className="h-3.5 w-24 animate-pulse rounded-sm bg-elevated" />
              <div className="h-3 w-10 animate-pulse rounded-sm bg-elevated" />
            </div>
            <div
              className={`h-4 animate-pulse rounded-sm bg-elevated ${
                row % 2 === 0 ? 'w-3/4' : 'w-1/2'
              }`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function formatMemberCounts(peopleCount: number, agentCount: number): string {
  const parts: string[] = [];
  if (peopleCount > 0) {
    parts.push(`${peopleCount} ${peopleCount === 1 ? 'person' : 'people'}`);
  }
  if (agentCount > 0) {
    parts.push(`${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}`);
  }
  return parts.join(' · ');
}

function RealChannelScreen({ routeParam }: { routeParam: string | undefined }) {
  const sidebar = useRealSidebarData();
  const data = useRealConversationData(routeParam);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeScopeKey =
    data.status === 'ready'
      ? `${data.workspaceId}:${data.conversationId}`
      : null;

  const scrollStateRef = useRef<{
    scopeKey: string | null;
    initialized: boolean;
    firstId: string | null;
    lastId: string | null;
    pendingPrepend: { scrollHeight: number; scrollTop: number } | null;
    wasAtBottom: boolean;
  }>({
    scopeKey: null,
    initialized: false,
    firstId: null,
    lastId: null,
    pendingPrepend: null,
    wasAtBottom: true,
  });

  // Reset scroll state synchronously whenever the conversation scope changes or retires.
  if (scrollStateRef.current.scopeKey !== activeScopeKey) {
    scrollStateRef.current = {
      scopeKey: activeScopeKey,
      initialized: false,
      firstId: null,
      lastId: null,
      pendingPrepend: null,
      wasAtBottom: true,
    };
  }

  const readyMessages = data.status === 'ready' ? data.messages : [];
  const readyLoading = data.status === 'ready' ? data.loading : true;
  const firstMessageId = readyMessages[0]?.id ?? null;
  const lastMessageId = readyMessages[readyMessages.length - 1]?.id ?? null;

  const streamRows = useMemo(() => {
    if (readyMessages.length === 0) return [];
    const locale =
      typeof navigator !== 'undefined' && navigator.language
        ? navigator.language
        : 'en-US';
    return groupByDay(readyMessages, Date.now(), locale);
  }, [readyMessages]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const state = scrollStateRef.current;
    if (!el || activeScopeKey === null || readyLoading) return;

    if (!state.initialized) {
      el.scrollTop = el.scrollHeight;
      state.initialized = true;
      state.firstId = firstMessageId;
      state.lastId = lastMessageId;
      state.pendingPrepend = null;
      state.wasAtBottom = true;
      return;
    }

    // Older messages prepended at the top: keep the visible reading position anchored.
    if (
      state.pendingPrepend !== null &&
      firstMessageId !== null &&
      firstMessageId !== state.firstId
    ) {
      const delta = el.scrollHeight - state.pendingPrepend.scrollHeight;
      el.scrollTop = state.pendingPrepend.scrollTop + Math.max(0, delta);
      state.pendingPrepend = null;
      state.firstId = firstMessageId;
      state.lastId = lastMessageId;
      return;
    }

    // Newer message appended at the bottom: keep pinned only if the reader was at the bottom.
    if (lastMessageId !== state.lastId) {
      if (state.wasAtBottom) {
        el.scrollTop = el.scrollHeight;
      }
      state.firstId = firstMessageId;
      state.lastId = lastMessageId;
    }
  }, [
    activeScopeKey,
    readyLoading,
    firstMessageId,
    lastMessageId,
    readyMessages.length,
  ]);

  if (data.status === 'workspace_unavailable') {
    return (
      <AppFrame>
        <div
          data-testid="workspace-unavailable-pane"
          className="flex flex-1 items-center justify-center px-6 text-md text-ink-secondary"
        >
          {WORKSPACE_UNAVAILABLE_TEXT}
        </div>
      </AppFrame>
    );
  }

  if (
    !sidebar.workspacesLoading &&
    !sidebar.workspacesError &&
    !sidebar.workspaceUnavailable &&
    sidebar.workspaces.length === 0
  ) {
    return (
      <AppFrame>
        <EmptyWorkspaceState />
      </AppFrame>
    );
  }

  if (data.status === 'unavailable') {
    return (
      <AppFrame>
        <div
          data-testid="conversation-unavailable"
          className="flex flex-1 items-center justify-center px-6 text-md text-ink-secondary"
        >
          {CONVERSATION_UNAVAILABLE_TEXT}
        </div>
      </AppFrame>
    );
  }

  if (data.status === 'loading_list') {
    return (
      <AppFrame>
        <header className="flex h-header shrink-0 items-center gap-3 border-b border-hairline px-4.5 desktop:px-pad-header">
          <Link
            to="/home"
            aria-label="Back"
            className="-ml-2.5 flex size-touch shrink-0 items-center justify-center text-dialog-title text-ink-strong no-underline transition-quiet hover:text-ink desktop:hidden"
          >
            ‹
          </Link>
          <div className="h-5 w-32 animate-pulse rounded-sm bg-elevated" />
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4.5 pt-5 pb-4 desktop:px-pad-page desktop:pt-6.5">
          <MessageListSkeleton />
        </div>
      </AppFrame>
    );
  }

  if (data.status === 'list_error') {
    return (
      <AppFrame>
        <header className="flex h-header shrink-0 items-center gap-3 border-b border-hairline px-4.5 desktop:px-pad-header">
          <Link
            to="/home"
            aria-label="Back"
            className="-ml-2.5 flex size-touch shrink-0 items-center justify-center text-dialog-title text-ink-strong no-underline transition-quiet hover:text-ink desktop:hidden"
          >
            ‹
          </Link>
        </header>
        <div
          data-testid="conversation-error"
          className="flex flex-1 items-center justify-center gap-3 px-6 text-sm text-ink-secondary"
        >
          <span>Couldn&apos;t load conversation.</span>
          <button
            type="button"
            onClick={data.retry}
            className="shrink-0 rounded-control border border-border bg-raised px-2.5 py-1 text-xs font-medium text-ink transition-quiet hover:border-border-strong hover:bg-active"
          >
            Retry
          </button>
        </div>
      </AppFrame>
    );
  }

  const { header, channelAgents } = data;
  const workingCount = channelAgents.filter(
    (agent) => agent.state === 'working' || agent.state === 'waiting',
  ).length;
  const memberCountLabel = header.hasMemberCounts
    ? formatMemberCounts(header.peopleCount, header.agentCount)
    : '';
  const composerTargetName = header.isChannel
    ? `# ${header.title}`
    : header.title;

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    scrollStateRef.current.wasAtBottom =
      distanceFromBottom <= SCROLL_BOTTOM_STICK_THRESHOLD_PX;

    if (
      el.scrollTop <= SCROLL_TOP_LOAD_THRESHOLD_PX &&
      data.hasOlder &&
      !data.loadingOlder
    ) {
      scrollStateRef.current.pendingPrepend = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
      data.loadOlder();
    }
  };

  return (
    <AppFrame
      detailsPanel={
        channelAgents.length > 0 ? (
          <ChannelDetailsPanel agents={[...channelAgents]} />
        ) : undefined
      }
      detailsLabel="Channel details"
    >
      <header className="flex h-header shrink-0 items-center gap-3 border-b border-hairline px-4.5 desktop:px-pad-header">
        <Link
          to="/home"
          aria-label="Back"
          className="-ml-2.5 flex size-touch shrink-0 items-center justify-center text-dialog-title text-ink-strong no-underline transition-quiet hover:text-ink desktop:hidden"
        >
          ‹
        </Link>

        <h1 className="flex min-w-0 items-center truncate text-lg font-bold tracking-tight text-ink">
          {header.isPrivate ? <PrivateLockIcon /> : null}
          <span className="truncate">
            {header.isChannel ? `# ${header.title}` : header.title}
          </span>
        </h1>

        {memberCountLabel ? (
          <span className="hidden shrink-0 text-sm text-ink-muted desktop:inline">
            {memberCountLabel}
          </span>
        ) : null}

        <div className="flex-1" />

        {workingCount > 0 ? (
          <span className="inline-flex h-pill shrink-0 items-center gap-1.5 rounded-card bg-working-surface px-2.5 text-xs font-semibold text-working-ink">
            <span
              aria-hidden="true"
              className="size-dot-xs rounded-full bg-working"
            />
            {workingCount} working
          </span>
        ) : null}
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="message-list"
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4.5 pt-5 pb-4 desktop:px-pad-page desktop:pt-6.5"
      >
        {data.loading ? (
          <MessageListSkeleton />
        ) : data.error ? (
          <div
            data-testid="conversation-error"
            className="flex items-center justify-between gap-3 rounded-card border border-card-border bg-raised px-4 py-3 text-sm text-ink-secondary"
          >
            <span>Couldn&apos;t load messages.</span>
            <button
              type="button"
              onClick={data.retry}
              className="shrink-0 rounded-control border border-border bg-elevated px-2.5 py-1 text-xs font-medium text-ink transition-quiet hover:border-border-strong hover:bg-active"
            >
              Retry
            </button>
          </div>
        ) : streamRows.length === 0 ? (
          <div
            data-testid="conversation-empty"
            className="flex flex-1 items-center justify-center text-sm text-ink-muted"
          >
            No messages yet
          </div>
        ) : (
          <>
            {data.loadingOlder ? (
              <div
                data-testid="loading-older"
                role="status"
                aria-label="Loading older messages"
                className="flex items-center justify-center py-1"
              >
                <span className="size-4 animate-spin rounded-full border-2 border-border border-t-ink-secondary" />
              </div>
            ) : null}

            {streamRows.map((row) => {
              if (row.type === 'divider') {
                return (
                  <div
                    key={`day-${row.key}`}
                    data-testid="day-separator"
                    className="flex items-center gap-3 py-1"
                  >
                    <div className="h-px flex-1 bg-hairline" />
                    <span className="text-xs font-medium text-ink-muted">
                      {row.label}
                    </span>
                    <div className="h-px flex-1 bg-hairline" />
                  </div>
                );
              }
              const message = row.item;
              return (
                <MessageRow
                  key={message.id}
                  authorName={message.authorName}
                  avatarLabel={message.avatarLabel}
                  avatarTone={message.avatarTone}
                  authorType={message.authorType}
                  timestamp={message.timeLabel}
                  dateTime={message.createdAt}
                  body={message.body}
                  mentions={message.mentions}
                  cardLabel={message.cardLabel}
                  replyCount={message.replyCount}
                />
              );
            })}
          </>
        )}
      </div>

      <div className="shrink-0 desktop:px-pad-page desktop:pb-6">
        <Composer
          targetKey={`conversation:${data.conversationId}`}
          placeholder="Read-only preview"
          phonePlaceholder="Read-only preview"
          inputLabel={`Message ${composerTargetName}`}
          disabled
          onSend={NOOP}
          channelChipLabel={`To: ${composerTargetName}`}
        />
      </div>
    </AppFrame>
  );
}

function SampleChannelScreen({ name }: { name: string | undefined }) {
  const channels = useAppStore((state) => state.channels);
  const agents = useAppStore((state) => state.agents);

  const channel =
    channels.find((item) => item.name === name) ??
    channels.find((item) => item.name === 'launch') ??
    channels[0];

  if (!channel) return null;

  const channelAgents = channel.agentIds
    .map((agentId) => agents.find((agent) => agent.id === agentId))
    .filter((agent) => agent !== undefined);

  const workingCount = channelAgents.filter(
    (agent) => agent.state === 'working' || agent.state === 'waiting',
  ).length;

  return (
    <AppFrame
      detailsPanel={<ChannelDetailsPanel agents={channelAgents} />}
      detailsLabel="Channel details"
    >
      <header className="flex h-header shrink-0 items-center gap-3 border-b border-hairline px-4.5 desktop:px-pad-header">
        <Link
          to="/home"
          aria-label="Back"
          className="-ml-2.5 flex size-touch shrink-0 items-center justify-center text-dialog-title text-ink-strong no-underline transition-quiet hover:text-ink desktop:hidden"
        >
          ‹
        </Link>

        <h1 className="text-lg font-bold tracking-tight text-ink">
          # {channel.name}
        </h1>
        <span
          data-testid="sample-data-marker"
          className="shrink-0 rounded-tag border border-border bg-elevated px-1.5 py-0.5 text-2xs font-medium text-ink-muted"
        >
          Sample data
        </span>
        <span className="hidden text-sm text-ink-muted desktop:inline">
          {channel.peopleCount} people · {channelAgents.length}{' '}
          {channelAgents.length === 1 ? 'agent' : 'agents'}
        </span>

        <div className="flex-1" />

        {workingCount > 0 ? (
          <span className="inline-flex h-pill shrink-0 items-center gap-1.5 rounded-card bg-working-surface px-2.5 text-xs font-semibold text-working-ink">
            <span
              aria-hidden="true"
              className="size-dot-xs rounded-full bg-working"
            />
            {workingCount} working
          </span>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4.5 pt-5 pb-4 desktop:px-pad-page desktop:pt-6.5">
        {channel.messages.map((message) => {
          if (message.authorType === 'person') {
            const person = PEOPLE.find((p) => p.id === message.authorId);
            return (
              <MessageRow
                key={message.id}
                authorName={person?.name ?? message.authorId}
                avatarLabel={person?.initials ?? '??'}
                avatarTone={person?.tone ?? 'maya'}
                authorType="person"
                timestamp={message.timestamp}
                segments={message.segments}
              />
            );
          }

          const agent = agents.find((a) => a.id === message.authorId);
          return (
            <MessageRow
              key={message.id}
              authorName={agent?.name ?? message.authorId}
              avatarLabel={agent?.initial ?? '?'}
              avatarTone={agent?.tone ?? 'purple'}
              authorType="agent"
              timestamp={message.timestamp}
              segments={message.segments}
            >
              {message.workingCard ? (
                <WorkingCard data={message.workingCard} />
              ) : null}
              {message.reviewCard ? (
                <ReviewCard data={message.reviewCard} />
              ) : null}
            </MessageRow>
          );
        })}
      </div>

      <div className="shrink-0 desktop:px-pad-page desktop:pb-6">
        <Composer
          targetKey={`channel:${channel.name}`}
          placeholder={`Message # ${channel.name}. @ people, # channels, / commands`}
          phonePlaceholder={`Message # ${channel.name}`}
          inputLabel={`Message # ${channel.name}`}
          onSend={() => appActions.sendChannelMessage(channel.name)}
          channelChipLabel={`To: # ${channel.name}`}
        />
      </div>
    </AppFrame>
  );
}

export function ChannelScreen() {
  const { name } = useParams<{ name: string }>();
  const snapshot = useSessionSnapshot();

  if (snapshot.state.status === 'authenticated' && snapshot.userId !== null) {
    return <RealChannelScreen routeParam={name} />;
  }

  return <SampleChannelScreen name={name} />;
}
