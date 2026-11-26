export interface PasswordToggleWindow {
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface PasswordToggleInput {
  type: string;
  disabled?: boolean;
  spellcheck?: boolean;
  form?: PasswordToggleForm | null;
  ownerDocument?: { defaultView?: PasswordToggleWindow | null } | null;
  closest?: (selector: string) => unknown;
  setAttribute?: (name: string, value: string) => void;
}

export interface PasswordToggleButton {
  type?: string;
  disabled?: boolean;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
}

export interface PasswordToggleForm {
  addEventListener(type: string, listener: () => void): void;
}

export interface PasswordToggleHandle {
  reset(): void;
}

const SHOW_LABEL = "Show";
const HIDE_LABEL = "Hide";
const SHOW_ARIA_LABEL = "Show password";
const HIDE_ARIA_LABEL = "Hide password";

function pinTextAssistanceOptOuts(input: PasswordToggleInput): void {
  input.spellcheck = false;
  if (typeof input.setAttribute === "function") {
    input.setAttribute("spellcheck", "false");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "none");
    input.setAttribute("writingsuggestions", "false");
  }
}

function resolveEnclosingForm(input: PasswordToggleInput): PasswordToggleForm | null {
  if (input.form && typeof input.form.addEventListener === "function") {
    return input.form;
  }
  if (typeof input.closest === "function") {
    const found = input.closest("form") as PasswordToggleForm | null;
    if (found && typeof found.addEventListener === "function") {
      return found;
    }
  }
  return null;
}

function resolveTargetWindow(
  input: PasswordToggleInput,
  targetWindow?: PasswordToggleWindow | null,
): PasswordToggleWindow | null {
  if (targetWindow !== undefined) {
    return targetWindow && typeof targetWindow.addEventListener === "function"
      ? targetWindow
      : null;
  }
  const ownerView = input.ownerDocument?.defaultView;
  if (ownerView && typeof ownerView.addEventListener === "function") {
    return ownerView;
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    return window;
  }
  return null;
}

/**
 * Wires an inline Show/Hide visibility toggle to a password input.
 * Always defaults to masked ("password"), disables browser text assistance on the field,
 * and resets synchronously to masked on form submit, form reset, pagehide, persisted pageshow,
 * or explicit reset(). Never reads, logs, copies, or stores the password value, and never
 * alters autocomplete.
 */
export function wirePasswordToggle(
  input: PasswordToggleInput | null,
  button: PasswordToggleButton | null,
  targetWindow?: PasswordToggleWindow | null,
): PasswordToggleHandle {
  if (!input || !button) {
    return { reset() {} };
  }

  pinTextAssistanceOptOuts(input);
  button.setAttribute("type", "button");

  const setVisible = (visible: boolean): void => {
    pinTextAssistanceOptOuts(input);
    input.type = visible ? "text" : "password";
    button.setAttribute("aria-pressed", visible ? "true" : "false");
    button.textContent = visible ? HIDE_LABEL : SHOW_LABEL;
    button.setAttribute("aria-label", visible ? HIDE_ARIA_LABEL : SHOW_ARIA_LABEL);
  };

  const reset = (): void => {
    setVisible(false);
  };

  reset();

  button.addEventListener("click", () => {
    if (input.disabled || button.disabled) {
      reset();
      return;
    }
    setVisible(input.type === "password");
  });

  const form = resolveEnclosingForm(input);
  if (form) {
    form.addEventListener("submit", reset);
    form.addEventListener("reset", reset);
  }

  const win = resolveTargetWindow(input, targetWindow);
  if (win) {
    win.addEventListener("pagehide", () => {
      reset();
    });
    win.addEventListener("pageshow", (event: unknown) => {
      if (
        typeof event === "object" &&
        event !== null &&
        "persisted" in event &&
        (event as PageTransitionEvent).persisted === true
      ) {
        reset();
      }
    });
  }

  return { reset };
}
