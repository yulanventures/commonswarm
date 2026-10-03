"""Offline urllib fixture and fixture-ownership adapter for the whole-block dry run.

The response shapes come from the committed release evidence.  Every request
is recorded without headers or credential values.
"""
from __future__ import annotations

import email.message
import grp
import importlib.util
import io
import json
import os
import pathlib
import pwd
import sys
import urllib.error
import urllib.parse
import urllib.request

_real_urlopen = urllib.request.urlopen
_real_build_opener = urllib.request.build_opener

# Fixture construction replaces this in a private copy for the site sequence.
# This is harness state, never a value supplied by the plan's environment.
_SITE_MCP = False  # fixture-site-mcp


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
    parsed = urllib.parse.urlsplit(url)
    path = parsed.path
    if _SITE_MCP and (parsed.hostname == "mcp.commonswarm.com" or
                      path.startswith("/.well-known/oauth-protected-resource/") or
                      path == "/mcp" or path.startswith("/mcp/")):
        # Source-derived site GO request/response shapes, not a live observation:
        # docs/evidence/2026-09-28-site-hm8/SITE-RELEASE.md:768-793
        # requires these two public probes after MCP is
        # enabled. Window A's historical dark-route responses stay below.
        # The real plan Python still validates status, media type and resource.
        expected_headers = {"user-agent": "commonswarm-release-probe/1.0", "accept": "application/json",
                            "content-type": "application/json", "accept-encoding": "identity"}
        resource = "https://mcp.commonswarm.com/mcp"
        if headers == expected_headers and url == "https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp" and method == "GET" and data is None:
            status, body, content_type = 200, json.dumps({"resource": resource}).encode(), "application/json"
        elif headers == expected_headers and url == resource and method == "POST" and data == b"{}":
            status, body, content_type = 401, b"", "application/json"
        else:
            sys.stderr.write("UNPRODUCED site MCP request form\n")
            raise SystemExit(69)
    elif not explicit and any(host in url for host in (
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


# ---------------------------------------------------------------------------------------------------------
# Fixture ownership.
#
# The Mac lane's fixture box root holds files the Mac user owns. The ownership the box holds for them (measured
# in M6/M18: commonswarm:commonswarm on the edge environment file) is kept in the sidecar the box userland
# writes, `.fixture/owners.json`, which `stat -c %U` already reads. A plan's Python that asks the same question
# through pathlib/os.stat and pwd.getpwuid must get the same answer, and nothing more:
#
#   * only a path that resolves inside BOX_DRY_RUN_BOX_ROOT is adapted, and only its st_uid and st_gid; mode,
#     type, size, times and symlink behavior are the real ones;
#   * a recorded owner is answered with the box's own account ids (the table of the box userland, M3), and
#     pwd.getpwuid/grp.getgrgid answer only an id this adapter issued for a recorded path;
#   * a fixture path nothing recorded gets an id that the lookup refuses (69), the way `stat -c %U` does;
#   * every other path and every other lookup is the host's, unchanged;
#   * the adapter is inactive unless the Mac lane's own variables name a fixture box root other than "/": the box
#     lane runs real Linux metadata and is not touched.
# Path-based stat/lstat and pathlib.Path.stat/lstat are adapted; file-descriptor and directory-entry stats are
# not, so they keep the host's metadata and never claim a recorded owner.
# ---------------------------------------------------------------------------------------------------------

_USERLAND = None
_OWNERS_CACHE = (None, {})
_ISSUED = {"user": {}, "group": {}}
_UNRECORDED = {}
_ADAPTING = []
_UNRECORDED_BASE = 0x7F000000
_STAT_EXTRAS = (
    "st_atime", "st_mtime", "st_ctime", "st_atime_ns", "st_mtime_ns", "st_ctime_ns",
    "st_blksize", "st_blocks", "st_rdev", "st_flags", "st_gen", "st_birthtime",
)
# Measured passwd fields of the same accounts (M3); the group members list is empty there.
_ACCOUNT_HOMES = {"root": "/root", "ops": "/home/ops", "commonswarm": "/home/commonswarm"}


def _load_userland():
    if os.environ.get("BOX_DRY_RUN_PART") != "mac":
        return None
    root = os.environ.get("BOX_DRY_RUN_BOX_ROOT", "")
    userland = os.environ.get("BOX_DRY_RUN_USERLAND", "")
    if not root or not os.path.isdir(root) or os.path.realpath(root) == "/" or not os.path.isfile(userland):
        return None
    spec = importlib.util.spec_from_file_location("box_userland", userland)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_USERLAND = _load_userland()
_real_os_stat = os.stat
_real_os_lstat = os.lstat
_real_path_stat = pathlib.Path.stat
_real_path_lstat = pathlib.Path.lstat
_real_getpwuid = pwd.getpwuid
_real_getgrgid = grp.getgrgid


def _owners():
    global _OWNERS_CACHE
    sidecar = _USERLAND.owners_path()
    try:
        info = _real_os_stat(sidecar)
        signature = (info.st_ino, info.st_size, info.st_mtime_ns)
    except FileNotFoundError:
        signature = None
    if _OWNERS_CACHE[0] != signature or signature is None:
        _OWNERS_CACHE = (signature, _USERLAND.load_owners())
    return _OWNERS_CACHE[1]


def _unrecorded(path):
    for identifier, named in _UNRECORDED.items():
        if named == path:
            return identifier
    identifier = _UNRECORDED_BASE + len(_UNRECORDED)
    _UNRECORDED[identifier] = path
    return identifier


def _refuse_unrecorded(identifier):
    sys.stderr.write("UNPRODUCED owner of %s: nothing in the fixture recorded it\n" % _UNRECORDED[identifier])
    raise SystemExit(69)


def _adapt(result, path, follow):
    # Resolving a path and reading the sidecar stat their parts. Those stats are the host's own, never adapted again.
    if _ADAPTING:
        return result
    _ADAPTING.append(path)
    try:
        return _adapted(result, os.fsdecode(path), follow)
    finally:
        _ADAPTING.pop()


def _adapted(result, path, follow):
    key = _USERLAND.fixture_key(path, follow)
    if key is None:
        return result
    owner, _, group = _owners().get(key, "").partition(":")
    if owner in _USERLAND.USERS and group in _USERLAND.USERS:
        uid, gid = _USERLAND.USERS[owner], _USERLAND.USERS[group]
        _ISSUED["user"][uid] = owner
        _ISSUED["group"][gid] = group
    else:
        uid = gid = _unrecorded(path)
    fields = list(result)
    fields[4], fields[5] = uid, gid
    return os.stat_result(fields, {name: getattr(result, name) for name in _STAT_EXTRAS if hasattr(result, name)})


def _path_argument(path, dir_fd):
    return dir_fd is None and isinstance(path, (str, bytes, os.PathLike))


def _os_stat(path, *, dir_fd=None, follow_symlinks=True):
    result = _real_os_stat(path, dir_fd=dir_fd, follow_symlinks=follow_symlinks)
    return _adapt(result, path, follow_symlinks) if _path_argument(path, dir_fd) else result


def _os_lstat(path, *, dir_fd=None):
    result = _real_os_lstat(path, dir_fd=dir_fd)
    return _adapt(result, path, False) if _path_argument(path, dir_fd) else result


def _path_stat(self, *args, **kwargs):
    return _adapt(_real_path_stat(self, *args, **kwargs), self, kwargs.get("follow_symlinks", True))


def _path_lstat(self):
    return _adapt(_real_path_lstat(self), self, False)


def _getpwuid(uid):
    if uid in _UNRECORDED:
        _refuse_unrecorded(uid)
    if uid in _ISSUED["user"]:
        name = _ISSUED["user"][uid]
        return pwd.struct_passwd((name, "*", uid, uid, "", _ACCOUNT_HOMES[name], "/bin/bash"))
    return _real_getpwuid(uid)


def _getgrgid(gid):
    if gid in _UNRECORDED:
        _refuse_unrecorded(gid)
    if gid in _ISSUED["group"]:
        return grp.struct_group((_ISSUED["group"][gid], "*", gid, []))
    return _real_getgrgid(gid)


if _USERLAND is not None:
    os.stat = _os_stat
    os.lstat = _os_lstat
    pathlib.Path.stat = _path_stat
    pathlib.Path.lstat = _path_lstat
    pwd.getpwuid = _getpwuid
    grp.getgrgid = _getgrgid
