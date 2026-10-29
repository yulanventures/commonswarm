import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/** Real production read and view owners in an isolated, fake-data DOM. */
export async function readRecoveryFixture(): Promise<string> {
  const siteRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const result = await build({ absWorkingDir: siteRoot, bundle: true, write: false, format: "iife", globalName: "Recovery", platform: "browser",
    stdin: { contents: 'export * from "./src/lib/workspace-file-reads.ts"; export { createBrainView } from "./src/lib/brain-view.ts";', resolveDir: siteRoot, loader: "ts" } });
  const script = result.outputFiles[0]!.text;
  return `<!doctype html><html><body>
  <main><h1 id="files-title" tabindex="-1">Files</h1><p id="error">Could not load files.</p><button id="retry">Retry</button><p id="status" role="status" hidden></p><p id="files"></p><textarea id="draft">keep this draft</textarea></main>
  <section id="wiki"><button id="back" hidden>Back</button><p id="selectionPrompt"></p><ul id="list"></ul><p id="empty"></p><article id="detail" hidden><h2 id="title" tabindex="-1"></h2><p id="meta"></p><div id="bodyMode" hidden><div id="markdown"></div><pre id="raw" hidden></pre><button id="rawToggle">Raw</button></div><p id="wikiError"></p><button id="wikiRetry" hidden>Retry</button><button id="edit">Edit</button><form id="form" hidden><textarea id="textarea"></textarea><button id="save">Save</button><button id="cancel" type="button">Cancel</button></form><p id="wikiStatus"></p><details id="history"><summary>History</summary><ul id="historyList"></ul></details></article></section>
  <script>${script.replace(/<\/script/giu, '<\\/script')}</script><script>
  (async () => {
    const $ = id => document.getElementById(id), check = (name, ok) => { if (!ok) throw new Error(name); };
    const session = {}; let context = { workspaceId:'one', session, generation:1 }, failed = true, resolveRead, calls = 0;
    const retry = Recovery.createFileListRetry(() => context, () => { calls++; return new Promise(resolve => { resolveRead = resolve; }); });
    const binding = Recovery.bindFileListRetry({ button:$('retry'), status:$('status'), successFocus:$('files-title'), retry,
      hasError:() => failed, apply:r => { failed = r.kind !== 'success'; $('files').textContent = r.kind === 'success' ? r.value.join(', ') : ''; },
      render:() => { $('error').hidden = !failed; binding.sync(); }, isVisible:() => true });
    $('retry').focus(); $('retry').click(); $('retry').click();
    check('busy', $('retry').disabled && !$('status').hidden && calls === 1);
    resolveRead(['brief.pdf']); await new Promise(resolve => setTimeout(resolve, 0));
    check('recovered', $('retry').hidden && $('files').textContent === 'brief.pdf' && $('draft').value === 'keep this draft' && document.activeElement === $('files-title'));
    failed = true; binding.sync(); $('retry').click(); context = { workspaceId:'two', session, generation:2 }; resolveRead(['old private']); await new Promise(resolve => setTimeout(resolve,0));
    check('stale', $('files').textContent === 'brief.pdf' && $('draft').value === 'keep this draft' && !$('retry').disabled && $('status').hidden);
    $('retry').click(); const resolveOld = resolveRead;
    context = { workspaceId:'three', session, generation:3 }; binding.sync(); $('retry').click(); const resolveNew = resolveRead;
    resolveOld(['old']); await new Promise(resolve => setTimeout(resolve,0));
    check('newer still busy', $('retry').disabled && !$('status').hidden && $('files').textContent === 'brief.pdf');
    resolveNew(['current.pdf']); await new Promise(resolve => setTimeout(resolve,0));
    check('newer recovered', $('retry').hidden && $('status').hidden && $('files').textContent === 'current.pdf');
    const ids=['back','selectionPrompt','list','empty','detail','title','meta','bodyMode','markdown','raw','rawToggle','edit','form','textarea','save','cancel','history','historyList'];
    const targets=Object.fromEntries(ids.map(id => [id,$(id)])); Object.assign(targets,{view:$('wiki'),error:$('wikiError'),retry:$('wikiRetry'),status:$('wikiStatus')});
    let grantCount=0, versions=[]; const oldFetch=window.fetch;
    window.fetch=async () => ({ok:true,text:async () => '# Recovered version one'});
    const view=Recovery.createBrainView(targets,{read:(topic,version)=>{versions.push(version); return Recovery.readWikiContent(() => ++grantCount === 1 ? new Promise(()=>{}) : Promise.resolve({url:'https://example.invalid/file'}),()=>true);}, save:async topic=>topic});
    view.setTopics([{topic:'architecture',fileId:'f',name:'brain/architecture.md',currentVersion:2,sizeBytes:1,uploadedByKind:'user',uploadedBy:'u',committedAt:'2026-01-01T00:00:00Z',tombstonedAt:null,updaterName:'Maya'}]);
    await view.open('architecture',1);
    check('timeout retry', !$('wikiRetry').hidden && $('wikiError').textContent.includes('took too long'));
    $('wikiRetry').click(); await new Promise(resolve => setTimeout(resolve,0));
    check('exact version', $('wikiRetry').hidden && $('markdown').textContent.includes('Recovered version one') && versions.join(',') === '1,1');
    window.fetch=oldFetch; document.documentElement.dataset.result='pass';
  })().catch(error => { document.documentElement.dataset.failure=String(error); });
  </script></body></html>`;
}
