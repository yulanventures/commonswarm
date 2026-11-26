export interface PasswordToggleInput {
  type: string;
  disabled?: boolean;
  form?: PasswordToggleForm | null;
  closest?: (selector: string) => unknown;
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

/**
 * Wires an inline Show/Hide visibility toggle to a password input.
 * Always defaults to masked ("password") and resets to masked on form submit,
 * form reset, or explicit reset(). Never reads, logs, copies, or stores the password value.
 */
export function wirePasswordToggle(
  input: PasswordToggleInput | null,
  button: PasswordToggleButton | null,
): PasswordToggleHandle {
  if (!input || !button) {
    return { reset() {} };
  }

  button.setAttribute("type", "button");

  const sync = (visible: boolean): void => {
    input.type = visible ? "text" : "password";
    button.setAttribute("aria-pressed", visible ? "true" : "false");
    button.textContent = visible ? HIDE_LABEL : SHOW_LABEL;
    button.setAttribute("aria-label", visible ? HIDE_ARIA_LABEL : SHOW_ARIA_LABEL);
  };

  const reset = (): void => {
    sync(false);
  };

  reset();

  button.addEventListener("click", () => {
    if (input.disabled || button.disabled) {
      reset();
      return;
    }
    sync(input.type === "password");
  });

  const form = resolveEnclosingForm(input);
  if (form) {
    form.addEventListener("submit", reset);
    form.addEventListener("reset", reset);
  }

  return { reset };
}
