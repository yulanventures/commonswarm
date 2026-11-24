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
#
# Every listener it starts is bound to 127.0.0.1 and the script checks that before it serves anything.
# It needs curl and openssl. The TLS block is part of the check, so without openssl the check fails;
# it never passes with the client-certificate rule untested.
set -euo pipefail

caddy="${1:?usage: check-site-caddy.sh /path/to/caddy}"
for tool in curl openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FAIL: $tool is required. Without it the check is incomplete, so it does not pass." >&2; exit 2; }
done
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
mkdir -p "$site/guides/x" "$site/_astro" "$site/fonts" "$site/skills/cswarm" "$site/next/assets" "$site/next/fonts"
printf '<!doctype html><title>home</title>home\n' > "$site/index.html"
printf '<!doctype html><title>guide</title>guide\n' > "$site/guides/x/index.html"
printf 'console.log(1)\n' > "$site/_astro/a.Ab12Cd34.js"
printf 'a{}\n' > "$site/_astro/b.Ef56Gh78.css"
printf 'font\n' > "$site/fonts/x.woff2"
printf '<!doctype html><title>next</title>next\n' > "$site/next/index.html"
printf 'console.log("next")\n' > "$site/next/assets/index-Ab12Cd34.js"
printf '.next{}\n' > "$site/next/assets/index-Ef56Gh78.css"
printf 'font\n' > "$site/next/fonts/inter-latin.woff2"
printf '# api\n' > "$site/api.md"
printf 'llms\n' > "$site/llms.txt"
printf '# skill\n' > "$site/skills/cswarm/SKILL.md"
printf '<?xml version="1.0"?><urlset/>\n' > "$site/sitemap.xml"

# The real file with only its address and root replaced and its TLS block (certificate and client-certificate check) removed.
grep -q '^https://commonswarm.com, .* {$' "$source_file" || { echo "could not find the site block's first line; has it changed?" >&2; exit 2; }
# The site block's own lines, without its first (address) line. The fixtures write their own address and a bind.
site_block_body() { sed -n '/^https:\/\/commonswarm\.com, .* {$/,$p' "$source_file" | sed -e '1d'; }
# Stops unless every listener in the adapted config is on 127.0.0.1. A fixture must never listen on another interface.
loopback_only() {
  local listens address
  listens="$("$caddy" adapt --adapter caddyfile --config "$1" 2>/dev/null | tr -d ' \n\t' | grep -o '"listen":\[[^]]*\]' | grep -o '"[^"]*"' | tr -d '"' | grep -v '^listen$' || true)"
  [ -n "$listens" ] || { echo "could not read the listener addresses of $1" >&2; exit 2; }
  for address in $listens; do
    case "$address" in 127.0.0.1:*) ;; *) echo "FAIL: fixture listener $address is not bound to 127.0.0.1" >&2; exit 2 ;; esac
  done
  echo "listeners: $(echo $listens)"
}
# Fixture requests go straight to loopback, whatever proxy settings the environment carries.
local_curl() { curl --noproxy '*' "$@"; }

{
  printf '{\n\tadmin off\n\tauto_https off\n}\n'
  printf 'http://127.0.0.1:%s {\n\tbind 127.0.0.1\n' "$port"
  site_block_body | sed -e '/^[[:space:]]tls .*{$/,/^[[:space:]]}$/d' \
      -e '/^[[:space:]]*tls /d' \
      -e "s|root \* /srv/commonswarm/site/current|root * $site|"
} > "$work/Caddyfile"
# The loopback copy is plain HTTP: no certificate and no client-certificate check may be left in it.
if grep -n -E '^[[:space:]]*(tls|client_auth|trust_pool|mode require_and_verify)' "$work/Caddyfile" >&2; then
  echo "the TLS block was not fully removed from the loopback copy; has its shape changed?" >&2; exit 2
fi

echo "caddy: $("$caddy" version)"
"$caddy" validate --adapter caddyfile --config "$work/Caddyfile" > "$work/validate.log" 2>&1 || { cat "$work/validate.log" >&2; exit 2; }
loopback_only "$work/Caddyfile"
"$caddy" run --adapter caddyfile --config "$work/Caddyfile" > "$work/run.log" 2>&1 &
pid=$!
for _ in $(seq 1 50); do local_curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.1; done

