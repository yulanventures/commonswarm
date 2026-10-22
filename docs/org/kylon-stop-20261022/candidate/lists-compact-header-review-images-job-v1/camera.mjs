/* SOURCE ONLY / UNRUN. Four normal LIGHT native Lists selected-list/document images. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {nativeOwner} from './native-owner.mjs';

const require = createRequire(import.meta.url);
const base = '/tmp/qa', deps = base + '/deps';
const tools = base + '/tools', records = base + '/records', proofs = base + '/proofs';
const heads = {'lists':'9ed6cda1796a7124df805e392ee8386412d2c9c2'};
let lane, app, head, prepared, cfg;
const baseline='3a45f7f67ff8fb50a17de4a2ce2d7cafd20e20fb', expectedTree='9fc23475f2384098df486c58484af9634ea69e5c', baselineTree='601c359061d8d3f9de9882e6391c9dbde965346c';
const candidateCSS='site/src/styles/kylon-lists.css';
function frozen(){assert.deepEqual(heads,{'lists':'9ed6cda1796a7124df805e392ee8386412d2c9c2'},'Frozen adopted head required');assert.equal(candidateCSS,'site/src/styles/kylon-lists.css');assert.equal(expectedTree,'9fc23475f2384098df486c58484af9634ea69e5c');assert.equal(baseline,'3a45f7f67ff8fb50a17de4a2ce2d7cafd20e20fb');assert.equal(baselineTree,'601c359061d8d3f9de9882e6391c9dbde965346c');}
const origin = 'http://127.0.0.1:4200', staticOrigin = 'http://127.0.0.1:4187';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const fact = f => { const b = fs.readFileSync(f); return {bytes: b.length, sha256: sha(b)}; };
const bytesFact = b => ({bytes: Buffer.byteLength(b), sha256: sha(b)});
const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, v) => fs.writeFileSync(f, typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v, null, 2) + '\n', {flag: 'wx'});
const index = {heads, scope: 'AUTHORIZED INVENTED editor composition in full native /app SSR: one Fieldwork workspace, Rowan, list and document. No auth/session/admission/transport or backend acceptance; no score or release claim.', images: [], contexts: [], errors: []};
frozen(); // Direct invocation also refuses before creating output or launching anything.
const flush = () => fs.writeFileSync(records + '/image-index.json', JSON.stringify(index, null, 2) + '\n');
let astro, browser, server, esbuild;
const contexts = new Set(), served = new Map(), assetRows = [];
let allowedCSS=new Set(),allowedFonts=new Map();

function git(args) {
  return cp.execFileSync('git', args, {cwd: app, encoding: 'utf8', timeout: 20000}).trimEnd();
}
function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => {
    const f = path.join(dir, e.name);
    assert.ok(e.isDirectory() || e.isFile(), 'Source files and directories only: ' + f);
    assert.ok(!/^\.env(?:$|\.)/.test(e.name), 'No env files');
    return e.isDirectory() ? walk(f) : [f];
  });
}
function source() {
  assert.equal(git(['rev-parse', 'HEAD']), head);
  assert.equal(git(['rev-parse',head+'^{tree}']),expectedTree);
  assert.equal(git(['rev-parse',baseline+'^{tree}']),baselineTree);
  const pins=readJSON('/inputs/source-pins.json');
  assert.equal(pins.head,head);assert.equal(pins.tree,expectedTree);assert.equal(pins.baseline,baseline);assert.equal(pins.baselineTree,baselineTree);
  assert.deepEqual(git(['diff','--name-only',baseline,head]).split('\n').filter(Boolean).sort(),Object.keys(pins.changedPaths).sort());
  for(const [rel,expected] of Object.entries({...pins.sourceFiles,...pins.changedPaths,...pins.pureHelpers}))assert.deepEqual(fact(app+'/'+rel),expected,'Pinned native input '+rel);
  assert.equal(git(['status', '--porcelain=v1', '-uall']), '', 'Only ignored generated caches allowed');
  // A fresh checkout has no arbitrary ignored files. Only these generated trees may appear.
  const ignored=git(['ls-files','--others','--ignored','--exclude-standard','--directory']).split('\n').filter(Boolean);
  assert.ok(ignored.every(p=>p==='site/.astro/' || p.startsWith('site/.astro/') || p==='site/node_modules' || p==='site/node_modules/' || p.startsWith('site/node_modules/')), 'Unexpected ignored source: '+ignored.join(','));
  assert.equal(Object.keys(pins.changedPaths).length,2);
  assert.equal(pins.functionalOwnedPaths.length,0);assert.equal(pins.presentationOwnedPaths.length,2);
  const files = {};
  for(const rel of ['site/src','site/public','src','supabase/functions/_shared'])
    for(const f of walk(app+'/'+rel))files[path.relative(app,f)]=fact(f);
  for(const rel of ['package.json','package-lock.json','site/package.json','site/package-lock.json','site/astro.config.mjs','site/tsconfig.json',...Object.keys(pins.changedPaths)])files[rel]=fact(app+'/'+rel);
  return {app, head, status: '', files};
}
// Bind the complete dependency/helper trees used by Astro, TypeScript, esbuild and Playwright.
// Symlink bytes AND target bytes are inventoried; targets must stay in the same tree.
function tree(dir) {
  const root = fs.realpathSync(dir), mapping = {};
  function visit(d) {
    for (const name of fs.readdirSync(d).sort()) {
      const f = path.join(d, name), s = fs.lstatSync(f);
      if (s.isSymbolicLink()) {
        const target = fs.realpathSync(f);
        assert.ok(target.startsWith(root + '/'));
        mapping[path.relative(root, f)] = {link: fs.readlinkSync(f), target: path.relative(root, target), ...(fs.statSync(target).isFile() ? fact(target) : {})};
      } else if (s.isDirectory()) visit(f);
      else { assert.ok(s.isFile()); mapping[path.relative(root, f)] = fact(f); }
    }
  }
  visit(root);
  return mapping;
}
function bindings(chrome) {
  const trees = {};
  for (const d of ['/inputs', deps + '/node_modules', tools + '/node_modules', '/opt/playwright/node_modules']) trees[d] = tree(d);
  const files = Object.fromEntries([process.execPath, chrome, deps + '/package.json', deps + '/package-lock.json', tools + '/package.json', tools + '/package-lock.json', cfg].map(f => [f, fact(f)]));
  return {trees, files};
}
function cssGraph(ownerText) {
  const owner=app+'/site/src/components/app/LiveDashboard.astro',pins=readJSON('/inputs/source-pins.json');
  const imports=[...ownerText.slice(0,ownerText.indexOf('\n---',3)).matchAll(/import\s+["']([^"']+\.css)["'];/g)].map(m=>m[1]);
  assert.deepEqual(imports,pins.cssImports);
  const sourceEntryGroups={global:[app+'/site/src/styles/global.css'],dashboard:imports.map(p=>path.resolve(path.dirname(owner),p))};
  const entries=[...new Set(Object.values(sourceEntryGroups).flat())],files={};
  function visit(f){
    assert.ok(f.startsWith(app+'/site/src/styles/')&&fs.realpathSync(f)===f);
    if(files[f])return;files[f]=fact(f);
    for(const m of fs.readFileSync(f,'utf8').matchAll(/@import\s+["']([^"']+)["']/g)){assert.ok(m[1].startsWith('.'));visit(path.resolve(path.dirname(f),m[1]));}
  }
  entries.forEach(visit);assert.ok(files[app+'/'+candidateCSS]);
  for(const [f,binding] of Object.entries(files))assert.deepEqual(binding,pins.sourceFiles[path.relative(app,f)]||pins.changedPaths[path.relative(app,f)]);
  return {entries,sourceEntryGroups,files,inline:Object.fromEntries([owner,app+'/site/src/layouts/Base.astro',app+'/site/src/components/app/HouseholdObjects.astro'].map(file=>[file,[...fs.readFileSync(file,'utf8').matchAll(/<style(?:\s+is:global)?>([\s\S]*?)<\/style>/g)].map(m=>bytesFact(m[1]))])),
    cascadeAuthority:'Actual SSR style/link node order including Astro scopes is authoritative. Source groups are an import union; no reordered fixture cascade.'};
}

async function bundle() {
  const entry = fs.readFileSync('/inputs/fixture-entry.ts','utf8').replaceAll('__APP__',app);
  assert.ok(!entry.includes('__APP__'));
  write(prepared+'/entry.ts',entry);
  const pins=readJSON('/inputs/source-pins.json');
  const allowed=new Set([prepared+'/entry.ts',prepared+'/native-owner.ts',...pins.bundleModules.map(f=>app+'/'+f)]);
  const loaded={};
  const result=await esbuild.build({absWorkingDir:app,entryPoints:[prepared+'/entry.ts'],bundle:true,write:false,
    metafile:true,format:'iife',platform:'browser',target:'es2022',outfile:prepared+'/fixture.js',
    plugins:[{name:'bind-actual-pure-view-inputs',setup(build){build.onLoad({filter:/\.[jt]s$/},args=>{
      const f=fs.realpathSync(args.path);assert.ok(allowed.has(f),'Unreviewed executable input: '+f);
      const contents=fs.readFileSync(f);if(loaded[f])assert.deepEqual(loaded[f],bytesFact(contents));loaded[f]=bytesFact(contents);
      return {contents,loader:f.endsWith('.ts')?'ts':'js',resolveDir:path.dirname(f)};
    });}}]});
  assert.equal(result.outputFiles.length,1,'CSS must come only from genuine Astro SSR');
  assert.deepEqual(Object.keys(result.metafile.inputs).map(f=>path.resolve(app,f)).sort(),Object.keys(loaded).sort());
  for(const f of Object.keys(loaded))assert.deepEqual(fact(f),loaded[f]);
  for(const rel of ['site/src/lib/household-objects-view.ts','site/src/lib/lists-chrome.ts','site/src/lib/kylon-shell/host.ts','site/src/lib/home-shell.ts'])assert.ok(loaded[app+'/'+rel]);
  for(const f of Object.keys(loaded).filter(f=>f.startsWith(app+'/')))assert.deepEqual(loaded[f],pins.sourceFiles[path.relative(app,f)]);
  write(prepared+'/fixture.js',Buffer.from(result.outputFiles[0].contents));
  write(prepared+'/bundle-inputs.json',{inputs:loaded,metafile:result.metafile,output:fact(prepared+'/fixture.js')});
}
async function rawGet(url) {
  const u = new URL(url);
  assert.equal(u.origin, origin);
  const r = await fetch(url, {redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(45000)});
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200, 'Loopback preview response');
  return {body, response: {url, status: r.status, ...bytesFact(body)}};
}
async function extractHTML(raw) {
  // SSR is parsed inertly; original app scripts never run, including Sample boot.
  const ctx=await browser.newContext({serviceWorkers:'block'});contexts.add(ctx);
  await ctx.route('**/*',r=>r.abort('blockedbyclient'));
  try {
    const p=await ctx.newPage();
    return await p.evaluate(({raw,origin,staticOrigin,lane})=>{
      const doc=new DOMParser().parseFromString(raw,'text/html');
      const app=doc.querySelector('live-dashboard.dashboard[data-kylon-shell]');
      if(!app || app.dataset.state!=='loading' || app.querySelector('[data-kylon-live-layout]'))throw Error('Unbooted genuine SSR required');
      for(const name of ['commonswarm:url','commonswarm:anon-key']){
        const m=doc.querySelector(`meta[name="${name}"]`);if(!m||m.content.trim())throw Error('Unconfigured genuine SSR required');
      }
      const targets={};
      for(const selector of ['.hm-frame','[data-home-rail-slot]','[data-user-menu-root]','[data-home-workspace-shell]','[data-home-catchup]','[data-home-side-slot]','[data-channel-view="objects"]']){
        const es=app.querySelectorAll(selector);if(es.length!==1)throw Error('Unique actual DOM target: '+selector);targets[selector]=es[0].outerHTML;
      }
      const styles=[...doc.querySelectorAll('style,link[rel="stylesheet"]')].map(e=>e.outerHTML);
      if(!styles.length)throw Error('Actual SSR cascade required');
      const removed=[];
      for(const e of doc.querySelectorAll('script,link[rel="modulepreload"],astro-dev-toolbar')){
        removed.push({tag:e.tagName,src:e.getAttribute('src'),href:e.getAttribute('href'),type:e.getAttribute('type'),text:e.textContent});e.remove();
      }
      if(doc.querySelector('iframe,object,embed,meta[http-equiv="refresh"],link[rel="preload"][as="script"]'))throw Error('Unexpected active SSR content');
      if([...doc.querySelectorAll('*')].some(e=>[...e.attributes].some(a=>/^on/i.test(a.name))))throw Error('Unexpected inline executable owner');
      let base=doc.querySelector('base');if(!base){base=doc.createElement('base');doc.head.prepend(base);}base.href=origin+'/app';
      doc.title='CONTROLLED '+lane+' review fixture';
      const script=doc.createElement('script');script.src=staticOrigin+'/'+lane+'/fixture.js';doc.body.append(script);
      if(JSON.stringify(styles)!==JSON.stringify([...doc.querySelectorAll('style,link[rel="stylesheet"]')].map(e=>e.outerHTML)))throw Error('Cascade changed');
      return {stylesheetURLs:[...doc.querySelectorAll('link[rel="stylesheet"]')].map(e=>new URL(e.getAttribute('href'),origin+'/app').href),ancestry:[app,app.parentElement,doc.querySelector('main'),doc.body,doc.documentElement].filter(Boolean).map(e=>({tag:e.tagName,attributes:Object.fromEntries([...e.attributes].map(a=>[a.name,a.value]))})),html:'<!doctype html>'+doc.documentElement.outerHTML,styles,targets,removed,
        owner:{tag:app.tagName,attributes:Object.fromEntries([...app.attributes].map(a=>[a.name,a.value]))},
        scope:'Whole native unconfigured Astro SSR DOM, CSS nodes/order and ancestry retained. Original scripts/preloads/dev toolbar removed inertly; base and bound fixture bundle added. Actual source host/builders compose typed invented VMs; fixture title/records explicitly label the authorized invented editor composition; native sample notice stays hidden as authored; native access/approval presentation assignments are extracted and bound. No authored product CSS.'};
    },{raw,origin,staticOrigin,lane});
  }finally{await ctx.close();contexts.delete(ctx);}
}
function serve() {
  server = http.createServer((req, res) => {
    try {
      assert.ok(['GET', 'HEAD'].includes(req.method));
      const u = new URL(req.url, staticOrigin);
      assert.ok(!u.search || u.pathname==='/'+lane+'/index.html' && ['?mode=list','?mode=document'].includes(u.search));
      const f = served.get(u.pathname); assert.ok(f && fs.realpathSync(f) === f);
      const b = fs.readFileSync(f);
      res.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'HEAD') res.end(); else res.end(b);
    } catch { res.statusCode = 404; res.end(); }
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(4187, '127.0.0.1', resolve); });
}
async function capture(width, height, mode, extraction) {
  const row = {lane, head, width, height, mode, theme: 'light', state: 'normal', assets: [], refused: [], errors: []};
  index.contexts.push(row); flush();
  const ctx = await browser.newContext({acceptDownloads:false,timezoneId:'UTC',locale:'en-US',viewport: {width, height}, colorScheme: 'light', reducedMotion: 'reduce', deviceScaleFactor: 1, serviceWorkers: 'block'});
  contexts.add(ctx);
  const pending = new Set();
  const p = await ctx.newPage();
  await p.clock.setFixedTime(new Date('2026-10-22T12:00:00.000Z'));
  p.setDefaultTimeout(12000);p.setDefaultNavigationTimeout(45000);
  await ctx.routeWebSocket('**/*',ws=>{row.refused.push({kind:'WebSocket',origin:new URL(ws.url()).origin,path:new URL(ws.url()).pathname});ws.close();});
  p.on('download',download=>{row.errors.push('Unexpected download');download.cancel().catch(()=>{});});
  p.on('popup',popup=>{row.errors.push('Unexpected popup');popup.close().catch(()=>{});});
  function keep(task) { pending.add(task); task.finally(() => pending.delete(task)).catch(() => {}); }
  const taskErrors = [];
  await ctx.route('**/*', async route => {
    const request = route.request(), u = new URL(request.url());
    const allowed = ['GET', 'HEAD'].includes(request.method()) && (
      u.origin === staticOrigin && served.has(u.pathname) && (!u.search || u.pathname==='/'+lane+'/index.html' && u.search==='?mode='+mode) ||
      u.origin === origin && (request.resourceType() === 'stylesheet' && allowedCSS.has(u.href) || request.resourceType() === 'font' && !u.search && allowedFonts.has(u.pathname))
    );
    if (!allowed) {
      row.refused.push({origin: u.origin, path: u.pathname, method: request.method(), type: request.resourceType()});
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  p.on('pageerror', e => row.errors.push(e.message));
  p.on('response', response => keep((async () => {
    const request = response.request(), url = response.url(), u = new URL(url);
    const body = await response.body();
    assert.equal(response.status(), 200);
    const contentType = response.headers()['content-type'] || '';
    const extension = request.resourceType() === 'font' ? '.woff2' : request.resourceType() === 'stylesheet' ? '.css' : '.bin';
    const digest = sha(body), file = prepared + '/served-assets/' + digest + extension;
    if (!fs.existsSync(file)) write(file, body);
    const asset = {url, method: request.method(), type: request.resourceType(), status: response.status(), contentType, file, ...bytesFact(body)};
    if (u.origin === staticOrigin) {
      const local = served.get(u.pathname); assert.ok(local); assert.deepEqual(fact(local), bytesFact(body)); asset.source = local;
    }
    if (request.resourceType() === 'font') {
      assert.equal(u.origin, origin); assert.equal(u.search, '');
      const sourceFile = path.resolve(app + '/site/public', '.' + decodeURIComponent(u.pathname));
      assert.ok(sourceFile.startsWith(app + '/site/public/fonts/') && allowedFonts.has(u.pathname));
      asset.license=allowedFonts.get(u.pathname).license;
      assert.deepEqual(fact(sourceFile), bytesFact(body)); asset.source = sourceFile;
    }
    if (request.resourceType() === 'stylesheet') {
      assert.equal(u.origin, origin);
      assert.ok(contentType.includes('text/css'), 'Actual CSS response, never an executable CSS module');
      const f = path.resolve(app + '/site', '.' + decodeURIComponent(u.pathname));
      assert.ok(f.startsWith(app + '/site/src/'));
      assert.ok(fs.statSync(f).isFile());
      asset.source = f; asset.sourceHash = fact(f);
    }
    row.assets.push(asset); assetRows.push(asset); flush();
  })().catch(e => { taskErrors.push(e.stack); })));
  async function settle() { while (pending.size) await Promise.all([...pending]); assert.deepEqual(taskErrors, []); }
  try {
    const response=await p.goto(staticOrigin+'/'+lane+'/index.html?mode='+mode,{waitUntil:'domcontentloaded'});
    row.initialRaw=await p.evaluate(pageSnapshot);flush();
    await p.waitForFunction(mode=>{
      const app=document.querySelector('live-dashboard'),root=app?.querySelector('[data-channel-view="objects"]');
      return window.listsFixtureReady===true&&window.listsFixture.read().mode===mode&&app?.dataset.state==='channel'&&app.dataset.channelView==='objects'&&root?.getClientRects().length>0&&document.activeElement===root?.querySelector('h1');
    },mode,{timeout:12000});
    await p.evaluate(()=>{document.fonts.ready.then(()=>{window.__listsFontsReady=true;});});
    await p.waitForFunction(()=>window.__listsFontsReady===true&&document.fonts.status==='loaded'&&document.fonts.check('14px "CommonSwarm Inter"'),undefined,{timeout:12000});
    await p.waitForFunction(()=>{
      const selectors=['live-dashboard.dashboard[data-kylon-shell]','[data-channel-view="objects"]','[data-channel-view="objects"] h1','.dashboard__lists-head','[data-household-objects]','article[aria-label="Selected object"]'];
      const elements=selectors.map(s=>document.querySelector(s));if(elements.some(e=>!e))return false;
      const key=JSON.stringify(elements.map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height,e.scrollWidth,e.scrollHeight,e.scrollTop];}));
      const old=window.__listsGeometry;window.__listsGeometry={key,count:old?.key===key?old.count+1:1};return window.__listsGeometry.count>=3&&document.fonts.status==='loaded';
    },undefined,{timeout:12000,polling:100});
    await settle();row.raw=await p.evaluate(pageSnapshot);flush();
    // Retain actual geometry and complete native control inventory before assertions.
    assert.equal(response.status(),200);assert.deepEqual(row.raw.styles,extraction.styles);
    assert.equal(row.raw.width,width);assert.equal(row.raw.height,height);assert.equal(row.raw.light,true);
    assert.equal(row.raw.state,'channel');assert.equal(row.raw.channelView,'objects');assert.ok(row.raw.fixture.hostMounted);
    assert.equal(row.raw.fixture.selectedId,mode==='list'?'supplies':'notes');assert.equal(row.raw.fixture.saveState,'idle');
    assert.deepEqual(row.raw.fixture.calls,[]);assert.ok(Object.values(row.raw.fixture.chromeIdentity).every(Boolean));
    assert.equal(row.raw.fixture.access.consentHidden,true);assert.equal(row.raw.fixture.access.approvalsHidden,false);
    assert.equal(row.raw.fixture.notice.hidden,true,'Native authorized state retains hidden sample notice');
    assert.equal(row.raw.visibleH1.length,1);assert.equal(row.raw.visibleH1[0].id,'dashboard-lists-title');assert.ok(row.raw.focus.nativeHeading);
    assert.equal(row.raw.nativeObjects.length,1);assert.equal(row.raw.objectIndex.length,2);
    assert.equal(row.raw.contentKind,mode);assert.equal(row.raw.refresh.hidden,true,'Native zero-agent refresh stays hidden');
    assert.equal(row.raw.channelLabel,'dashboard-lists-title');assert.equal(row.raw.legacyHead.hidden,true);
    assert.ok(row.raw.heading.font.includes('CommonSwarm Inter'));
    assert.ok(row.raw.fonts.some(f=>f.family.replaceAll('"','')==='CommonSwarm Inter'&&f.status==='loaded'));
    assert.ok(row.assets.some(a=>a.source===app+'/site/public/fonts/inter-latin.woff2'));
    assert.equal(row.raw.documentScroll.x,0);assert.equal(row.raw.documentScroll.y,0);
    // Layout/overflow/fold measurements are observations, never force-fit or clipping rules.
    if(width===1471)assert.equal(row.raw.rail.width,52,'Native application rail');
    assert.deepEqual(row.refused,[]);assert.deepEqual(row.errors,[]);
    const file=prepared+`/lists-${mode}-${width}x${height}-light-normal.png`;
    await p.screenshot({path:file,fullPage:false});
    index.images.push({file,...fact(file),lane,head,tree:expectedTree,baseline,baselineTree,width,height,mode,theme:'light',state:'normal',scope:index.scope,raw:row.raw});
    await settle();assert.deepEqual(row.refused,[]);assert.deepEqual(row.errors,[]);row.complete=true;flush();
  }catch(e){
    row.failure=String(e.stack);
    try{row.failureState=await p.evaluate(pageSnapshot);}catch(diagnosticError){row.diagnosticError=String(diagnosticError);}
    throw e;
  }finally{try{await settle();}finally{await ctx.close();contexts.delete(ctx);flush();}}
}
// This function is serialized into the page; it has no closure or mutation dependencies.
function pageSnapshot(){
  const root=document.querySelector('live-dashboard'),objects=root?.querySelector('[data-channel-view="objects"]'),heading=objects?.querySelector('h1');
  function box(e){
    if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);
    const rendered=e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    return {tag:e.tagName,id:e.id,class:e.getAttribute('class'),text:e.textContent,hidden:e.hidden,inert:e.inert,hiddenAncestor:!!e.closest('[hidden]'),inertAncestor:!!e.closest('[inert]'),rendered,
      inViewport:rendered&&r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth,
      x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight,clientWidth:e.clientWidth,clientHeight:e.clientHeight,scrollTop:e.scrollTop,scrollLeft:e.scrollLeft,
      font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,lineHeight:s.lineHeight,color:s.color,background:s.backgroundColor,
      display:s.display,position:s.position,overflowX:s.overflowX,overflowY:s.overflowY,padding:s.padding,scrollPadding:s.scrollPadding,
      outline:s.outline,outlineOffset:s.outlineOffset,boxShadow:s.boxShadow,colorScheme:s.colorScheme,tabIndex:e.tabIndex,ariaBusy:e.getAttribute('aria-busy')};
  }
  const selected=objects?.querySelector('article[aria-label="Selected object"]');
  const ancestors=[];for(let e=heading;e;e=e.parentElement)ancestors.push(box(e));
  const visibleH1=[...root?.querySelectorAll('h1')||[]].map(box).filter(e=>e.rendered);
  return {fixture:window.listsFixture?.read(),state:root?.dataset.state,channelView:root?.dataset.channelView,
    width:innerWidth,height:innerHeight,dpr:devicePixelRatio,route:location.pathname+location.search,base:document.baseURI,
    light:matchMedia('(prefers-color-scheme:light)').matches,reducedMotion:matchMedia('(prefers-reduced-motion:reduce)').matches,
    forcedColors:matchMedia('(forced-colors:active)').matches,root:box(root),heading:box(heading),visibleH1,headingAncestors:ancestors,
    rail:box(root?.querySelector('.cs-org-rail')),context:box(root?.querySelector('.cs-org-context')),workspaceHeader:box(root?.querySelector('.hm-ws-header')),
    main:box(root?.querySelector('.hm-frame__main')),phoneHeader:box(root?.querySelector('.cs-org-phone-bar')),objects:box(objects),selected:box(selected),
    refresh:box(root?.querySelector('[data-refresh]')),description:box(root?.querySelector('[data-channel-description]')),legacyHead:box(root?.querySelector('.dashboard__channel-head')),channelLabel:root?.querySelector('.dashboard__channel')?.getAttribute('aria-labelledby'),
    nativeObjects:[...root?.querySelectorAll('[data-household-objects]')||[]].map(box),objectIndex:[...objects?.querySelectorAll('[data-hh-action="select"]')||[]].map(box),
    contentKind:selected?.querySelector('.hh-list')?'list':selected?.querySelector('.hh-markdown')?'document':null,
    controls:[...root?.querySelectorAll('button,a,input,textarea,select,summary')||[]].map(e=>({action:e.dataset.hhAction,value:e.value,checked:e.checked,disabled:e.disabled,ariaLabel:e.getAttribute('aria-label'),ariaCurrent:e.getAttribute('aria-current'),ariaExpanded:e.getAttribute('aria-expanded'),...box(e)})),
    panels:[...root?.querySelectorAll('[data-panel],[data-channel-view],[data-household-consent],[data-household-agents],details')||[]].map(e=>({panel:e.dataset.panel,view:e.dataset.channelView,open:e.open,...box(e)})),
    documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,
    documentScroll:{x:scrollX,y:scrollY,scrollingElement:document.scrollingElement?.tagName,html:box(document.documentElement),body:box(document.body)},
    scrollOwners:[...root?.querySelectorAll('*')||[]].filter(e=>{const s=getComputedStyle(e);return /auto|scroll/.test(s.overflowX+' '+s.overflowY)||e.scrollWidth>e.clientWidth||e.scrollHeight>e.clientHeight;}).map(box),
    fontsStatus:document.fonts.status,fonts:[...document.fonts].map(f=>({family:f.family,status:f.status,weight:f.weight})),
    styles:[...document.querySelectorAll('style,link[rel="stylesheet"]')].map(e=>e.outerHTML),stylesheets:[...document.styleSheets].map(s=>({href:s.href})),
    focus:{nativeHeading:document.activeElement===heading,tag:document.activeElement?.tagName,html:document.activeElement?.outerHTML},
    scope:'Initial viewport only. All native content, approval/access furniture, controls, lower-fold history and scroll owners remain. No CSS/focus/overflow adjustment or backend acceptance.'};
}

