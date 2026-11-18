from pathlib import Path
import json,re
root=Path('site/src/lib')
text=(root/'people-dialog-view.ts').read_text()
message=re.search(r': `(Withdraw Lists & docs access for \$\{name\}\? [^`]+)`',text).group(1).replace('${name}','Sprout')
source=(Path('site/src/components/app/LiveDashboard.astro')).read_text()
assert 'window.confirm(withdrawConfirmText(agentName, hosted))' in source
out=Path('shots');out.mkdir(exist_ok=True)
(out/'index.html').write_text('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lists &amp; docs</title><style>body{font:17px system-ui;padding:20px}button{font:inherit}</style><h1>Lists &amp; docs</h1><p>Sprout</p><button autofocus>Withdraw access</button><script>document.querySelector("button").onclick=()=>window.confirm('+json.dumps(message)+');</script></html>')
(out/'message.json').write_text(json.dumps({'words':len(message.split()),'message':message}))
