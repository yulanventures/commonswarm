import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

// Registered in the existing home-* gate; Chrome runs only in CI. No service or network.
test("New workspace and role controls wrap, support native forms, and keep confirmation focus safe", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-home-onboarding-role-"));
  const fixture = join(directory, "index.html");
  try {
    const bundles = await Promise.all(["home-new-workspace", "people-dialog-view"].map(async (module) => {
      const result = await build({ absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)), bundle: true,
        entryPoints: [`src/lib/${module}.ts`], format: "iife", globalName: module === "home-new-workspace" ? "NewWorkspace" : "People",
        platform: "browser", write: false });
      assert.ok(result.outputFiles[0]); return result.outputFiles[0].text;
    }));
    const dashboard = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
    const style = dashboard.match(/<style\b[^>]*>([\s\S]*?)<\/style>/)?.[1]; assert.ok(style);
    const styles = await Promise.all(["tokens.css", "home/onboarding.css", "home/people.css"].map(file => readFile(new URL(`../../styles/${file}`, import.meta.url), "utf8")));
    for (const dark of [false, true]) {
      await writeFile(fixture, `<!doctype html><html${dark ? ' data-theme="dark"' : ''}><head><style>
        * { box-sizing: border-box; } body { margin: 0; } [hidden] { display: none !important; }
        ${styles.join("\n")} ${style}
      </style></head><body><main class="dashboard"><div id="form"></div>
        <dialog class="dashboard__roster-dialog" data-roster-dialog><div class="dashboard__roster-dialog-body">
          <div class="dashboard__roster-dialog-list" id="roster"></div><section class="pd-detail" id="detail" hidden></section>
        </div></dialog></main><script>${bundles.join("\n")}</script><script>
        (async () => {
          const hostile = '<img src=x onerror="document.title=1">';
          const formRoot = document.querySelector('#form');
          const vm = { viewerName: 'Tom ' + hostile, viewerInitials: 'TS', name: '', purpose: null,
            purposes: [{value:'shared',label:'People I invite',detail:'People share this workspace.'},
              {value:'personal',label:'Just me',detail:'No invitations.'}] };
          const changes = [], creations = [];
          const mount = () => formRoot.replaceChildren(NewWorkspace.buildNewWorkspaceForm(document, vm, {
            onNameInput: name => { vm.name = name; changes.push(name); },
            onPurposeSelect: purpose => { vm.purpose = purpose; mount(); },
            onCreate: () => creations.push({name:vm.name,purpose:vm.purpose})
          }));
          mount();
          const initialDisabled = formRoot.querySelector('[data-create-button]').disabled;
          const noDefault = !formRoot.querySelector('input[type=radio]:checked');
          const initialWarningEmpty = formRoot.querySelector('[data-create-personal-warning]').textContent === '';
          vm.purpose = 'personal'; mount();
          const personalWarning = formRoot.querySelector('[data-create-personal-warning]');
          const permanentWarning = personalWarning.textContent === 'Just me cannot be changed later, and nobody can be invited to this workspace. To share with people later, create another workspace.' && personalWarning.getAttribute('aria-live') === 'polite';
          vm.purpose = 'shared'; mount();
          const sharedWarningEmpty = formRoot.querySelector('[data-create-personal-warning]').textContent === '';
          vm.purpose = null; mount();
          const field = formRoot.querySelector('input[type=text]'); field.focus();
          const nameFocus = document.activeElement === field;
          field.value = hostile; field.dispatchEvent(new Event('input', {bubbles:true}));
          const radio = formRoot.querySelector('input[value=shared]'); radio.focus();
          const radioFocus = document.activeElement === radio && radio.type === 'radio';
          radio.checked = true; radio.dispatchEvent(new Event('change', {bubbles:true}));
          const enabled = !formRoot.querySelector('[data-create-button]').disabled;
          const checkedMark = getComputedStyle(formRoot.querySelector('input:checked').parentElement.querySelector('.hm-new-workspace__purpose-check')).visibility === 'visible';
          const touch = nodes => nodes.length > 0 && nodes.every(node => {
            const box = node.getBoundingClientRect(); return box.height >= 44 && box.width >= 44;
          });
          const formTargets = touch([...formRoot.querySelectorAll('input[type=text], .hm-new-workspace__purpose-card, button')]);
          const previewPlain = formRoot.querySelector('.hm-new-workspace__preview-title').textContent === "Who'll be in " + hostile && !formRoot.querySelector('img');
          const formOverflow = formRoot.scrollWidth > innerWidth + 1;
          // Native submit is the same form path used by Enter and the submit button.
          formRoot.querySelector('form').requestSubmit(formRoot.querySelector('[data-create-button]'));
          const owner = {id:'tom',name:'Tom',role:'owner',own:true,mayRemove:false};
          const model = { people:[owner, {id:'nikki',name:'Nikki',role:'member',own:false,mayRemove:true},
            {id:'sam',name:'Sam',role:'member',own:false,mayRemove:true}], agents:[], invites:[], sample:false,pendingFailed:false,workspaceName:'Home' };
          const state = {selected:null,collapsed:new Set(),showAllAttention:false,query:''};
          const outer = document.querySelector('[data-roster-dialog]'), roster = document.querySelector('#roster'), detail = document.querySelector('#detail');
          let resolveSave, rejectSave;
          const saves = [];
          const callbacks = { render:() => People.renderPeopleDialog(roster, detail, model, state, callbacks), action:async()=>{}, confirm:()=>{},
            changeRole: change => { saves.push(change); return new Promise((resolve,reject) => {resolveSave=resolve;rejectSave=reject;}); } };
          People.renderPeopleDialog(roster, detail, model, state, callbacks, {focus:{kind:'person',id:'tom'}}); outer.showModal();
          const select = detail.querySelector('[data-role-select]'); select.focus();
          const roleFocus = document.activeElement === select && select.tagName === 'SELECT';
          select.value = 'member'; select.dispatchEvent(new Event('change'));
          const roleTargets = touch([select, detail.querySelector('[data-change-role]')]);
          detail.querySelector('[data-change-role]').click();
          const confirm = detail.querySelector('[data-role-confirm]');
          const alertdialog = confirm.open && confirm.getAttribute('role') === 'alertdialog';
          const safeFocus = document.activeElement === confirm.querySelector('[data-role-confirm-back]');
          const confirmTargets = touch([...confirm.querySelectorAll('button')]);
          // Exercise the native close-request algorithm used by Escape, including its cancel event.
          let cancelled = false;
          confirm.addEventListener('cancel', event => { cancelled = event.defaultPrevented; });
          confirm.requestClose();
          const escapeReturns = !detail.querySelector('[data-role-confirm]') && outer.open && document.activeElement === detail.querySelector('[data-role-select]') && saves.length === 0;
          const chooseRole = (id,role) => { state.selected={type:'person',id}; callbacks.render(); const el=detail.querySelector('[data-role-select]'); el.value=role; el.dispatchEvent(new Event('change')); };
          chooseRole('nikki','admin'); detail.querySelector('[data-change-role]').click();
          chooseRole('sam','admin'); resolveSave(); await Promise.resolve(); await Promise.resolve();
          const preservedOnSuccess = state.roleDraft.userId === 'sam' && state.roleDraft.role === 'admin';
          chooseRole('nikki','admin'); detail.querySelector('[data-change-role]').click();
          chooseRole('sam','owner'); rejectSave({code:'last_owner'}); await Promise.resolve(); await Promise.resolve();
          const preservedOnRefusal = state.roleDraft.userId === 'sam' && state.roleDraft.role === 'owner';
          const unseenError = roster.querySelector('[data-role-error="nikki"]');
          const unseenRefusal = unseenError.textContent === 'Nikki: Home needs at least one owner. Make someone else an owner first.' && unseenError.getAttribute('role') === 'alert' && !roster.querySelector('[data-role-receipt]');
          chooseRole('nikki','admin'); detail.querySelector('[data-change-role]').click(); rejectSave({code:'member_not_found',message:'last_owner'});
          await Promise.resolve(); await Promise.resolve();
          const codedRefusal = detail.querySelector('[data-role-error]').textContent;
          detail.querySelector('.pd-back').click();
          const listError = roster.querySelector('[data-role-error="nikki"]');
          const backKeepsAlert = listError?.getAttribute('role') === 'alert' && !roster.querySelector('[data-role-receipt]');
          state.selected = {type:'person',id:'nikki'}; callbacks.render();
          const reopenedError = detail.querySelector('[data-role-error="nikki"]');
          const reopenKeepsAlert = reopenedError.textContent === 'Nikki is no longer a member. Reload to check.' && reopenedError.getAttribute('role') === 'alert' && !reopenedError.hidden && !detail.querySelector('[data-role-receipt]');
          document.documentElement.dataset.metrics = btoa(unescape(encodeURIComponent(JSON.stringify({width:innerWidth,initialDisabled,noDefault,initialWarningEmpty,permanentWarning,sharedWarningEmpty,nameFocus,radioFocus,enabled,checkedMark,formTargets,previewPlain,formOverflow,creations,changes,roleFocus,roleTargets,alertdialog,safeFocus,confirmTargets,cancelled,escapeReturns,preservedOnSuccess,preservedOnRefusal,unseenRefusal,codedRefusal,backKeepsAlert,reopenKeepsAlert}))));
        })().catch(error => { document.documentElement.dataset.fixtureError = String(error); });
        </script></body></html>`);
      const chrome = await findChrome();
      for (const width of [320, 390, 900, 1440]) {
        const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},900`, "--dump-dom", `file://${fixture}`],
          { maxBuffer: 10 * 1024 * 1024, timeout: 15_000, killSignal: "SIGKILL" });
        const encoded = stdout.match(/<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
        assert.ok(encoded, `builder interactions must complete at ${width}px, dark=${dark}: ${stdout.match(/data-fixture-error="([^"]*)"/)?.[1] ?? "no result"}`);
        const measured = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        assert.equal(measured.width, width); assert.equal(measured.formOverflow, false);
        for (const key of ["initialDisabled", "noDefault", "initialWarningEmpty", "permanentWarning", "sharedWarningEmpty", "nameFocus", "radioFocus", "enabled", "checkedMark", "formTargets", "previewPlain", "roleFocus", "roleTargets", "alertdialog", "safeFocus", "confirmTargets", "cancelled", "escapeReturns", "preservedOnSuccess", "preservedOnRefusal", "unseenRefusal", "backKeepsAlert", "reopenKeepsAlert"]) assert.equal(measured[key], true, `${key} at ${width}px, dark=${dark}`);
        const hostile = '<img src=x onerror="document.title=1">';
        assert.deepEqual(measured.changes, [hostile]); assert.deepEqual(measured.creations, [{name:hostile,purpose:"shared"}]);
        assert.equal(measured.codedRefusal, "Nikki is no longer a member. Reload to check.");
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