async function close() {
  for (const ctx of contexts) { try { await ctx.close(); contexts.delete(ctx); } catch (e) { index.errors.push(String(e)); } }
  if (browser) { try { await browser.close(); } catch (e) { index.errors.push(String(e)); } browser = null; }
  if (astro) { try { await astro.stop(); } catch (e) { index.errors.push(String(e)); } astro = null; }
  if (server) { await new Promise(resolve => server.close(resolve)); server = null; }
  esbuild?.stop();
}
async function captureLane(current, chrome) {
  lane=current;app=base+'/sources/'+lane;head=heads[lane];prepared=proofs+'/'+lane;
  cfg=base+'/configs/'+lane+'.config.mjs';served.clear();assetRows.length=0;
  fs.mkdirSync(prepared);fs.mkdirSync(prepared+'/served-assets');flush();
  const before=source();write(records+'/'+lane+'-source-before.json',before);
  const symlink=app+'/site/node_modules';let linked=false,bindingBefore,preparedBefore;
  const preparedBinding=()=>Object.fromEntries(walk(prepared).filter(f=>!f.endsWith('.png')&&!path.relative(prepared,f).startsWith('served-assets/')).map(f=>[path.relative(prepared,f),fact(f)]));
  try{
  const owner = app + '/site/src/components/app/LiveDashboard.astro', text = fs.readFileSync(owner, 'utf8');
  const graph=cssGraph(text);write(prepared+'/css-source-graph.json',graph);
  fs.mkdirSync(prepared+'/source-assets');
  for(const f of [...new Set([owner,...Object.keys(readJSON('/inputs/source-pins.json').sourceFiles).map(p=>app+'/'+p),...Object.keys(graph.files)])]){
    const b=fs.readFileSync(f),name=sha(b)+path.extname(f);if(!fs.existsSync(prepared+'/source-assets/'+name))write(prepared+'/source-assets/'+name,b);
  }
  // Explicit allowlist of actual font files with every available source license.
  const fontLicenses={'inter':'OFL-Inter.txt','dm-sans':'OFL-DMSans.txt','plus-jakarta-sans':'OFL-PlusJakartaSans.txt','bricolage-grotesque':'OFL-BricolageGrotesque.txt','instrument-sans':'OFL-InstrumentSans.txt','jetbrains-mono':null};
  allowedFonts=new Map();
  for(const [family,licenseName] of Object.entries(fontLicenses)){
    const licenseFile=licenseName?app+'/site/public/fonts/'+licenseName:null;
    if(licenseFile&&!fs.existsSync(prepared+'/'+licenseName))write(prepared+'/'+licenseName,fs.readFileSync(licenseFile));
    for(const suffix of family==='inter'?['-latin']:['-latin','-latin-ext']){
      const name=family+suffix+'.woff2',file=app+'/site/public/fonts/'+name;
      assert.ok(fs.lstatSync(file).isFile()&&fs.realpathSync(file)===file);
      allowedFonts.set('/fonts/'+name,{file,...fact(file),license:licenseFile?{file:licenseFile,...fact(licenseFile)}:null,licenseLimit:licenseFile?null:'No JetBrains Mono license file in exact baseline source tree; font is retained, never replaced.'});
      const b=fs.readFileSync(file),saved=prepared+'/source-assets/'+sha(b)+'.woff2';if(!fs.existsSync(saved))write(saved,b);
    }
  }
  write(prepared+'/font-license-binding.json',Object.fromEntries(allowedFonts));
  assert.ok(!fs.existsSync(symlink));fs.symlinkSync(deps+'/node_modules',symlink);linked=true;
    write(cfg, `import base from ${JSON.stringify(pathToFileURL(app + '/site/astro.config.mjs').href)};\nexport default {...base,root:${JSON.stringify(app + '/site')},cacheDir:${JSON.stringify(base+'/cache/'+lane+'/astro')},devToolbar:{enabled:false},server:{...base.server,host:'127.0.0.1',port:4200},vite:{...base.vite,envDir:false,cacheDir:${JSON.stringify(base+'/cache/'+lane+'/vite')},server:{host:'127.0.0.1',port:4200,strictPort:true,fs:{strict:true,allow:${JSON.stringify([app, deps, base + '/configs', base + '/cache'])}},ws:{host:'127.0.0.1',port:4201,clientPort:4201,protocol:'ws',path:'/'}}}};\n`);
    bindingBefore=bindings(chrome);write(records+'/'+lane+'-helper-bindings-before.json',bindingBefore);
    nativeOwner({app,prepared,ts:require(deps+'/node_modules/typescript'),write});
    index.observed = {node: process.version, chrome, playwright: readJSON('/opt/playwright/node_modules/playwright/package.json').version, playwrightCore: readJSON('/opt/playwright/node_modules/playwright-core/package.json').version, metadataTools: '1.64.1', browserOrigin: 'Immutable image bundled Chromium; no substitution or browser download'}; flush();
    esbuild = require(deps + '/node_modules/esbuild'); await bundle();
    const {dev} = await import(pathToFileURL(deps + '/node_modules/astro/dist/index.js').href);
    astro = await dev({root: app + '/site', configFile: path.relative(app + '/site', cfg)});
    const {body, response} = await rawGet(origin + '/app');
    write(prepared+'/genuine-unconfigured-astro.html',body);
    const license=await rawGet(origin+'/fonts/OFL-Inter.txt');assert.deepEqual(bytesFact(license.body),fact(app+'/site/public/fonts/OFL-Inter.txt'));write(prepared+'/inter-license-response.json',license.response);
    index.genuineSSR??={};index.genuineSSR[lane]=response;flush();
    const {chromium} = require('/opt/playwright/node_modules/playwright');
    browser = await chromium.launch({executablePath: chrome, args: ['--no-sandbox', '--password-store=basic', '--use-mock-keychain']});
    const extraction = await extractHTML(body.toString('utf8'));
    allowedCSS=new Set(extraction.stylesheetURLs);
    for(const f of Object.keys(graph.files))allowedCSS.add(origin+'/'+path.relative(app+'/site',f));
    for(const url of allowedCSS){const u=new URL(url);assert.equal(u.origin,origin);assert.ok(u.pathname.startsWith('/src/'));}
    write(prepared + '/extraction.json', extraction); write(prepared + '/index.html', extraction.html);
    preparedBefore=preparedBinding();write(records+'/'+lane+'-prepared-bindings-before.json',preparedBefore);
    served.set('/'+lane+'/index.html', prepared+'/index.html');served.set('/'+lane+'/fixture.js',prepared+'/fixture.js');await serve();
    for(const mode of ['list','document'])for(const [w,h] of [[1471,900],[390,844]])await capture(w,h,mode,extraction);
    const refetched = [];
    for (const [url, asset] of new Map(assetRows.map(a => [a.url, a]))) {
      const u = new URL(url); assert.ok([origin, staticOrigin].includes(u.origin));
      const r = await fetch(url, {headers: {Accept: asset.contentType}, credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(15000)});
      const b = Buffer.from(await r.arrayBuffer()); assert.equal(r.status, 200); assert.deepEqual(bytesFact(b), {bytes: asset.bytes, sha256: asset.sha256});
      refetched.push({url, status: r.status, ...bytesFact(b)});
    }
    write(records + '/' + lane + '-served-refetch.json', refetched);
    assert.deepEqual(source(), before);
  } catch(e) { index.errors.push(lane+': '+String(e.stack));throw e;
  } finally {
    // Each cleanup/binding attempt runs even if another one fails. Partial receipts survive.
    const failures=[];
    const attempt=async(label,fn)=>{try{await fn();}catch(e){failures.push(label+': '+String(e.stack));}};
    await attempt('close',close);
    await attempt('prepared-after',()=>{const after=preparedBinding();write(records+'/'+lane+'-prepared-bindings-after.json',after);if(preparedBefore)assert.deepEqual(after,preparedBefore);});
    if(bindingBefore)await attempt('helpers-after',()=>{const after=bindings(chrome);write(records+'/'+lane+'-helper-bindings-after.json',after);assert.deepEqual(after,bindingBefore);});
    if(linked)await attempt('dependency-link-cleanup',()=>{assert.ok(fs.lstatSync(symlink).isSymbolicLink()&&fs.readlinkSync(symlink)===deps+'/node_modules');fs.unlinkSync(symlink);});
    await attempt('source-after',()=>{const after=source();write(records+'/'+lane+'-source-after.json',after);assert.deepEqual(after,before);});
    if(failures.length){index.errors.push(...failures);process.exitCode=1;}
    flush();if(failures.length)throw Error('See retained image-index.json for cleanup/binding errors');
  }
}

