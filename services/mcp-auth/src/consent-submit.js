// Keep the native form POST and its fields; only submit controls are disabled.
let submitted = false;
let disabledButtons = [];
document.addEventListener("submit", (event) => {
  if (event.defaultPrevented) return;
  if (submitted) {
    event.preventDefault();
    return;
  }
  submitted = true;
  disabledButtons = [...document.querySelectorAll('button[type="submit"]')]
    .filter((button) => !button.disabled);
  for (const button of disabledButtons) button.disabled = true;
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  submitted = false;
  for (const button of disabledButtons) button.disabled = false;
  disabledButtons = [];
});
