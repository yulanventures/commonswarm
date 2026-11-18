#!/usr/bin/env bash
# Run the site's web-server rules in isolation and check what they answer.
#
#   deploy/site/check-site-caddy.sh /path/to/caddy
#
# It starts the given Caddy binary on a loopback port with a temporary site folder, using
# deploy/site/commonswarm-site.caddy with its address and root swapped and its TLS block removed, asks for a
# fixed set of addresses and compares status, content type, cache header and which body came back.
# It touches no running web server and removes its folder when it ends. Use the Caddy version the box
# pins; the version is printed so the result says what it was proved on.
set -euo pipefail

caddy="${1:?usage: check-site-caddy.sh /path/to/caddy}"
here="$(cd "$(dirname "$0")" && pwd)"
source_file="$here/commonswarm-site.caddy"
port="${CHECK_SITE_CADDY_PORT:-18404}"
work="$(mktemp -d "${TMPDIR:-/tmp}/check-site-caddy.XXXXXX")"
pid=""
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  case "$work" in */check-site-caddy.*) rm -rf "$work" ;; esac
}
trap cleanup EXIT

site="$work/site"
mkdir -p "$site/guides/x" "$site/_astro" "$site/fonts" "$site/skills/cswarm"
printf '<!doctype html><title>home</title>home\n' > "$site/index.html"
printf '<!doctype html><title>guide</title>guide\n' > "$site/guides/x/index.html"
printf 'console.log(1)\n' > "$site/_astro/a.Ab12Cd34.js"
printf 'a{}\n' > "$site/_astro/b.Ef56Gh78.css"
printf 'font\n' > "$site/fonts/x.woff2"
printf '# api\n' > "$site/api.md"
printf 'llms\n' > "$site/llms.txt"
printf '# skill\n' > "$site/skills/cswarm/SKILL.md"
printf '<?xml version="1.0"?><urlset/>\n' > "$site/sitemap.xml"

# The real file with only its address and root replaced and its TLS block (certificate and client-certificate check) removed.
{
  printf '{\n\tadmin off\n\tauto_https off\n}\n'
  sed -e "s|^https://commonswarm.com, .* {\$|http://127.0.0.1:$port {|" \
      -e '/^[[:space:]]tls .*{$/,/^[[:space:]]}$/d' \
      -e '/^[[:space:]]*tls /d' \
      -e "s|root \* /srv/commonswarm/site/current|root * $site|" \
      "$source_file" | sed -n '/^http:\/\/127\.0\.0\.1/,$p'
} > "$work/Caddyfile"
grep -q "^http://127.0.0.1:$port {" "$work/Caddyfile" || { echo "could not rewrite the site address; has the first line of the block changed?" >&2; exit 2; }
# The loopback copy is plain HTTP: no certificate and no client-certificate check may be left in it.
if grep -n -E '^[[:space:]]*(tls|client_auth|trust_pool|mode require_and_verify)' "$work/Caddyfile" >&2; then
  echo "the TLS block was not fully removed from the loopback copy; has its shape changed?" >&2; exit 2
fi

echo "caddy: $("$caddy" version)"
"$caddy" validate --adapter caddyfile --config "$work/Caddyfile" > "$work/validate.log" 2>&1 || { cat "$work/validate.log" >&2; exit 2; }
"$caddy" run --adapter caddyfile --config "$work/Caddyfile" > "$work/run.log" 2>&1 &
pid=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.1; done

failures=0
# check <path> <status> <content-type prefix> <body: file|page|plain> <cache: revalidate|immutable>
check() {
  local path="$1" want_status="$2" want_type="$3" want_body="$4" want_cache="$5"
  local status type cache body got_body got_cache
  status="$(curl -s -D "$work/headers" -o "$work/body" -w '%{http_code}' "http://127.0.0.1:$port$path")"
  type="$(tr -d '\r' < "$work/headers" | awk -F': ' 'tolower($1)=="content-type"{print $2}')"
  cache="$(tr -d '\r' < "$work/headers" | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"
  body="$(head -c 200 "$work/body")"
  case "$body" in
    *"Page not found"*) got_body=page ;;
    "The page could not be found"*) got_body=plain ;;
    *) got_body=file ;;
  esac
  case "$cache" in
    "public, max-age=0, must-revalidate") got_cache=revalidate ;;
    "public, max-age=31536000, immutable") got_cache=immutable ;;
    *) got_cache="other($cache)" ;;
  esac
  if [ "$status" = "$want_status" ] && [ "${type#"$want_type"}" != "$type" ] && [ "$got_body" = "$want_body" ] && [ "$got_cache" = "$want_cache" ]; then
    printf 'ok    %-34s %s %-28s %-5s %s\n' "$path" "$status" "$type" "$got_body" "$got_cache"
  else
    printf 'FAIL  %-34s got %s | %s | %s | %s   want %s | %s | %s | %s\n' "$path" "$status" "$type" "$got_body" "$got_cache" "$want_status" "$want_type" "$want_body" "$want_cache"
    failures=$((failures + 1))
  fi
}

