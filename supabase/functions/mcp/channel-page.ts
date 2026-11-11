/**
 * channel_read pages against the real wire. The tool output is JSON-encoded into the result text,
 * and that text is JSON-encoded again in the JSON-RPC response, so escaping counts twice. Whole
 * messages are kept; the rest follows next.after_id. Provenance is left out of the fit: the protocol
 * layer shrinks or drops it to fit whatever room remains.
 */
export const CHANNEL_READ_MARGIN_BYTES = 1024;
// The worst-case request id the protocol accepts: 256 control characters, each escaped as \u00XX.
const ID_ALLOWANCE = "\u0001".repeat(256);

export interface ChannelPageShape {
  context: unknown;
  workspace_id: unknown;
  channel: unknown;
  archived: unknown;
  messages: Array<Record<string, unknown>>;
  next: unknown;
}

export function channelPageWireBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: ID_ALLOWANCE,
    result: { content: [{ type: "text", text: JSON.stringify(value) }] } })).byteLength;
}

/** Whether a fitted page is within the budget, so the response carrying it can be delivered. */
export function channelPageDeliverable(page: ChannelPageShape, maxResponseBytes: number): boolean {
  return channelPageWireBytes(page) <= maxResponseBytes - CHANNEL_READ_MARGIN_BYTES;
}

export function fitChannelPage(page: ChannelPageShape, maxResponseBytes: number): ChannelPageShape {
  const budget = maxResponseBytes - CHANNEL_READ_MARGIN_BYTES;
  let kept = page.messages.length;
  let next = page.next;
  const shaped = () => ({ ...page, messages: page.messages.slice(0, kept), next });
  while (kept > 1 && channelPageWireBytes(shaped()) > budget) {
    kept -= 1;
    next = { after_id: page.messages[kept - 1]!.signal_id };
  }
  return shaped();
}
