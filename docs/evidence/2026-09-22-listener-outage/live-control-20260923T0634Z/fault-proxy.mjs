// Live-control proxy: forwards to the production API and injects two faults on the
// signal read path. Logs method, path and status only (no headers, no bodies).
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { appendFileSync, writeFileSync } from "node:fs";

const UPSTREAM = "api.commonswarm.com";
const LOG = process.argv[2];
const PORT_FILE = process.argv[3];
const FAULTS = [
  { status: 500, type: "application/json", body: '{"error":"internal_error"}' },
  // A foreign backend's page: no CommonSwarm error code in the body.
  { status: 403, type: "text/html", body: "<html><body><h1>403 Forbidden</h1></body></html>" },
];
let readCount = 0;
const log = (line) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);

const server = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "POST" && path === "/functions/v1/read") {
    readCount += 1;
    const fault = FAULTS[readCount - 1];
    if (fault) {
      req.resume();
      res.writeHead(fault.status, { "content-type": fault.type });
      res.end(fault.body);
      log(`INJECT ${req.method} ${path} read#${readCount} -> ${fault.status}`);
      return;
    }
  }
  const headers = { ...req.headers, host: UPSTREAM };
  const up = https.request({ host: UPSTREAM, port: 443, method: req.method, path: req.url, headers }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, ur.headers);
    ur.pipe(res);
    log(`PASS ${req.method} ${path}${path === "/functions/v1/read" ? ` read#${readCount}` : ""} -> ${ur.statusCode}`);
  });
  up.on("error", (e) => { log(`UPSTREAM_ERROR ${req.method} ${path} ${e.code ?? "error"}`); res.writeHead(502); res.end(); });
  req.pipe(up);
});

server.on("upgrade", (req, socket, head) => {
  const path = (req.url ?? "/").split("?")[0];
  const up = tls.connect({ host: UPSTREAM, port: 443, servername: UPSTREAM }, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${k === "host" ? UPSTREAM : v}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
    log(`UPGRADE ${path}`);
  });
  up.on("error", (e) => { log(`UPGRADE_ERROR ${path} ${e.code ?? "error"}`); socket.destroy(); });
  socket.on("error", () => up.destroy());
});

server.listen(0, "127.0.0.1", () => {
  writeFileSync(PORT_FILE, String(server.address().port));
  log(`LISTEN ${server.address().port}`);
});
