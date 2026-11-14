/*
 * Private channels in the web app. A private channel's messages are read only by its members, but a
 * workspace's files are readable by every member. The server refuses a message with attachments in a
 * private channel for every client. The browser has one more duty of its own: its composer uploads the
 * staged files when Send is pressed, before the message is posted, so it must not start a send the
 * server will refuse. Everything here is pure, so the dashboard only asks and obeys.
 */
import { CHANNEL_VISIBILITIES, type ChannelVisibility } from "../../../supabase/functions/_shared/channels.js";

export type { ChannelVisibility };

/** A channel row's visibility. `null` is a value this build does not know, or none at all. */
export const parseChannelVisibility = (value: unknown): ChannelVisibility | null =>
  (CHANNEL_VISIBILITIES as readonly unknown[]).includes(value) ? value as ChannelVisibility : null;

/**
 * Whose eyes a message placed here is for, as far as files are concerned.
 * `channelId` is where the message will be filed: the open channel, or for a thread reply the channel of
 * the thread's root. `null` is unfiled (#general, All messages, a direct message), which is not a channel.
 * A channel that is not in the list, or whose visibility is not known, is `null`: unknown.
 */
export const placementVisibility = (
  channels: readonly { channelId: string; visibility?: ChannelVisibility | null }[],
  channelId: string | null,
): ChannelVisibility | null => {
  if (channelId === null) return "open";
  return channels.find((channel) => channel.channelId === channelId)?.visibility ?? null;
};

/**
 * Whether files may be attached to a message placed there. Only where the place is known to be open:
 * an unknown place is treated as private, because a wrong guess the other way stores a file where the
 * whole workspace can read it.
 */
export const attachmentsAllowed = (visibility: ChannelVisibility | null): boolean => visibility === "open";

export const PRIVATE_CHANNEL_ATTACHMENTS_TEXT = "Attachments aren't available in private channels.";
/** Shown where the place could not be told apart, so the sentence does not claim it is private. */
export const UNKNOWN_CHANNEL_ATTACHMENTS_TEXT = "Attachments aren't available here: CommonSwarm could not confirm this channel is open.";

/** The sentence for a place where files may not be attached; "" where they may. */
export const attachmentsRefusal = (visibility: ChannelVisibility | null): string =>
  visibility === "open" ? "" : visibility === "private" ? PRIVATE_CHANNEL_ATTACHMENTS_TEXT : UNKNOWN_CHANNEL_ATTACHMENTS_TEXT;

/**
 * Where a message written now would be filed, from what is open on screen, never from a looked-up row.
 * `activeChannelId` is the view's own id: `null` for All messages or a direct message, `generalId` for
 * #general, and otherwise one channel's id. A row that has left the list (the viewer was removed from a
 * private channel, or the list has not loaded) must not turn that channel into "unfiled": the id is kept,
 * and `mustResolve` says the send has to find it in the list or stop.
 * A reply is filed where its root is (`replyRootChannelId`, `null` for an unfiled root), whatever is open.
 */
export const sendDestination = (view: {
  activeChannelId: string | null;
  generalId: string;
  replyRootChannelId?: string | null;
}): { channelId: string | null; mustResolve: boolean } => {
  if (view.replyRootChannelId !== undefined) return { channelId: view.replyRootChannelId, mustResolve: false };
  if (view.activeChannelId === null || view.activeChannelId === view.generalId) return { channelId: null, mustResolve: false };
  return { channelId: view.activeChannelId, mustResolve: true };
};

/** A send's files were not uploaded because its destination is not known to be open. The message is the sentence to show. */
export class AttachmentsRefused extends Error {
  constructor(message: string) { super(message); this.name = "AttachmentsRefused"; }
}

/**
 * Uploads a send's files, and only after a FRESH read says the destination is open.
 *
 * The page's channel list can be stale: a channel can be made private from another client while a page that
 * still lists it as open has files staged. So the list is not permission to upload. Just before the first
 * upload the destination's visibility is read again, and anything but a confirmed "open" (private, no row,
 * a refusal, a failed read, an unknown value) uploads nothing and throws `AttachmentsRefused`.
 *
 * What this does not promise: a channel made private after this read and during the uploads is not caught
 * here. Closing that would need the server to know what an upload is for.
 *
 * `channelId` is the send's pinned destination (`null` is unfiled, which is not a channel and is not read).
 */
export async function uploadAttachmentsFor<File, Ref>(options: {
  channelId: string | null;
  files: readonly File[];
  readVisibility: (channelId: string) => Promise<unknown>;
  upload: (file: File, index: number) => Promise<Ref>;
}): Promise<Ref[]> {
  if (options.files.length === 0) return [];
  if (options.channelId !== null) {
    let fresh: ChannelVisibility | null = null;
    try { fresh = parseChannelVisibility(await options.readVisibility(options.channelId)); } catch { fresh = null; }
    if (!attachmentsAllowed(fresh)) throw new AttachmentsRefused(attachmentsRefusal(fresh));
  }
  const refs: Ref[] = [];
  for (const [index, file] of options.files.entries()) refs.push(await options.upload(file, index));
  return refs;
}
