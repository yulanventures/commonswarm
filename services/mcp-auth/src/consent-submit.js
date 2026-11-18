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
// choice otherwise. A hidden choice must not be sent: clear Home when fewer than two are ticked, and clear a
// row's Home when that row is unticked. With one ticked and no Home sent, the server takes that one as Home.
const syncHome = () => {
  const rows = [...document.querySelectorAll(".workspace-choice")].map((row) => ({
    pick: row.querySelector('input[type="checkbox"][name="workspace_ids"]'),
    home: row.querySelector('input[type="radio"][name="home_workspace_id"]'),
  }));
  const ticked = rows.filter((row) => row.pick?.checked).length;
  document.documentElement.dataset.homeAuto = ticked >= 2 ? "choose" : "one";
  for (const row of rows) {
    if (row.home && !row.home.disabled && (ticked < 2 || !row.pick?.checked)) row.home.checked = false;
  }
};
if (document.querySelector(".workspace-list")) {
  document.addEventListener("change", (event) => {
    if (event.target?.name === "workspace_ids") syncHome();
  });
  syncHome();
}