failures=0
# check <path> <status> <content-type prefix> <body: file|page|plain> <cache: revalidate|immutable|no-cache> [sec: none|next]
check() {
  local path="$1" want_status="$2" want_type="$3" want_body="$4" want_cache="$5" want_sec="${6:-none}"
  local status type cache csp nosniff referrer body got_body got_cache got_sec
  status="$(local_curl -s -D "$work/headers" -o "$work/body" -w '%{http_code}' "http://127.0.0.1:$port$path")"
  type="$(tr -d '\r' < "$work/headers" | awk -F': ' 'tolower($1)=="content-type"{print $2}')"
  cache="$(tr -d '\r' < "$work/headers" | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"
  csp="$(tr -d '\r' < "$work/headers" | awk -F': ' 'tolower($1)=="content-security-policy"{print $2}')"
  nosniff="$(tr -d '\r' < "$work/headers" | awk -F': ' 'tolower($1)=="x-content-type-options"{print $2}')"
  referrer="$(tr -d '\r' < "$work/headers" | awk -F': ' 'tolower($1)=="referrer-policy"{print $2}')"
  body="$(head -c 200 "$work/body")"
  case "$body" in
    *"Page not found"*) got_body=page ;;
    "The page could not be found"*) got_body=plain ;;
    *) got_body=file ;;
  esac
  case "$cache" in
    "public, max-age=0, must-revalidate") got_cache=revalidate ;;
    "public, max-age=31536000, immutable") got_cache=immutable ;;
    "no-cache") got_cache=no-cache ;;
    *) got_cache="other($cache)" ;;
  esac
  if [ "$csp" = "frame-ancestors 'none'" ] && [ "$nosniff" = "nosniff" ] && [ "$referrer" = "no-referrer" ]; then
    got_sec=next
  elif [ -z "$csp" ] && [ -z "$nosniff" ] && [ -z "$referrer" ]; then
    got_sec=none
  else
    got_sec="other(csp=$csp,nosniff=$nosniff,ref=$referrer)"
  fi
  if [ "$status" = "$want_status" ] && [ "${type#"$want_type"}" != "$type" ] && [ "$got_body" = "$want_body" ] && [ "$got_cache" = "$want_cache" ] && [ "$got_sec" = "$want_sec" ]; then
    printf 'ok    %-36s %s %-28s %-5s %-10s %s\n' "$path" "$status" "$type" "$got_body" "$got_cache" "$got_sec"
  else
    printf 'FAIL  %-36s got %s | %s | %s | %s | %s   want %s | %s | %s | %s | %s\n' "$path" "$status" "$type" "$got_body" "$got_cache" "$got_sec" "$want_status" "$want_type" "$want_body" "$want_cache" "$want_sec"
    failures=$((failures + 1))
  fi
}

real_files() {
  check /                                200 "text/html"               file  revalidate none
  check /guides/x                        200 "text/html"               file  revalidate none
  check /guides/x/                       200 "text/html"               file  revalidate none
  check /api.md                          200 "text/markdown"           file  revalidate none
  check /llms.txt                        200 "text/plain"              file  revalidate none
  check /sitemap.xml                     200 "application/xml"         file  revalidate none
  check /fonts/x.woff2                   200 "font/woff2"              file  revalidate none
  check /_astro/a.Ab12Cd34.js            200 "application/javascript"  file  immutable  none
  check /_astro/b.Ef56Gh78.css           200 "text/css"                file  immutable  none
  check /next                            200 "text/html"               file  no-cache   next
  check /next/                           200 "text/html"               file  no-cache   next
  check /next/index.html                 200 "text/html"               file  no-cache   next
  check /next/assets/index-Ab12Cd34.js   200 "application/javascript"  file  immutable  next
  check /next/assets/index-Ef56Gh78.css  200 "text/css"                file  immutable  next
  check /next/fonts/inter-latin.woff2    200 "font/woff2"              file  revalidate next
}
# A miss that is not asking for a page: always the plain answer, never HTML, never kept.
file_misses() {
  check /missing.js                      404 "text/plain"              plain revalidate none
  check /docs/missing.md                 404 "text/plain"              plain revalidate none
  check /skills/cswarm/OTHER.md          404 "text/plain"              plain revalidate none
  check /missing.txt                     404 "text/plain"              plain revalidate none
  check /missing.json                    404 "text/plain"              plain revalidate none
  check /missing.xml                     404 "text/plain"              plain revalidate none
  check /missing.png                     404 "text/plain"              plain revalidate none
  check /install.sh                      404 "text/plain"              plain revalidate none
  check /api.md/                         200 "text/markdown"           file  revalidate none
  check /missing.md/                     404 "text/plain"              plain revalidate none
  check /_astro/missing.Zz99Yy88.js      404 "text/plain"              plain revalidate none
  check /_astro/missing.Zz99Yy88.css     404 "text/plain"              plain revalidate none
  check /_astro/                         404 "text/plain"              plain revalidate none
  check /_astro/nodots                   404 "text/plain"              plain revalidate none
  check /fonts/missing.woff2             404 "text/plain"              plain revalidate none
  check /fonts/nodots                    404 "text/plain"              plain revalidate none
  check /.env                            404 "text/plain"              plain revalidate none
  check /next/assets/missing.Zz99Yy88.js  404 "text/plain"             plain revalidate next
  check /next/assets/missing.Zz99Yy88.css 404 "text/plain"             plain revalidate next
  check /next/assets/                    404 "text/plain"              plain revalidate next
  check /next/assets/nodots              404 "text/plain"              plain revalidate next
  check /next/fonts/missing.woff2        404 "text/plain"              plain revalidate next
  check /next/fonts/nodots               404 "text/plain"              plain revalidate next
  check /next/.env                       404 "text/plain"              plain revalidate next
}

