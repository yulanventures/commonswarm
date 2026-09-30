"""Offline urllib fixture for the whole-block dry run.

The response shapes come from the committed release evidence.  Every request
is recorded without headers or credential values.
"""
from __future__ import annotations

import email.message
import io
import json
import os
import pathlib
import urllib.error
import urllib.request

_real_urlopen = urllib.request.urlopen
_real_build_opener = urllib.request.build_opener


class Response:
    def __init__(self, url: str, status: int, body: bytes, content_type: str):
        self.url = url
        self.status = status
        self.code = status
        self._body = io.BytesIO(body)
        self.headers = email.message.Message()
        self.headers["Content-Type"] = content_type
        self.headers["Server"] = "cloudflare"
        self.headers["CF-Ray"] = "dry-run"

    def read(self, size: int = -1) -> bytes:
        return self._body.read(size)

    @property
    def closed(self) -> bool:
        return self._body.closed

    def close(self) -> None:
        self._body.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
        return False


def _record(url: str, explicit_user_agent: bool, status: int) -> None:
    filename = os.environ.get("BOX_DRY_RUN_STUB_LOG")
    if not filename:
        return
    with open(filename, "a", encoding="utf-8") as handle:
        handle.write(f"python-urllib status={status} explicit_ua={int(explicit_user_agent)} url={url}\n")


def _fixture(request):
    if isinstance(request, str):
        url = request
        headers = {}
    else:
        url = request.full_url
        headers = {key.lower(): value for key, value in request.header_items()}
    explicit = "user-agent" in headers

    method = getattr(request, "method", None) or (request.get_method() if not isinstance(request, str) else "GET")
    data = getattr(request, "data", None)
    if not explicit and any(host in url for host in (
        "api.commonswarm.com", "edge-staging.commonswarm.com", "commonswarm.com"
    )) and "mcp.commonswarm.com" not in url:
        status, body, content_type = 403, b"error code: 1010\n", "text/plain"
    elif any(url.endswith(path) for path in (
        "/.well-known/oauth-authorization-server",
        "/.well-known/openid-configuration",
    )):
        base = "https://mcp.commonswarm.com"
        status = 200
        body = json.dumps({
            "issuer": base,
            "authorization_endpoint": base + "/authorize",
            "token_endpoint": base + "/token",
            "jwks_uri": base + "/jwks",
        }).encode()
        content_type = "application/json"
    elif "mcp.commonswarm.com/jwks" in url:
        status = 200
        body = json.dumps({"keys": [{
            "kty": "EC", "crv": "P-256", "alg": "ES256", "kid": "dry-run",
            "x": "x", "y": "y",
        }]}).encode()
        content_type = "application/jwk-set+json"
    elif "mcp.commonswarm.com/authorize" in url or "mcp.commonswarm.com/token" in url:
        status = 503
        body = b'{"error":"authorization_service_disabled"}'
        content_type = "application/json"
    elif "/functions/v1/command" in url:
        document = json.loads(data or b"{}")
        kind = document.get("command", {}).get("kind")
        if not kind:
            status, body = 400, b'{"error":"invalid_request"}'
        elif document.get("command_id") and kind != "mint_agent_token":
            status, body = 403, b'{"error":"forbidden"}'
        else:
            status, body = 401, b'{"error":"unauthenticated"}'
        content_type = "application/json"
    elif any(path in url for path in (
        "/functions/v1/mcp", "/.well-known/oauth-protected-resource/mcp", "/mcp"
    )):
        status = 503
        body = b'{"error":"feature_disabled","feature":"hosted_mcp","message":"Hosted MCP is not available yet."}'
        content_type = "application/json"
    elif "/functions/v1/h0/agent-doc/smoke" in url:
        status, body, content_type = 200, b'{"ok":true}', "application/json"
    elif "commonswarm.com" in url and url.startswith("https://commonswarm.com"):
        # Public bytes come from the fixture box root only. The Mac lane names its own directory; the box lane
        # names "/" because its fixture is the runner's real, guarded root. A missing name is a refusal, never a
        # read of whatever /srv/commonswarm/site/current the host happens to have.
        box_root = os.environ.get("BOX_DRY_RUN_BOX_ROOT")
        if not box_root:
            raise SystemExit("UNPRODUCED fixture box root")
        root = pathlib.Path(box_root) / "srv/commonswarm/site/current"
        suffix = url.split("commonswarm.com", 1)[1].split("?", 1)[0]
        path = root / suffix.lstrip("/")
        if path.is_dir():
            path = path / "index.html"
        if path.is_file():
            content_type = {".html": "text/html", ".css": "text/css", ".js": "text/javascript"}.get(
                path.suffix, "application/octet-stream")
            status, body = 200, path.read_bytes()
        else:
            status, body, content_type = 404, b"", "text/plain"
    elif "/rest/v1/" in url:
        status, body, content_type = 200, b"[]", "application/json"
    else:
        status, body, content_type = 200, b'{"ok":true}', "application/json"

    if method == "HEAD":
        body = b""
    _record(url, explicit, status)
    response = Response(url, status, body, content_type)
    if status >= 400:
        raise urllib.error.HTTPError(url, status, "dry-run fixture", response.headers, response)
    return response


def urlopen(request, *args, **kwargs):
    return _fixture(request)


class Opener:
    def open(self, request, *args, **kwargs):
        return _fixture(request)


def build_opener(*_handlers):
    return Opener()


urllib.request.urlopen = urlopen
urllib.request.build_opener = build_opener
