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
// - one ticked: that workspace is Home, and the form says so;
// - two or more: the person chooses. A Home this script filled in for a single workspace is cleared first,
//   and so is the Home of a row that is unticked, so the choice is never made for them;
// - none: no Home.
// A locked selection (disabled controls, carried by hidden fields) is left as rendered.
let filledIn = null;
const syncHome = () => {
  const rows = [...document.querySelectorAll(".workspace-choice")].map((row) => ({
    pick: row.querySelector('input[type="checkbox"][name="workspace_ids"]'),
    home: row.querySelector('input[type="radio"][name="home_workspace_id"]'),
  })).filter((row) => row.pick && row.home);
  const ticked = rows.filter((row) => row.pick.checked);
  const choose = ticked.length >= 2;
  document.documentElement.dataset.homeAuto = choose ? "choose" : "one";
  for (const row of rows) {
    if (row.home.disabled) continue;
    if (!row.pick.checked || (choose && row.home === filledIn)) row.home.checked = false;
  }
  if (choose || ticked.length === 0) filledIn = null;
  if (ticked.length === 1 && !ticked[0].home.disabled && !ticked[0].home.checked) {
    ticked[0].home.checked = true;
    filledIn = ticked[0].home;
  }
  const needed = document.querySelector(".home-needed");
  if (needed) needed.textContent = choose && !rows.some((row) => row.home.checked) ? needed.dataset.text : "";
};
if (document.querySelector(".workspace-list")) {
  document.addEventListener("change", (event) => {
    if (event.target?.name === "workspace_ids" || event.target?.name === "home_workspace_id") syncHome();
  });
  // A reload or a return to this page can restore ticks after this script first ran.
  window.addEventListener("pageshow", syncHome);
  syncHome();
}
