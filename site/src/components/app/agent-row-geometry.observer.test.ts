import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { join } from "node:path";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

const dashboard = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const style = dashboard.match(/<style\b[^>]*>([\s\S]*?)<\/style>/)?.[1];
assert.ok(style, "LiveDashboard must expose its component stylesheet to the geometry fixture");
const siteRoot = fileURLToPath(new URL("../../../", import.meta.url));

type Geometry = { width: number; listWidth: number; detailWidth: number; rowOverflow: boolean; touchTargets: boolean;
  hostileElements: number; hostileText: boolean; accessMark: string | null; localAccessMark: string | null; hostedRowLabel: string | null; hostedDetailText: string; modelValues: (string | null)[];
  confirmRole: string | null; safeConfirmFocus: boolean; detailTouchTargets: boolean; closeIconSize: number; backIconSize: number; cancelRestoresOpener: boolean; outerStillOpen: boolean; technicalClosed: boolean };

// CI only: build the production DOM builder rather than recreating obsolete row markup.
test("A2 rows, details and confirms have usable geometry and preserve plain text", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-agent-geometry-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({ absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)), bundle: true,
    entryPoints: ["src/lib/people-dialog-view.ts"], format: "iife", globalName: "PeopleView", platform: "browser", write: false });
  const script = bundle.outputFiles[0]?.text; assert.ok(script);
  const tokens = await readFile(new URL("../../styles/tokens.css", import.meta.url), "utf8");
  // Real page styles, introduced only after the unchanged classic measurements below.
  const pageStyles = await build({ absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)), bundle: true,
    stdin: { contents: ['global.css', 'home/index.css', 'kylon-shell.css', 'kylon-layout/index.css', 'kylon-people.css', 'kylon-font.css']
      .map(file => `@import "./src/styles/${file}";`).join('\n'), loader: 'css', resolveDir: siteRoot },
    loader: { '.woff2': 'dataurl' }, write: false,
    plugins: [{ name: 'local-fonts', setup(builder) { builder.onResolve({ filter: /^\/fonts\// }, args =>
      ({ path: join(siteRoot, 'public', args.path.slice(1)) })); } }] });
  const pageCss = pageStyles.outputFiles[0]?.text; assert.ok(pageCss);
  try {
    await writeFile(fixture, `<!doctype html><html><head><style>
      * { box-sizing: border-box; } body { margin: 0; font-family: sans-serif; }
      .dashboard [hidden] { display: none !important; }
      ${tokens} ${style}
    </style></head><body><main class="dashboard"><dialog class="dashboard__roster-dialog" data-roster-dialog aria-labelledby="dashboard-roster-title">
      <header class="dashboard__roster-dialog-head"><h2 id="dashboard-roster-title">People &amp; agents</h2><button class="dashboard__icon-button" data-roster-close aria-label="Close People &amp; agents">×</button></header>
      <div class="dashboard__roster-dialog-body"><div class="dashboard__roster-dialog-list" id="roster"></div><section class="pd-detail" id="detail" hidden></section></div>
      <dialog class="pd-confirm" id="confirm"></dialog></dialog></main>
      <script>${script}</script><script>
      (async () => {
        const hostile = '<img src=x onerror="document.title=1">';
        const agent = { id: 'agent', name: 'Alexandria Montgomery-Sutherland '+hostile, ownerId: 'person', ownerName: 'Mei Langridge', model: hostile,
          app: 'Claude', hosted: true, own: true, mayManage: true, liveKey: true, key: 'Uses a key to connect.',
          status: { kind: 'paused', label: 'Connection paused', sentence: 'Resume it so it can connect again.', attention: true, fix: { action: 'resume', allowed: true } },
          receive: 'Checks messages when you chat with it.', lastActive: '15 days ago', technical: ['Agent ID: agent'], updateAvailable: false, access: { until: null }, accessReadState: 'succeeded', receipt: '' };
        const local = { ...agent, id: 'local', name: 'Local Agent', model: null, app: 'Codex', hosted: false, liveKey: false, key: null,
          status: { kind: 'active', label: 'Active', sentence: '', attention: false, fix: null }, updateAvailable: false };
        const model = { people: [{ id: 'person', name: 'Mei Langridge', role: 'member', own: true, mayRemove: false }], agents: [agent, local], invites: [], sample: false, pendingFailed: false };
        const state = { selected: null, collapsed: new Set(), showAllAttention: false, query: '' };
        const outer = document.querySelector('[data-roster-dialog]'), roster = document.querySelector('#roster'), detail = document.querySelector('#detail'), confirm = document.querySelector('#confirm');
        const modelValues = [];
        const callbacks = { render: () => PeopleView.renderPeopleDialog(roster, detail, model, state, callbacks), action: () => {}, saveModel: async (_id, value) => { modelValues.push(value); },
          confirm: (action, _id, opener) => PeopleView.showPeopleConfirmation(confirm, action, agent, opener, async () => {}, () => "The result is unknown. Reload to check.") };
        callbacks.render(); outer.showModal();
        const rows = [...roster.querySelectorAll('.pd-agent')];
        const rowOverflow = rows.some(row => row.scrollWidth > row.clientWidth);
        const visibleButtons = element => [...element.querySelectorAll('button')].filter(button => button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden');
        const touchTargets = visibleButtons(outer).length > 0 && visibleButtons(outer).every(button => button.getBoundingClientRect().height >= 44);
        const closeIconSize = parseFloat(getComputedStyle(outer.querySelector('[data-roster-close]')).fontSize);
        const listWidth = outer.getBoundingClientRect().width;
        roster.querySelector('#pd-agent-agent').click();
        const detailWidth = outer.getBoundingClientRect().width;
        const detailTouchTargets = visibleButtons(detail).length > 0 && visibleButtons(detail).every(button => button.getBoundingClientRect().height >= 44);
        const backIconSize = parseFloat(getComputedStyle(detail.querySelector('.pd-back-icon')).fontSize);
        // A hosted agent's row draws no access mark (it cannot use Lists & docs yet); a local agent's row does.
        const accessMark = roster.querySelector('[data-agent-row="agent"] [data-agent-content-access]')?.getAttribute('aria-label') ?? null;
        const localAccessMark = roster.querySelector('[data-agent-row="local"] [data-agent-content-access]')?.getAttribute('aria-label') ?? null;
        const hostedRowLabel = roster.querySelector('#pd-agent-agent')?.getAttribute('aria-label') ?? null;
        const hostedDetailText = detail.textContent ?? '';
        detail.querySelector('[data-edit-model]').click();
        const form = detail.querySelector('[data-model-editor]'), input = form.querySelector('input');
        input.value = '   '; form.requestSubmit(); await Promise.resolve(); await Promise.resolve();
        const opener = detail.querySelector('[data-remove-agent]'); opener.focus(); opener.click();
        const confirmRole = confirm.getAttribute('role'); const safeConfirmFocus = document.activeElement.textContent === 'Go back';
        confirm.dispatchEvent(new Event('cancel', { cancelable: true, bubbles: true }));
        const metrics = { width: innerWidth, listWidth, detailWidth, rowOverflow, touchTargets, detailTouchTargets, closeIconSize, backIconSize, hostileElements: document.querySelectorAll('img').length,
          hostileText: detail.querySelector('h2').textContent.includes(hostile), accessMark, localAccessMark, hostedRowLabel, hostedDetailText, modelValues, confirmRole, safeConfirmFocus,
          cancelRestoresOpener: document.activeElement === opener, outerStillOpen: outer.open, technicalClosed: !detail.querySelector('details').open };
        document.documentElement.dataset.metrics = btoa(unescape(encodeURIComponent(JSON.stringify(metrics))));
        // Separate controlled page, not Sample or a signed-in/backend journey. Never accept a command.
        outer.close(); outer.remove();
        const pageStyle = document.createElement('style'); pageStyle.textContent = ${JSON.stringify(pageCss)}; document.head.append(pageStyle);
        const app = document.createElement('live-dashboard'); app.className = 'dashboard'; app.dataset.kylonShell = '';
        const frame = document.createElement('div'); frame.className = 'hm-frame dashboard__frame hm-frame--people';
        const pageRoot = document.createElement('section'); pageRoot.className = 'hm-route-pane'; pageRoot.dataset.homeRoutePane = '';
        const pageDetail = document.createElement('section'); pageDetail.className = 'pd-detail'; pageDetail.dataset.peopleDetail = ''; pageDetail.hidden = true;
        const pageConfirm = document.createElement('dialog'); pageConfirm.className = 'pd-confirm'; pageConfirm.dataset.peopleConfirm = '';
        frame.append(pageRoot); app.append(frame, pageDetail, pageConfirm); document.querySelector('main.dashboard').replaceWith(app);
        const pageRows = [], commits = [], pageState = {selected:null,collapsed:new Set(),showAllAttention:false,query:''};
        const pageCallbacks = { render: () => PeopleView.renderPeopleDialog(pageRoot,pageDetail,model,pageState,pageCallbacks,{layout:'page',page:{homeLabel:'Controlled local geometry',homeHref:'#'}}),
          action: () => { throw Error('No local action permitted'); }, saveModel: async () => { throw Error('No local model save permitted'); },
          confirm: (action,id,opener) => PeopleView.showPeopleConfirmation(pageConfirm,action,model.agents.find(item => item.id === id),opener,
            async () => { commits.push(action); throw Error('No command sent'); },() => 'Controlled local boundary; no command sent.') };
        const number = value => Number.parseFloat(value) || 0;
        const modalPaint = button => {
          const rect = button.getBoundingClientRect(), css = getComputedStyle(button);
          const opaque = color => color !== 'transparent' && !/^rgba\\([^)]*,\\s*0(?:\\.0+)?\\)$/.test(color);
          const outline = !['none','hidden'].includes(css.outlineStyle) && number(css.outlineWidth)>0 && opaque(css.outlineColor);
          const edge = outline ? Math.max(0,number(css.outlineWidth)+number(css.outlineOffset)) : 0;
          const outset = {left:edge,right:edge,top:edge,bottom:edge}; let shadow = false;
          for (const part of css.boxShadow.split(/,(?![^()]*\\))/)) {
            if (part === 'none' || part.includes('inset')) continue;
            const color = part.match(/rgba?\\([^)]*\\)/)?.[0];
            const values = part.replace(/(?:rgba?|color|oklch|hsl)a?\\([^)]*\\)/g,'').match(/-?\\d+(?:\\.\\d+)?px/g)?.map(number);
            if (!values || values.length<2 || (color && !opaque(color))) continue;
            const [x,y,blur=0,spread=0] = values, extent = Math.max(0,blur+spread); shadow ||= extent>0 || x!==0 || y!==0;
            outset.left=Math.max(outset.left,extent-x); outset.right=Math.max(outset.right,extent+x);
            outset.top=Math.max(outset.top,extent-y); outset.bottom=Math.max(outset.bottom,extent+y);
          }
          const ring = {left:rect.left-outset.left,right:rect.right+outset.right,top:rect.top-outset.top,bottom:rect.bottom+outset.bottom};
          const clips = []; let modalBoundary = false;
          for (let node=button.parentElement;node;node=node.parentElement) {
            const style=getComputedStyle(node), box=node.getBoundingClientRect();
            const bounds={left:box.left+node.clientLeft,right:box.left+node.clientLeft+node.clientWidth,top:box.top+node.clientTop,bottom:box.top+node.clientTop+node.clientHeight};
            const clipX=style.display!=='contents' && /auto|scroll|hidden|clip/.test(style.overflowX), clipY=style.display!=='contents' && /auto|scroll|hidden|clip/.test(style.overflowY);
            if ((clipX && (ring.left<bounds.left-.5 || ring.right>bounds.right+.5)) || (clipY && (ring.top<bounds.top-.5 || ring.bottom>bounds.bottom+.5))) clips.push({tag:node.tagName,classes:node.className,bounds,clipX,clipY});
            // Native modal top-layer boxes escape clipping by their DOM ancestors, but not their own scrollport.
            if (node.matches('dialog:modal')) { modalBoundary=true; break; }
          }
          return {active:document.activeElement===button,focusVisible:button.matches(':focus-visible'),indicator:outline||shadow,
            shown:button.getClientRects().length>0 && css.visibility==='visible' && number(css.opacity)>0,
            insideViewport:ring.left>=-.5 && ring.right<=innerWidth+.5 && ring.top>=-.5 && ring.bottom<=innerHeight+.5,
            modalBoundary,clips,ring,outline:css.outline,outlineOffset:css.outlineOffset,boxShadow:css.boxShadow};
        };
        const naturalAction = button => {
          const css=getComputedStyle(button), range=document.createRange(); range.selectNodeContents(button);
          const lines=[]; for (const rect of range.getClientRects()) if (rect.width>0 && rect.height>0 && !lines.some(top => Math.abs(top-rect.top)<.5)) lines.push(rect.top);
          const lineHeight=number(css.lineHeight), padding=number(css.paddingTop)+number(css.paddingBottom), border=number(css.borderTopWidth)+number(css.borderBottomWidth);
          const rect=button.getBoundingClientRect();
          return {text:button.textContent,lines:lines.length,lineHeight,padding,border,budget:Math.max(44,lines.length*lineHeight+padding+border),width:rect.width,height:rect.height};
        };
        for (const dark of [false]) {
          document.documentElement.dataset.theme=dark?'dark':'light';
          for (const id of ['local','agent']) {
            pageState.selected={type:'agent',id}; pageCallbacks.render();
            const opener=pageDetail.querySelector('[data-remove-agent]'); opener.focus(); opener.click();
            pageConfirm.getBoundingClientRect();
            const deadline=performance.now()+2000;
            while (!pageConfirm.open || !pageConfirm.matches(':modal') || document.activeElement!==pageConfirm.querySelector('.pd-confirm-actions button') || document.fonts.status!=='loaded' || !document.fonts.check(getComputedStyle(pageConfirm.querySelector('.pd-confirm-actions button')).font)) {
              if (performance.now()>=deadline) throw Error('Page confirmation readiness: '+JSON.stringify({width:innerWidth,height:innerHeight,phone:matchMedia('(max-width:52rem)').matches,open:pageConfirm.open,modal:pageConfirm.matches(':modal'),active:document.activeElement?.outerHTML,fonts:document.fonts.status,font:pageConfirm.querySelector('button')?getComputedStyle(pageConfirm.querySelector('button')).font:null}));
              await new Promise(resolve=>setTimeout(resolve,20));
            }
            const buttons=[...pageConfirm.querySelectorAll('.pd-confirm-actions button')], cancel=buttons[0];
            const row={dark,id,width:innerWidth,modal:pageConfirm.matches(':modal'),outsideClassic:!pageConfirm.closest('[data-roster-dialog]'),
              pageScope:pageConfirm.hasAttribute('data-people-page-confirm'),title:pageConfirm.querySelector('h2').textContent,
              actions:buttons.map(naturalAction),initial:modalPaint(cancel),cancelled:false,returned:false};
            pageRows.push(row); document.documentElement.dataset.pageModalPartial=btoa(unescape(encodeURIComponent(JSON.stringify(pageRows))));
            pageConfirm.addEventListener('cancel',event=>{row.cancelled=event.defaultPrevented;},{once:true}); pageConfirm.requestClose();
            row.returned=!pageConfirm.open && document.activeElement===opener;
            document.documentElement.dataset.pageModalPartial=btoa(unescape(encodeURIComponent(JSON.stringify(pageRows))));
          }
        }
        document.documentElement.dataset.pageModal=btoa(unescape(encodeURIComponent(JSON.stringify({rows:pageRows,commits}))));
      })().catch(error => { document.documentElement.dataset.pageModalError=String(error.stack || error); });
      </script></body></html>`, "utf8");
    const chrome = await findChrome();
    for (const width of [390]) {
      const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},900`, "--virtual-time-budget=5000", "--dump-dom", `file://${fixture}`],
        { maxBuffer: 10 * 1024 * 1024, timeout: 15_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(encoded, "the production builder must finish its DOM interactions");
      const geometry = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Geometry;

      assert.equal(geometry.hostileElements, 0); assert.equal(geometry.hostileText, true);

      assert.deepEqual(geometry.modelValues, [null]);
      assert.equal(geometry.confirmRole, "alertdialog"); assert.equal(geometry.safeConfirmFocus, true);
      assert.equal(geometry.cancelRestoresOpener, true); assert.equal(geometry.outerStillOpen, true); assert.equal(geometry.technicalClosed, true);

      const pageEncoded = stdout.match(/data-page-modal="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(pageEncoded, `page confirmation must finish at ${width}px: ${stdout.match(/data-page-modal-error="([^"]*)"/)?.[1] ?? 'no error'}; partial=${stdout.match(/data-page-modal-partial="([^"]*)"/)?.[1] ?? 'none'}`);
      const page = JSON.parse(Buffer.from(pageEncoded, 'base64').toString('utf8'));
      assert.deepEqual(page.commits, [], 'controlled geometry never accepts or sends a command');

      for (const row of page.rows) {
        const facts = `${width}px page modal: ${JSON.stringify(row)}`;

        assert.equal(row.title, `Remove ${row.id === 'agent' ? 'Alexandria Montgomery-Sutherland <img src=x onerror="document.title=1">' : 'Local Agent'}?`, facts);
        assert.ok(row.cancelled && row.returned, `native close request must cancel and return to the actual opener: ${facts}`);



      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
