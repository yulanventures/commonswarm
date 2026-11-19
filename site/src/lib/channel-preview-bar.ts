/**
 * Unjoined public channel preview bar (Designer ruling, 2026-11-19):
 * Shows `Join #<slug>` in place of the composer while browsing a public channel the viewer has
 * not joined. The composer appears only once membership is confirmed; a failed join keeps the
 * preview open with Retry and leaves keyboard focus on the button.
 */
import { channelLabel } from "./channels.js";

export type ChannelPreviewJoinOutcome =
  | { ok: true }
  | { ok: false; message: string };

export interface ChannelPreviewBarOptions {
  slug: string;
  onJoin(): Promise<ChannelPreviewJoinOutcome>;
  onJoined(): void;
}

export interface ChannelPreviewBarControls {
  button: HTMLButtonElement;
  error: HTMLParagraphElement;
}

export function renderChannelPreviewBar(
  root: HTMLElement,
  options: ChannelPreviewBarOptions,
): ChannelPreviewBarControls {
  const doc = root.ownerDocument;
  const bar = doc.createElement("div");
  bar.className = "cm-preview-bar";
  bar.dataset.channelPreviewBar = "";

  const button = doc.createElement("button");
  button.type = "button";
  button.className = "dashboard__button dashboard__button--primary cm-preview-bar__join";
  button.dataset.channelPreviewJoin = "";
  const joinLabel = `Join ${channelLabel(options.slug)}`;
  button.textContent = joinLabel;

  const error = doc.createElement("p");
  error.className = "dashboard__form-error cm-preview-bar__error";
  error.dataset.channelPreviewError = "";
  error.setAttribute("role", "alert");
  error.hidden = true;

  let busy = false;
  button.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Joining…";
    error.hidden = true;
    error.textContent = "";
    try {
      const outcome = await options.onJoin();
      if (outcome.ok) {
        options.onJoined();
        return;
      }
      error.textContent = outcome.message || "CommonSwarm could not join that channel.";
    } catch (reason) {
      error.textContent = reason instanceof Error && reason.message
        ? reason.message
        : "CommonSwarm could not join that channel.";
    }
    busy = false;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = "Retry";
    button.setAttribute("aria-label", `Retry joining ${channelLabel(options.slug)}`);
    button.dataset.channelPreviewRetry = "";
    error.hidden = false;
    if (button.isConnected) button.focus();
  });

  bar.append(button, error);
  root.replaceChildren(bar);
  return { button, error };
}

export interface ChannelMembershipRetryOptions {
  message?: string;
  onRetry(): Promise<void>;
}

/**
 * Shown in place of the composer when the initial Step 2b membership read fails (5xx/network/timeout),
 * so an unjoined public channel never exposes the composer on a transient read error.
 */
export function renderChannelMembershipRetryBar(
  root: HTMLElement,
  options: ChannelMembershipRetryOptions,
): ChannelPreviewBarControls {
  const doc = root.ownerDocument;
  const bar = doc.createElement("div");
  bar.className = "cm-preview-bar";
  bar.dataset.channelMembershipRetryBar = "";

  const button = doc.createElement("button");
  button.type = "button";
  button.className = "dashboard__button dashboard__button--primary cm-preview-bar__join";
  button.dataset.channelMembershipRetry = "";
  button.textContent = "Retry";
  button.setAttribute("aria-label", "Retry checking channel membership");

  const error = doc.createElement("p");
  error.className = "dashboard__form-error cm-preview-bar__error";
  error.dataset.channelMembershipError = "";
  error.setAttribute("role", "alert");
  error.textContent = options.message?.trim() || "Couldn't check channel membership.";

  let busy = false;
  button.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Checking…";
    try {
      await options.onRetry();
    } finally {
      busy = false;
      if (button.isConnected) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.textContent = "Retry";
        button.focus();
      }
    }
  });

  bar.append(button, error);
  root.replaceChildren(bar);
  return { button, error };
}