async function main() {
  frozen();
  assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.getuid(),65534);
  const pw = '/opt/playwright/node_modules/playwright-core';
  const registry = readJSON(pw + '/browsers.json').browsers.filter(b => b.name === 'chromium-headless-shell'); assert.equal(registry.length, 1);
  const chrome = fs.realpathSync('/ms-playwright/chromium_headless_shell-' + registry[0].revision + '/chrome-headless-shell-linux64/chrome-headless-shell');
  assert.ok(chrome.startsWith('/ms-playwright/') && fs.lstatSync(chrome).isFile()); fs.accessSync(chrome, fs.constants.X_OK);
  const fd = fs.openSync(chrome, 'r'), magic = Buffer.alloc(4); try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
  assert.equal(magic.toString('hex'), '7f454c46');
  assert.equal(readJSON(tools + '/node_modules/playwright-core/package.json').version, '1.64.1');
  index.registry=registry[0];flush();
  for(const current of ['lists'])await captureLane(current,chrome);
  assert.equal(index.images.length,4);index.captureFinished=true;flush();
}
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { index.errors.push('Interrupted: ' + sig); close().finally(() => { flush(); process.exit(1); }); });
main().catch(e => { index.errors.push(String(e.stack)); process.exitCode = 1; flush(); }).finally(async () => { await close(); flush(); });
