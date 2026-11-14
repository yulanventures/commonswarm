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
export const UNKNOWN_CHANNEL_ATTACHMENTS_TEXT = "Attachments aren't available here until this channel has loaded.";

/** The sentence for a place where files may not be attached; "" where they may. */
export const attachmentsRefusal = (visibility: ChannelVisibility | null): string =>
  visibility === "open" ? "" : visibility === "private" ? PRIVATE_CHANNEL_ATTACHMENTS_TEXT : UNKNOWN_CHANNEL_ATTACHMENTS_TEXT;