echo "--- the release has no /404.html: every miss is the plain answer"
real_files
file_misses
check /nope                            404 "text/plain"              plain revalidate none
check /nope/deep/er/                   404 "text/plain"              plain revalidate none
check /next-other                      404 "text/plain"              plain revalidate none
check /next/deep/missing               404 "text/plain"              plain revalidate next

printf '<!doctype html><title>Page not found</title><h1>We cannot find that page.</h1>\n' > "$site/404.html"
echo "--- the release has /404.html: page requests get it with status 404; file requests do not"
real_files
file_misses
check /nope                            404 "text/html"               page  revalidate none
check /nope/                           404 "text/html"               page  revalidate none
check /nope/deep/er                    404 "text/html"               page  revalidate none
check /guides/missing                  404 "text/html"               page  revalidate none
check /old-page.html                   404 "text/html"               page  revalidate none
check /v1.2/guide                      404 "text/html"               page  revalidate none
check /api.md/extra                    404 "text/html"               page  revalidate none
check /404                             404 "text/html"               page  revalidate none
check /next-other                      404 "text/html"               page  revalidate none
check /next/deep/missing               404 "text/html"               page  revalidate next

rm -rf "$site/next/index.html" "$site/next/fonts"
echo "--- post-rollback state (retained /next/assets/*, no /next/index.html or /next/fonts): /next pages return 404; retained assets return 200"
check /next                            404 "text/html"               page  revalidate next
check /next/                           404 "text/html"               page  revalidate next
check /next/index.html                 404 "text/html"               page  revalidate next
check /next/assets/index-Ab12Cd34.js   200 "application/javascript"  file  immutable  next
check /next/assets/index-Ef56Gh78.css  200 "text/css"                file  immutable  next
check /next/assets/                    404 "text/plain"              plain revalidate next
check /next/assets/missing.Zz99Yy88.js  404 "text/plain"             plain revalidate next
check /next/fonts/inter-latin.woff2    404 "text/plain"              plain revalidate next

rm -rf "$site/next"
echo "--- the release has no /next: /next returns the site's normal 404"
check /next                            404 "text/html"               page  revalidate next
check /next/                           404 "text/html"               page  revalidate next
check /next/index.html                 404 "text/html"               page  revalidate next
check /next/assets/index-Ab12Cd34.js   404 "text/plain"              plain revalidate next


# --- The TLS block, on its own listener with throwaway certificates -------------------------------------------
# The real file's TLS block is kept; only its three file paths point at certificates made here. It must refuse a
# connection with no client certificate, or with one the trust pool did not sign, and serve one that it did.
kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; pid=""
{
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
    printf 'https://commonswarm.com:%s {\n\tbind 127.0.0.1\n' "$tls_port"
    site_block_body | sed -e "s|/etc/caddy/certs/commonswarm.com.pem|$pki/site.pem|" \
        -e "s|/etc/caddy/certs/commonswarm.com.key|$pki/site.key|" \
        -e "s|/etc/caddy/aop/commonswarm.com/ca.pem|$pki/ca.pem|" \
        -e "s|root \* /srv/commonswarm/site/current|root * $site|"
  } > "$work/Caddyfile.tls"
  grep -q "client_auth" "$work/Caddyfile.tls" || { echo "the file has no client_auth block to check" >&2; exit 2; }
  if grep -n "/etc/caddy/" "$work/Caddyfile.tls" >&2; then echo "a production path is left in the TLS copy; has the block changed?" >&2; exit 2; fi
  "$caddy" validate --adapter caddyfile --config "$work/Caddyfile.tls" > "$work/validate-tls.log" 2>&1 || { cat "$work/validate-tls.log" >&2; exit 2; }
  loopback_only "$work/Caddyfile.tls"
  "$caddy" run --adapter caddyfile --config "$work/Caddyfile.tls" > "$work/run-tls.log" 2>&1 &
  pid=$!
  to() { rm -f "$work/body"; local_curl -s -o "$work/body" -w '%{http_code}' --max-time 5 --cacert "$pki/site.pem" --resolve "commonswarm.com:$tls_port:127.0.0.1" "$@" "https://commonswarm.com:$tls_port/" || true; }
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
  other="$(local_curl -s -k -o "$work/body" -w '%{http_code}' --max-time 5 --resolve "other.test:$tls_port:127.0.0.1" -H "Host: commonswarm.com" "https://other.test:$tls_port/" || true)"
  if [ "$other" != 200 ] && ! grep -q "home" "$work/body" 2>/dev/null; then printf 'ok    %-52s %s (%s)\n' "another name in the handshake, this site's Host" "not served" "$other"
  else printf 'FAIL  %-52s got %s with the site body\n' "another name in the handshake, this site's Host" "$other"; failures=$((failures + 1)); fi
}

if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "all checks passed"