real_files() {
  check /                              200 "text/html"               file  revalidate
  check /guides/x                      200 "text/html"               file  revalidate
  check /guides/x/                     200 "text/html"               file  revalidate
  check /api.md                        200 "text/markdown"           file  revalidate
  check /llms.txt                      200 "text/plain"              file  revalidate
  check /sitemap.xml                   200 "application/xml"         file  revalidate
  check /fonts/x.woff2                 200 "font/woff2"              file  revalidate
  check /_astro/a.Ab12Cd34.js          200 "application/javascript"  file  immutable
  check /_astro/b.Ef56Gh78.css         200 "text/css"                file  immutable
}
# A miss that is not asking for a page: always the plain answer, never HTML, never kept.
file_misses() {
  check /missing.js                    404 "text/plain"              plain revalidate
  check /docs/missing.md               404 "text/plain"              plain revalidate
  check /skills/cswarm/OTHER.md        404 "text/plain"              plain revalidate
  check /missing.txt                   404 "text/plain"              plain revalidate
  check /missing.json                  404 "text/plain"              plain revalidate
  check /missing.xml                   404 "text/plain"              plain revalidate
  check /missing.png                   404 "text/plain"              plain revalidate
  check /install.sh                    404 "text/plain"              plain revalidate
  check /api.md/                       200 "text/markdown"           file  revalidate
  check /missing.md/                   404 "text/plain"              plain revalidate
  check /_astro/missing.Zz99Yy88.js    404 "text/plain"              plain revalidate
  check /_astro/missing.Zz99Yy88.css   404 "text/plain"              plain revalidate
  check /_astro/                       404 "text/plain"              plain revalidate
  check /_astro/nodots                 404 "text/plain"              plain revalidate
  check /fonts/missing.woff2           404 "text/plain"              plain revalidate
  check /fonts/nodots                  404 "text/plain"              plain revalidate
  check /.env                          404 "text/plain"              plain revalidate
}

echo "--- the release has no /404.html: every miss is the plain answer"
real_files
file_misses
check /nope                            404 "text/plain"              plain revalidate
check /nope/deep/er/                   404 "text/plain"              plain revalidate

printf '<!doctype html><title>Page not found</title><h1>We cannot find that page.</h1>\n' > "$site/404.html"
echo "--- the release has /404.html: page requests get it with status 404; file requests do not"
real_files
file_misses
check /nope                            404 "text/html"               page  revalidate
check /nope/                           404 "text/html"               page  revalidate
check /nope/deep/er                    404 "text/html"               page  revalidate
check /guides/missing                  404 "text/html"               page  revalidate
check /old-page.html                   404 "text/html"               page  revalidate
check /v1.2/guide                      404 "text/html"               page  revalidate
check /api.md/extra                    404 "text/html"               page  revalidate
check /404                             404 "text/html"               page  revalidate


# --- The TLS block, on its own listener with throwaway certificates -------------------------------------------
# The real file's TLS block is kept; only its three file paths point at certificates made here. It must refuse a
# connection with no client certificate, or with one the trust pool did not sign, and serve one that it did.
kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; pid=""
if ! command -v openssl >/dev/null 2>&1; then
  echo "--- TLS block: SKIPPED, openssl is not installed here"
