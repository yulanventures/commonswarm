// Injected observation only. The actual built HTML, CSS, fonts and images remain unchanged.
export const measurementScript = `<script>
  (async () => {
    let stage = 'fonts-ready', finished = false, fontsReady = false;
    const width = Number(window.frameElement?.dataset.observerWidth);
    const encode = value => btoa(unescape(encodeURIComponent(JSON.stringify(value))));
    const rect = node => {
      const r = node.getBoundingClientRect();
      return {left:r.left,top:r.top,width:r.width,height:r.height};
    };
    const heads = () => Array.from(document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6')).filter(h => h.getClientRects().length > 0);
    const faces = () => Array.from(document.fonts).map(f => ({family:f.family,status:f.status,weight:f.weight,style:f.style,unicodeRange:f.unicodeRange}));
    const clean = value => value.trim().replace(/^['"]|['"]$/g, '');
    const details = () => heads().map(h => {
      const s = getComputedStyle(h), family = clean(s.fontFamily.split(',')[0]);
      const text = h.textContent.replace(/\\s+/g, ' ').trim();
      const font = s.fontStyle+' '+s.fontWeight+' '+s.fontSize+' '+JSON.stringify(family);
      return {level:h.tagName,text,family,font,lineHeight:Number.parseFloat(s.lineHeight),rect:rect(h),
        declaredLoaded:Array.from(document.fonts).some(f => clean(f.family) === family && f.status === 'loaded'),
        checked:document.fonts.check(font,text)};
    });
    const snapshot = () => ({stage,requestedWidth:width,actualWidth:innerWidth,
      widthMedia:Number.isFinite(width)&&matchMedia('(width: '+width+'px)').matches,
      readyState:document.readyState,fontsReady,fontStatus:document.fonts.status,faces:faces(),headings:details(),
      images:Array.from(document.images).map(i=>({currentSrc:i.currentSrc,complete:i.complete,naturalWidth:i.naturalWidth})),
      styles:Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(l=>({href:l.href,sheet:!!l.sheet})),
      resources:performance.getEntriesByType('resource').map(r=>({name:r.name,initiatorType:r.initiatorType,duration:r.duration}))});
    window.headingReadinessDiagnostic = snapshot;
    const report = value => {
      if(finished)return;
      finished=true;clearTimeout(watchdog);
      document.documentElement.dataset.pageMeasurement=encode(value);
    };
    const fail = error => report({error:{stage,message:String(error),diagnostics:snapshot()}});
    const watchdog = setTimeout(()=>fail(new Error('Heading readiness deadline exceeded')),2500);
    try {
      await document.fonts.ready;
      fontsReady=true;stage='width-fonts-geometry';
      while(!finished){
        const h=details();
        const ready=innerWidth===width&&matchMedia('(width: '+width+'px)').matches&&
          document.fonts.status==='loaded'&&h.length>0&&h.every(x=>x.text&&x.declaredLoaded&&x.checked&&
            Number.isFinite(x.lineHeight)&&x.lineHeight>0&&Object.values(x.rect).every(Number.isFinite)&&x.rect.width>0&&x.rect.height>0);
        if(ready){
          stage='measured';
          report({clientWidth:document.documentElement.clientWidth,
            headings:h.map(x=>({level:x.level,lines:Math.round(x.rect.height/x.lineHeight),text:x.text})),
            scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,diagnostics:snapshot()});
          return;
        }
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    } catch(error){fail(error);}
  })();
</script>`;

export const frameScript = `<script>
  const frame=document.querySelector('iframe');
  let forwarded=false,timer;
  const publish=value=>{
    if(forwarded)return;
    forwarded=true;clearTimeout(timer);clearTimeout(deadline);
    document.documentElement.dataset.pageMeasurement=value;
  };
  const fail=error=>{
    let child;
    try{child=frame.contentWindow?.headingReadinessDiagnostic?.();}
    catch(e){child={unavailable:String(e)};}
    publish(btoa(unescape(encodeURIComponent(JSON.stringify({error:{stage:'report-forwarding',message:String(error),
      diagnostics:{requestedWidth:frame.dataset.observerWidth,frameWidth:frame.getBoundingClientRect().width,
        parentWidth:innerWidth,readyState:document.readyState,child}}})))));
  };
  const deadline=setTimeout(()=>fail(new Error('Child measurement report deadline exceeded')),2800);
  const copyMeasurement=()=>{
    if(forwarded)return;
    try{
      const measurement=frame.contentDocument?.documentElement?.dataset.pageMeasurement;
      if(measurement){publish(measurement);return;}
      clearTimeout(timer);timer=setTimeout(copyMeasurement,10);
    }catch(error){fail(error);}
  };
  frame.addEventListener('load',copyMeasurement);
  copyMeasurement();
</script>`;
