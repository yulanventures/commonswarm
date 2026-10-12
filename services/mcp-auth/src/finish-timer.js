// P8 serves this external same-origin script at /interaction/finish-timer.js.
// Inputs: finish-page.js DOM, fixed finish path and immutable epoch-ms deadline.
// Outputs: polite status updates and a same-tab replace after three seconds.
// No code/callback/query/storage; one navigation state; pause never extends expiry.
(() => {
  const page = document.getElementById("finish-page");
  if (!page) return;
  const link = document.getElementById("finish-continue");
  const pause = document.getElementById("finish-pause");
  const title = document.getElementById("finish-title");
  const status = document.getElementById("finish-status");
  const returnStatus = document.getElementById("finish-return-status");
  const path = page.dataset.finishPath;
  const deadline = Number(page.dataset.deadline);
  const valid = /^\/interaction\/[A-Za-z0-9_-]+\/finish$/u.test(path) &&
    link.getAttribute("href") === path && Number.isSafeInteger(deadline) && deadline > 0;
  let state = "waiting", returnTimer, expiryTimer;
  const cancelReturn = () => clearTimeout(returnTimer);
  function expire() {
    const needsFocus = document.activeElement === link || document.activeElement === pause;
    state = "expired";
    cancelReturn();
    clearTimeout(expiryTimer);
    title.textContent = "Return link expired";
    document.title = "Return link expired";
    status.textContent = page.dataset.expiryText;
    returnStatus.hidden = true;
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
    link.setAttribute("tabindex", "-1");
    pause.disabled = true;
    if (needsFocus) page.focus();
  }
  function recheck() {
    if (!valid || Date.now() >= deadline || state === "expired") { expire(); return false; }
    return true;
  }
  function armExpiry() {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => { if (recheck()) armExpiry(); }, Math.min(deadline - Date.now(), 2147483647));
  }
  link.addEventListener("click", (event) => {
    cancelReturn(); // Before native navigation, including keyboard activation.
    if (!recheck() || state === "navigating" || state === "left") { event.preventDefault(); return; }
    if (event.defaultPrevented) { state = "paused"; return; }
    state = "navigating";
    clearTimeout(expiryTimer);
  });
  pause.addEventListener("click", () => {
    cancelReturn();
    if (!recheck() || state !== "waiting") return;
    state = "paused";
    pause.disabled = true;
    returnStatus.textContent = "Automatic return paused. Continue when you are ready.";
    link.focus();
  });
  window.addEventListener("pagehide", () => {
    cancelReturn(); clearTimeout(expiryTimer);
    if (state !== "expired") state = "left";
  });
  window.addEventListener("pageshow", () => {
    if (!recheck()) return;
    if (state === "left") {
      state = "paused";
      pause.disabled = true;
      returnStatus.textContent = "Automatic return paused. Continue when you are ready.";
    }
    armExpiry();
  });
  window.addEventListener("focus", recheck);
  if (!recheck()) return;
  pause.disabled = false;
  armExpiry();
  returnTimer = setTimeout(() => {
    if (!recheck() || state !== "waiting") return;
    state = "navigating";
    clearTimeout(expiryTimer);
    window.location.replace(path);
  }, 3000);
})();