else
  echo "--- the TLS block: a client certificate from the trust pool is required"
  tls_port="${CHECK_SITE_CADDY_TLS_PORT:-18443}"
  pki="$work/pki"; mkdir -p "$pki"
  quiet() { "$@" > "$work/openssl.log" 2>&1 || { cat "$work/openssl.log" >&2; exit 2; }; }
  quiet openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=check pool CA" -keyout "$pki/ca.key" -out "$pki/ca.pem"
  quiet openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=commonswarm.com" -addext "subjectAltName=DNS:commonswarm.com" -keyout "$pki/site.key" -out "$pki/site.pem"
  quiet openssl req -newkey rsa:2048 -nodes -subj "/CN=check edge client" -keyout "$pki/client.key" -out "$pki/client.csr"
  quiet openssl x509 -req -in "$pki/client.csr" -CA "$pki/ca.pem" -CAkey "$pki/ca.key" -CAserial "$pki/ca.srl" -CAcreateserial -days 2 -out "$pki/client.pem"
  quiet openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=check stranger" -keyout "$pki/stranger.key" -out "$pki/stranger.pem"
  {
    printf '{\n\tadmin off\n\tauto_https off\n}\n'
    sed -e "s|^https://commonswarm.com, .* {\$|https://commonswarm.com:$tls_port {|" \
        -e "s|/etc/caddy/certs/commonswarm.com.pem|$pki/site.pem|" \
        -e "s|/etc/caddy/certs/commonswarm.com.key|$pki/site.key|" \
        -e "s|/etc/caddy/aop/commonswarm.com/ca.pem|$pki/ca.pem|" \
        -e "s|root \* /srv/commonswarm/site/current|root * $site|" \
        "$source_file" | sed -n '/^https:\/\/commonswarm\.com:/,$p'
  } > "$work/Caddyfile.tls"
  grep -q "client_auth" "$work/Caddyfile.tls" || { echo "the file has no client_auth block to check" >&2; exit 2; }
  if grep -n "/etc/caddy/" "$work/Caddyfile.tls" >&2; then echo "a production path is left in the TLS copy; has the block changed?" >&2; exit 2; fi
  "$caddy" validate --adapter caddyfile --config "$work/Caddyfile.tls" > "$work/validate-tls.log" 2>&1 || { cat "$work/validate-tls.log" >&2; exit 2; }
  "$caddy" run --adapter caddyfile --config "$work/Caddyfile.tls" > "$work/run-tls.log" 2>&1 &
  pid=$!
  to() { rm -f "$work/body"; curl -s -o "$work/body" -w '%{http_code}' --max-time 5 --cacert "$pki/site.pem" --resolve "commonswarm.com:$tls_port:127.0.0.1" "$@" "https://commonswarm.com:$tls_port/" || true; }
  for _ in $(seq 1 50); do [ "$(to --cert "$pki/client.pem" --key "$pki/client.key")" = 200 ] && break; sleep 0.1; done
  tls_check() {
    local name="$1" want="$2"; shift 2
    local got; got="$(to "$@")"
    if { [ "$want" = served ] && [ "$got" = 200 ] && grep -q "home" "$work/body" 2>/dev/null; } || { [ "$want" = refused ] && [ "$got" = 000 ] && [ ! -s "$work/body" ]; }; then
      printf 'ok    %-52s %s (%s)\n' "$name" "$want" "$got"
    else
      printf 'FAIL  %-52s got %s, want %s\n' "$name" "$got" "$want"; failures=$((failures + 1))
    fi
  }
  tls_check "client certificate signed by the trust pool" served --cert "$pki/client.pem" --key "$pki/client.key"
  tls_check "no client certificate" refused
  tls_check "client certificate the pool did not sign" refused --cert "$pki/stranger.pem" --key "$pki/stranger.key"
  # Another name in the handshake with this site's Host header must not reach the site without a certificate.
  rm -f "$work/body"
  other="$(curl -s -k -o "$work/body" -w '%{http_code}' --max-time 5 --resolve "other.test:$tls_port:127.0.0.1" -H "Host: commonswarm.com" "https://other.test:$tls_port/" || true)"
  if [ "$other" != 200 ] && ! grep -q "home" "$work/body" 2>/dev/null; then printf 'ok    %-52s %s (%s)\n' "another name in the handshake, this site's Host" "not served" "$other"
  else printf 'FAIL  %-52s got %s with the site body\n' "another name in the handshake, this site's Host" "$other"; failures=$((failures + 1)); fi
fi

if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "all checks passed"
