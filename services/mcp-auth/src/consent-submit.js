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

// The workspace picker asks which workspace is Home only when two or more are ticked; the page hides the
// choice otherwise. What is sent always matches what is shown:
// - none ticked: no Home;
// - one ticked: that workspace is Home, and the form says so;
// - two or more: only a Home the person picked on this page, in this visit. Any other checked Home is
//   cleared and the page asks: one this script filled in for a single workspace, one the server rendered,
//   or one the browser restored after a reload or a return to the page.
// A pick is recorded from a click (pointer or keyboard), which restoring a form never produces.
// A locked selection (disabled controls, carried by hidden fields) is left as rendered.
let picked = null;
const syncHome = () => {
  const rows = [...document.querySelectorAll(".workspace-choice")].map((row) => ({
    pick: row.querySelector('input[type="checkbox"][name="workspace_ids"]'),
    home: row.querySelector('input[type="radio"][name="home_workspace_id"]'),
  })).filter((row) => row.pick && row.home);
  const ticked = rows.filter((row) => row.pick.checked);
  const choose = ticked.length >= 2;
  document.documentElement.dataset.homeAuto = choose ? "choose" : "one";
  if (!ticked.some((row) => row.home === picked)) picked = null;
  for (const row of rows) {
    if (row.home.disabled) continue;
    row.home.checked = row.pick.checked && (choose ? row.home === picked : true);
  }
  const needed = document.querySelector(".home-needed");
  if (needed) needed.textContent = choose && !rows.some((row) => row.home.checked) ? needed.dataset.text : "";
};
if (document.querySelector(".workspace-list")) {
  document.addEventListener("click", (event) => {
    const home = event.target;
    if (home?.name !== "home_workspace_id" || home.type !== "radio" || home.disabled || !home.checked) return;
    picked = home;
    syncHome();
  });
  document.addEventListener("change", (event) => {
    if (event.target?.name === "workspace_ids") syncHome();
  });
  // A reload or a return to this page can restore ticks after this script first ran.
  window.addEventListener("pageshow", syncHome);
  syncHome();
}
