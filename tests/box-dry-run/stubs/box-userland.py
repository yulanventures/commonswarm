#!/usr/bin/env python3
"""Box-shaped userland for the Mac dry run.

The ssh stub runs every box script against a fixture box root: a directory under the dry run's own
temporary directory (BOX_DRY_RUN_BOX_ROOT). The box runs GNU bash 5.2, coreutils 9.4 and findutils 4.9.0
(M4 in docs/evidence/2026-09-29-box-facts/box-facts-measured.json:57). The Mac has BSD tools. This file gives
a box script the GNU behavior it asks for, and only that behavior:

  * every accepted command shape is listed below; any other shape exits 69 with the stub message;
  * the fixture box has one clock (BOX_DRY_RUN_BOX_CLOCK); date arithmetic is computed from it, never canned;
  * ownership that the real box would hold (install -o root, chown) is kept in a sidecar file inside the
    fixture box root, because the Mac user cannot chown; stat -c reads it back, and an owner nothing recorded
    is refused (69) instead of guessed;
  * a script that is not root cannot change ownership, exactly as on the box;
  * `sha256sum --check` hashes the fixture's own bytes against the manifest and exits as GNU does (1 for a digest
    that differs, a file that cannot be read, a malformed line under --strict, or no checksum line at all); a
    manifest or listed path outside the fixture box root is refused (69), never read.

Path rewriting and output stripping for the ssh boundary live here too (`rewrite` and `strip`), so the
Mac-to-box path mapping has one implementation.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import shutil
import stat as statmod
import subprocess
import sys
import tempfile

STUB_PREFIX = "unhandled dry-run stub: "


def refuse(command: str, argv: list[str]) -> None:
    sys.stderr.write(STUB_PREFIX + command + "".join(" " + item for item in argv) + "\n")
    raise SystemExit(69)


def box_root() -> str:
    value = os.environ.get("BOX_DRY_RUN_BOX_ROOT", "")
    if not value or not os.path.isdir(value):
        sys.stderr.write("UNPRODUCED fixture box root\n")
        raise SystemExit(69)
    return os.path.realpath(value)


# ---------------------------------------------------------------------------------------------------------
# Path rewriting: Mac side text -> box side text, and box output -> Mac side text.
# ---------------------------------------------------------------------------------------------------------

BOX_PREFIXES = r"tmp|run|etc|var|usr/local|home|srv|root|opt|mnt"
BOX_PATH = re.compile(r"(?<![\w.@~/$-])(/(?:%s))(?=/|[^\w.-]|$)" % BOX_PREFIXES)
MAC_TMP_TOKEN = "@@BOX_DRY_RUN_MAC_TMP@@"
FIXTURE_ROOT_TOKEN = "@@BOX_DRY_RUN_FIXTURE_ROOT@@"


def looks_binary(data: bytes) -> bool:
    return b"\0" in data


def rewrite(data: bytes) -> bytes:
    """Map a text that is bound for the box onto the fixture box root."""
    if looks_binary(data):
        return data
    root = box_root()
    text = data.decode("utf-8", "surrogateescape")
    # Sourced files can already contain projected paths. Do not prefix them a
    # second time (including when the fixture root itself starts with /tmp).
    for variant in sorted({root, os.environ.get("BOX_DRY_RUN_BOX_ROOT", root)}, key=len, reverse=True):
        text = re.sub(re.escape(variant) + r"(?=/|[^\w.-]|$)", FIXTURE_ROOT_TOKEN, text)
    mac_tmp = os.environ.get("BOX_DRY_RUN_MAC_TMP", "")
    if mac_tmp:
        # The Mac block's own /tmp was mapped into the dry run's temporary directory before it ran. Anything
        # that crosses the ssh boundary means the BOX's /tmp, so map it back before the box mapping.
        for variant in {mac_tmp, os.path.realpath(mac_tmp)}:
            text = text.replace(variant + "/", MAC_TMP_TOKEN + "/")
    text = BOX_PATH.sub(lambda match: root + match.group(1), text)
    text = text.replace(MAC_TMP_TOKEN + "/", root + "/tmp/")
    text = text.replace(FIXTURE_ROOT_TOKEN, root)
    return text.encode("utf-8", "surrogateescape")


def cmd_source_file(argv: list[str]) -> None:
    """Project sourced text through the same mapping as ssh script text."""
    if len(argv) != 1:
        refuse("source-file", argv)
    root = box_root()
    path = os.path.realpath(argv[0])
    if not path.startswith(root + "/"):
        sys.stderr.write("REFUSE sourced file outside the fixture box root: " + path + "\n")
        raise SystemExit(69)
    with open(path, "rb") as handle:
        data = rewrite(handle.read())
    # A mapped path must still stay inside the root after traversal and symlinks resolve.
    for match in re.finditer(re.escape(root) + r"/[^\s\"'`;|<>()]+", data.decode("utf-8", "surrogateescape")):
        resolved = os.path.realpath(match.group())
        if resolved != root and not resolved.startswith(root + "/"):
            sys.stderr.write("REFUSE sourced box path outside the fixture box root: " + match.group() + "\n")
            raise SystemExit(69)
    # Preserve BASH_SOURCE's directory for libraries that find siblings through it.
    descriptor, copy = tempfile.mkstemp(prefix=".box-source-", dir=os.path.dirname(path))
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)
    sys.stdout.write(copy + "\n")


def strip(data: bytes) -> bytes:
    """Show the box's paths to the Mac as the box has them."""
    if looks_binary(data):
        return data
    root = box_root()
    text = data.decode("utf-8", "surrogateescape")
    variants = {root, os.path.realpath(root)}
    root_alias = os.environ.get("BOX_DRY_RUN_BOX_ROOT", "")
    if root_alias:
        variants.add(root_alias)
    for variant in sorted(variants, key=len, reverse=True):
        text = text.replace(variant + "/", "/").replace(variant, "/")
    return text.encode("utf-8", "surrogateescape")


# ---------------------------------------------------------------------------------------------------------
# Identity and ownership.
# ---------------------------------------------------------------------------------------------------------

# The box's own account ids, as measured (M3: getent passwd/group root commonswarm caddy ops). A same-named group
# holds the same number, so one table serves owners and groups.
USERS = {"root": 0, "ops": 1000, "commonswarm": 1002}


def remote_user() -> str:
    user = os.environ.get("BOX_DRY_RUN_REMOTE_USER", "")
    if user not in USERS:
        sys.stderr.write("UNPRODUCED fixture remote user\n")
        raise SystemExit(69)
    return user


def owners_path() -> str:
    return os.path.join(box_root(), ".fixture", "owners.json")


def load_owners() -> dict[str, str]:
    try:
        with open(owners_path(), encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return {}


def save_owners(owners: dict[str, str]) -> None:
    os.makedirs(os.path.dirname(owners_path()), exist_ok=True)
    with open(owners_path(), "w", encoding="utf-8") as handle:
        json.dump(owners, handle, sort_keys=True)


def fixture_key(path: str, follow: bool = False) -> str | None:
    """The sidecar key of a path inside the fixture box root, or None for a path outside it.

    The key names the entry itself (its parent is resolved, its own name is not), the way lstat sees it; follow=True
    resolves the entry too, the way stat sees it. A path that resolves outside the root has no key.
    """
    root = box_root()
    absolute = os.path.abspath(path)
    if follow:
        joined = os.path.realpath(absolute)
    else:
        parent = os.path.realpath(os.path.dirname(absolute))
        joined = os.path.join(parent, os.path.basename(absolute))
    if joined != root and not joined.startswith(root + "/"):
        return None
    return os.path.relpath(joined, root)


def owner_key(path: str) -> str:
    key = fixture_key(path)
    if key is None:
        sys.stderr.write("REFUSE path outside the fixture box root: " + path + "\n")
        raise SystemExit(69)
    return key


def record_owner(path: str, owner: str, group: str, recursive: bool = False) -> None:
    owners = load_owners()
    base = owner_key(path)
    owners[base] = owner + ":" + group
    if recursive and os.path.isdir(path) and not os.path.islink(path):
        for directory, names, files in os.walk(path):
            for name in names + files:
                owners[owner_key(os.path.join(directory, name))] = owner + ":" + group
    save_owners(owners)


def require_ownership_right(command: str, owner: str | None, group: str | None, target: str) -> None:
    user = remote_user()
    if user == "root":
        return
    if (owner and owner != user) or (group and group != user):
        sys.stderr.write("%s: changing ownership of '%s': Operation not permitted\n" % (command, target))
        raise SystemExit(1)


def parse_owner_spec(spec: str) -> tuple[str | None, str | None]:
    owner, _, group = spec.partition(":")
    for name in (owner, group):
        if name and name not in USERS:
            sys.stderr.write("chown: invalid user: '%s'\n" % spec)
            raise SystemExit(1)
    return owner or None, group or None


# ---------------------------------------------------------------------------------------------------------
# Commands.
# ---------------------------------------------------------------------------------------------------------

def fixture_clock() -> datetime.datetime:
    text = os.environ.get("BOX_DRY_RUN_BOX_CLOCK", "")
    try:
        return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        sys.stderr.write("UNPRODUCED fixture box clock\n")
        raise SystemExit(69)


RELATIVE = re.compile(r"^\s*(?:(?P<anchor>\S+)\s+)?(?P<sign>[+-])\s*(?P<count>\d+)\s+(?P<unit>second|minute|hour|day)s?\s*$")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def parse_date_operand(text: str) -> datetime.datetime:
    match = RELATIVE.match(text)
    if match:
        anchor = match.group("anchor")
        if anchor is None:
            base = fixture_clock()
        elif ISO.match(anchor):
            base = datetime.datetime.strptime(anchor, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
        else:
            raise ValueError(text)
        seconds = int(match.group("count")) * {"second": 1, "minute": 60, "hour": 3600, "day": 86400}[match.group("unit")]
        return base + datetime.timedelta(seconds=seconds if match.group("sign") == "+" else -seconds)
    if ISO.match(text):
        return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    if re.fullmatch(r"@\d+", text):
        return datetime.datetime.fromtimestamp(int(text[1:]), datetime.timezone.utc)
    raise ValueError(text)


DATE_DIRECTIVES = set("YmdHMSTZzsFjaAbBeyIpDR%")  # the strftime directives GNU date and Python share


def cmd_date(argv: list[str]) -> None:
    utc = False
    operand = None
    fmt = None
    index = 0
    while index < len(argv):
        item = argv[index]
        if item == "-u":
            utc = True
        elif item == "-d" and index + 1 < len(argv):
            operand = argv[index + 1]
            index += 1
        elif item.startswith("+"):
            fmt = item[1:]
        else:
            refuse("date", argv)
        index += 1
    if not utc:
        refuse("date", argv)
    try:
        moment = parse_date_operand(operand) if operand is not None else fixture_clock()
    except ValueError:
        refuse("date", argv)
    if fmt is None:
        fmt = "%a %b %e %H:%M:%S UTC %Y"
    for directive in re.findall(r"%(.)", fmt):
        if directive not in DATE_DIRECTIVES:
            refuse("date", argv)
    fmt = fmt.replace("%s", str(int(moment.timestamp())))
    sys.stdout.write(moment.strftime(fmt.replace("%Z", "UTC").replace("%z", "+0000")) + "\n")


def type_name(mode: int) -> str:
    if statmod.S_ISDIR(mode):
        return "directory"
    if statmod.S_ISLNK(mode):
        return "symbolic link"
    if statmod.S_ISREG(mode):
        return "regular file"
    return "other"


def cmd_stat(argv: list[str]) -> None:
    if len(argv) < 3 or argv[0] != "-c":
        refuse("stat", argv)
    fmt = argv[1]
    for directive in re.findall(r"%(.)", fmt):
        if directive not in "nUGaAsFug%":
            refuse("stat", argv)
    status = 0
    owners = load_owners()
    for path in argv[2:]:
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            sys.stderr.write("stat: cannot statx '%s': No such file or directory\n" % path)
            status = 1
            continue
        recorded = owners.get(owner_key(path))
        needs_owner = "%U" in fmt or "%G" in fmt or "%u" in fmt or "%g" in fmt
        if needs_owner and recorded is None:
            sys.stderr.write("UNPRODUCED owner of %s: nothing in the fixture recorded it\n" % path)
            raise SystemExit(69)
        owner, _, group = (recorded or ":").partition(":")
        out = fmt
        for token, value in (
            ("%n", path), ("%U", owner), ("%G", group), ("%a", format(statmod.S_IMODE(info.st_mode), "o")),
            ("%s", str(info.st_size)), ("%F", type_name(info.st_mode)),
            ("%u", str(USERS.get(owner, 0))), ("%g", str(USERS.get(group, 0))),
        ):
            out = out.replace(token, value)
        out = out.replace("%%", "%")
        sys.stdout.write(out + "\n")
    raise SystemExit(status)


SHA256_CHECK_OPTIONS = ("--check", "-c", "--quiet", "--strict")
# GNU's checksum line: an optional backslash (the name is escaped), 64 hex digits, one space, a mode character
# (space is text, * is binary) and the name.
SHA256_LINE = re.compile(rb"^(\\)?([0-9a-fA-F]{64}) [ *](.+)$", re.DOTALL)


def inside_box(path: str) -> bool:
    root = box_root()
    return os.path.commonpath([root, os.path.realpath(path)]) == root


def unescape_checksum_name(name: bytes) -> bytes | None:
    """GNU escapes a backslash as \\\\, a newline as \\n and a carriage return as \\r in an escaped line; any other escape is malformed."""
    out = bytearray()
    index = 0
    while index < len(name):
        byte = name[index:index + 1]
        if byte != b"\\":
            out += byte
            index += 1
            continue
        following = name[index + 1:index + 2]
        if following == b"\\":
            out += b"\\"
        elif following == b"n":
            out += b"\n"
        elif following == b"r":
            out += b"\r"
        else:
            return None
        index += 2
    return bytes(out)


def file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def plural(count: int, singular: str, many: str) -> str:
    return singular if count == 1 else many


def check_sha256sum(argv: list[str]) -> None:
    """sha256sum --check [--quiet] [--strict] MANIFEST, with GNU coreutils 9.4 results.

    Every listed file is hashed from the fixture's own bytes and compared with the listed digest: a digest that
    differs, a file that cannot be read, a line that is not a checksum line under --strict, and a manifest with no
    checksum line at all each exit 1, as on the box. Comment and empty lines and a trailing carriage return are not
    part of a checksum line, and a name's own carriage return is the \\r escape. A manifest or a listed path that
    leaves the fixture box root is refused (69) before anything outside it is read; the operand shapes this accepts
    are the only ones the plan uses.
    """
    options = [item for item in argv if item.startswith("-")]
    operands = [item for item in argv if not item.startswith("-")]
    if "--check" not in options and "-c" not in options:
        refuse("sha256sum", argv)
    if any(item not in SHA256_CHECK_OPTIONS for item in options) or len(operands) != 1:
        refuse("sha256sum", argv)
    manifest = operands[0]
    quiet = "--quiet" in options
    strict = "--strict" in options
    if not inside_box(manifest):
        sys.stderr.write("REFUSE sha256sum manifest outside the fixture box root: " + manifest + "\n")
        raise SystemExit(69)
    try:
        with open(manifest, "rb") as handle:
            data = handle.read()
    except OSError as error:
        sys.stderr.write("sha256sum: %s: %s\n" % (manifest, error.strerror))
        raise SystemExit(1)
    lines = data.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    out = sys.stdout.buffer
    err = sys.stderr.buffer
    formatted = malformed = mismatched = unreadable = 0
    for raw in lines:
        # GNU coreutils 9.4 digest_check: a line that starts with '#' is a comment, one trailing carriage return is
        # a line ending, not a name byte (a name's own CR is written \\r), and an empty line is skipped. None of
        # these is a checksum line or an improperly formatted one.
        if raw.startswith(b"#"):
            continue
        if raw.endswith(b"\r"):
            raw = raw[:-1]
        if raw == b"":
            continue
        found = SHA256_LINE.match(raw)
        name = found.group(3) if found else None
        if found and found.group(1):
            name = unescape_checksum_name(found.group(3))
        if not found or name is None:
            malformed += 1
            continue
        formatted += 1
        path = os.fsdecode(name)
        if not inside_box(path):
            sys.stderr.write("REFUSE sha256sum listed path outside the fixture box root: " + path + "\n")
            raise SystemExit(69)
        try:
            actual = file_sha256(path)
        except OSError as error:
            err.write(b"sha256sum: " + name + b": " + os.fsencode(error.strerror or "read error") + b"\n")
            out.write(name + b": FAILED open or read\n")
            unreadable += 1
            continue
        if actual != found.group(2).decode("ascii").lower():
            out.write(name + b": FAILED\n")
            mismatched += 1
        elif not quiet:
            out.write(name + b": OK\n")
    out.flush()
    if formatted == 0:
        sys.stderr.write("sha256sum: %s: no properly formatted checksum lines found\n" % manifest)
        raise SystemExit(1)
    if malformed:
        sys.stderr.write("sha256sum: WARNING: %d %s\n" % (malformed, plural(malformed, "line is improperly formatted", "lines are improperly formatted")))
    if unreadable:
        sys.stderr.write("sha256sum: WARNING: %d %s\n" % (unreadable, plural(unreadable, "listed file could not be read", "listed files could not be read")))
    if mismatched:
        sys.stderr.write("sha256sum: WARNING: %d %s\n" % (mismatched, plural(mismatched, "computed checksum did NOT match", "computed checksums did NOT match")))
    raise SystemExit(1 if unreadable or mismatched or (strict and malformed) else 0)


def cmd_sha256sum(argv: list[str]) -> None:
    if any(item in SHA256_CHECK_OPTIONS for item in argv):
        check_sha256sum(argv)
    files = [item for item in argv if item != "--"]
    if not files or any(item.startswith("-") for item in files):
        refuse("sha256sum", argv)
    status = 0
    for path in files:
        try:
            with open(path, "rb") as handle:
                digest = hashlib.sha256(handle.read()).hexdigest()
        except (FileNotFoundError, IsADirectoryError):
            sys.stderr.write("sha256sum: %s: No such file or directory\n" % path)
            status = 1
            continue
        sys.stdout.write("%s  %s\n" % (digest, path))
    raise SystemExit(status)


def cmd_id(argv: list[str]) -> None:
    user = remote_user()
    if argv == ["-un"]:
        sys.stdout.write(user + "\n")
    elif argv == ["-gn"]:
        sys.stdout.write(user + "\n")
    elif argv == ["-u"]:
        sys.stdout.write(str(USERS[user]) + "\n")
    elif argv == ["-g"]:
        sys.stdout.write(str(USERS[user]) + "\n")
    else:
        refuse("id", argv)


def parse_mode(text: str) -> int:
    if not re.fullmatch(r"[0-7]{3,4}", text):
        raise ValueError(text)
    return int(text, 8)


def cmd_install(argv: list[str]) -> None:
    directory = False
    mode = None
    owner = None
    group = None
    operands: list[str] = []
    index = 0
    while index < len(argv):
        item = argv[index]
        if item == "-d":
            directory = True
        elif item in ("-m", "-o", "-g") and index + 1 < len(argv):
            value = argv[index + 1]
            index += 1
            if item == "-m":
                try:
                    mode = parse_mode(value)
                except ValueError:
                    refuse("install", argv)
            elif item == "-o":
                owner = value
            else:
                group = value
        elif item == "--":
            operands.extend(argv[index + 1:])
            break
        elif item.startswith("-"):
            refuse("install", argv)
        else:
            operands.append(item)
        index += 1
    for name in (owner, group):
        if name is not None and name not in USERS:
            sys.stderr.write("install: invalid user: '%s'\n" % name)
            raise SystemExit(1)
    user = remote_user()
    if directory:
        if not operands:
            refuse("install", argv)
        for target in operands:
            require_ownership_right("install", owner, group, target)
            os.makedirs(target, exist_ok=True)
            os.chmod(target, 0o755 if mode is None else mode)
            record_owner(target, owner or user, group or user)
        return
    if len(operands) != 2:
        refuse("install", argv)
    source, target = operands
    if os.path.isdir(target):
        target = os.path.join(target, os.path.basename(source))
    # install /dev/null creates an empty regular file on the real box. It is a
    # character device, so the ordinary-file check alone falsely rejects it.
    if source != "/dev/null" and not os.path.isfile(source):
        sys.stderr.write("install: cannot stat '%s': No such file or directory\n" % source)
        raise SystemExit(1)
    require_ownership_right("install", owner, group, target)
    shutil.copyfile(source, target)
    os.chmod(target, 0o755 if mode is None else mode)
    record_owner(target, owner or user, group or user)


def cmd_chown(argv: list[str]) -> None:
    recursive = False
    operands: list[str] = []
    for item in argv:
        if item == "-R":
            recursive = True
        elif item.startswith("-"):
            refuse("chown", argv)
        else:
            operands.append(item)
    if len(operands) < 2:
        refuse("chown", argv)
    owner, group = parse_owner_spec(operands[0])
    user = remote_user()
    for target in operands[1:]:
        if not os.path.lexists(target):
            sys.stderr.write("chown: cannot access '%s': No such file or directory\n" % target)
            raise SystemExit(1)
        require_ownership_right("chown", owner, group, target)
        current = load_owners().get(owner_key(target), user + ":" + user)
        current_owner, _, current_group = current.partition(":")
        record_owner(target, owner or current_owner, group or current_group, recursive)


def move_records(source: str, target: str) -> None:
    owners = load_owners()
    source_key = owner_key(source)
    target_key = owner_key(target)
    moved = {}
    for key, value in owners.items():
        if key == source_key or key.startswith(source_key + "/"):
            moved[target_key + key[len(source_key):]] = value
    for key in [key for key in owners if key == source_key or key.startswith(source_key + "/")]:
        del owners[key]
    owners.update(moved)
    save_owners(owners)


def cmd_mv(argv: list[str]) -> None:
    if argv == ["--help"]:
        sys.stdout.write("Usage: mv [OPTION]... [-T] SOURCE DEST\n")
        return
    no_target_directory = False
    operands: list[str] = []
    index = 0
    while index < len(argv):
        item = argv[index]
        if item == "--":
            operands.extend(argv[index + 1:])
            break
        if re.fullmatch(r"-[Tf]+", item):
            no_target_directory = no_target_directory or "T" in item
        elif item.startswith("-"):
            refuse("mv", argv)
        else:
            operands.append(item)
        index += 1
    if len(operands) < 2:
        refuse("mv", argv)
    *sources, target = operands
    if no_target_directory and len(sources) != 1:
        refuse("mv", argv)
    for source in sources:
        destination = target
        if not no_target_directory and os.path.isdir(target):
            destination = os.path.join(target, os.path.basename(source))
        try:
            os.replace(source, destination)
        except OSError as error:
            sys.stderr.write("mv: cannot move '%s' to '%s': %s\n" % (source, destination, error.strerror))
            raise SystemExit(1)
        move_records(source, destination)


def cmd_cp(argv: list[str]) -> None:
    archive = False
    operands: list[str] = []
    for item in argv:
        if item == "--reflink=auto":
            continue
        if item in ("-a", "-R", "-r", "-p"):
            archive = archive or item != "-p"
        elif item.startswith("-"):
            refuse("cp", argv)
        else:
            operands.append(item)
    if len(operands) != 2:
        refuse("cp", argv)
    source, target = operands
    if os.path.isdir(target):
        target = os.path.join(target, os.path.basename(source.rstrip("/")))
    if os.path.isdir(source) and not os.path.islink(source):
        if not archive:
            sys.stderr.write("cp: -r not specified; omitting directory '%s'\n" % source)
            raise SystemExit(1)
        shutil.copytree(source, target, symlinks=True, copy_function=shutil.copy2)
    else:
        shutil.copy2(source, target, follow_symlinks=False)
    owners = load_owners()
    source_key = owner_key(source)
    target_key = owner_key(target)
    for key, value in list(owners.items()):
        if key == source_key or key.startswith(source_key + "/"):
            owners[target_key + key[len(source_key):]] = value
    save_owners(owners)


def process_table() -> list[str]:
    # The box's table lives in the fixture box root. A Mac block reads its own, named by BOX_DRY_RUN_PROCESS_TABLE:
    # the dry run never reads the host's real process table, so another run on the same host cannot leak into it.
    path = os.environ.get("BOX_DRY_RUN_PROCESS_TABLE") or os.path.join(box_root(), ".fixture", "processes")
    try:
        with open(path, encoding="utf-8") as handle:
            return [line.rstrip("\n") for line in handle if line.strip()]
    except FileNotFoundError:
        return []


def cmd_ps(argv: list[str]) -> None:
    if argv != ["-eo", "pid=,args="]:
        refuse("ps", argv)
    for line in process_table():
        sys.stdout.write(line + "\n")


def cmd_pgrep(argv: list[str]) -> None:
    if len(argv) != 2 or argv[0] != "-f":
        refuse("pgrep", argv)
    pattern = re.compile(argv[1])
    matched = False
    for line in process_table():
        pid, _, command = line.strip().partition(" ")
        if pattern.search(command):
            sys.stdout.write(pid + "\n")
            matched = True
    raise SystemExit(0 if matched else 1)


HOSTS = re.compile(r"^(ops|commonswarm)@(100\.115\.66\.74|yulan-vps-1):(.*)$", re.S)


def cmd_record_owner(argv: list[str]) -> None:
    if len(argv) != 3 or argv[1] not in USERS or argv[2] not in USERS:
        refuse("record-owner", argv)
    record_owner(argv[0], argv[1], argv[2])


def sync_tree(source: str, target: str, delete: bool, ignore_existing: bool) -> None:
    os.makedirs(target, exist_ok=True)
    names = set(os.listdir(source))
    if delete:
        for name in os.listdir(target):
            if name not in names:
                path = os.path.join(target, name)
                if os.path.isdir(path) and not os.path.islink(path):
                    shutil.rmtree(path)
                else:
                    os.unlink(path)
    for name in sorted(names):
        origin = os.path.join(source, name)
        destination = os.path.join(target, name)
        if os.path.islink(origin):
            if ignore_existing and os.path.lexists(destination):
                continue
            if os.path.lexists(destination):
                os.unlink(destination)
            os.symlink(os.readlink(origin), destination)
        elif os.path.isdir(origin):
            sync_tree(origin, destination, delete, ignore_existing)
        else:
            if ignore_existing and os.path.lexists(destination):
                continue
            shutil.copy2(origin, destination)
    shutil.copystat(source, target)


def cmd_rsync(argv: list[str]) -> None:
    flags = sorted(item for item in argv if item.startswith("-"))
    operands = [item for item in argv if not item.startswith("-")]
    if flags not in (["--delete", "-a"], ["--ignore-existing", "-a"]) or len(operands) != 2:
        refuse("rsync", argv)
    in_remote = bool(os.environ.get("BOX_DRY_RUN_IN_REMOTE"))
    root = box_root()
    resolved = []
    for operand in operands:
        match = HOSTS.match(operand)
        if match:
            if in_remote:
                refuse("rsync", argv)
            resolved.append(("box", rewrite(match.group(3).encode()).decode()))
        else:
            resolved.append(("local", operand))
    wanted = ("local", "local") if in_remote else ("local", "box")
    if (resolved[0][0], resolved[1][0]) != wanted:
        refuse("rsync", argv)
    source, target = resolved[0][1], resolved[1][1]
    if not source.endswith("/") or not target.endswith("/") or not os.path.isdir(source):
        refuse("rsync", argv)
    source, target = os.path.realpath(source), os.path.abspath(target)
    if not (os.path.realpath(os.path.dirname(target)) + "/").startswith(root.rstrip("/") + "/"):
        sys.stderr.write("REFUSE rsync target outside the fixture box root: " + target + "\n")
        raise SystemExit(69)
    site_releases = os.path.join(root, "srv", "commonswarm", "site", "releases") + "/"
    if not in_remote and not (os.path.realpath(target) + "/").startswith(site_releases):
        refuse("rsync", argv)
    sync_tree(source, target, "--delete" in flags, "--ignore-existing" in flags)
    if root == "/" and not in_remote:
        # A guarded Linux upload is performed by the SSH destination account,
        # even though this local adapter starts as root. Preserve real Linux
        # ownership, just as native rsync through that login would do.
        import pwd
        match = HOSTS.match(operands[1])
        if not match:
            refuse("rsync", argv)
        account = pwd.getpwnam(match.group(1))
        for directory, children, files in os.walk(target):
            for path in [directory, *[os.path.join(directory, name) for name in children + files]]:
                os.chown(path, account.pw_uid, account.pw_gid, follow_symlinks=False)


def cmd_tee(argv: list[str]) -> None:
    operands: list[str] = []
    options = True
    for item in argv:
        if options and item == "--":
            options = False
        elif options and item in ("-a", "--append", "-i", "--ignore-interrupts"):
            continue
        elif options and item.startswith("-"):
            refuse("tee", argv)
        else:
            operands.append(item)
    user = remote_user()
    root = box_root()
    created = []
    for path in operands:
        if os.path.commonpath([root, os.path.realpath(path)]) != root:
            refuse("tee", argv)
        if not os.path.lexists(path):
            created.append(path)
    # Run the native stream writer on real stdin. Keep actual bytes, mode,
    # append/truncate behavior and exit status; model only creation identity.
    status = subprocess.run(["/usr/bin/tee", *argv], check=False).returncode
    for path in created:
        if os.path.isfile(path):
            record_owner(path, user, user)
    raise SystemExit(status)


def cmd_diff(argv: list[str]) -> None:
    if len(argv) != 3 or argv[0] != "-qr":
        refuse("diff", argv)
    root = box_root()
    for path in argv[1:]:
        if os.path.commonpath([root, os.path.realpath(path)]) != root:
            refuse("diff", argv)
    # Compare the actual fixture bytes. Missing operands and differences keep diff's nonzero status.
    raise SystemExit(subprocess.run(["/usr/bin/diff", *argv], check=False).returncode)


COMMANDS = {
    "source-file": cmd_source_file,
    "record-owner": cmd_record_owner, "rsync": cmd_rsync, "date": cmd_date, "stat": cmd_stat, "sha256sum": cmd_sha256sum, "id": cmd_id, "install": cmd_install,
    "chown": cmd_chown, "mv": cmd_mv, "cp": cmd_cp, "ps": cmd_ps, "pgrep": cmd_pgrep, "diff": cmd_diff, "tee": cmd_tee,
}


def main() -> None:
    if len(sys.argv) < 2:
        refuse("box-userland", [])
    name, argv = sys.argv[1], sys.argv[2:]
    if name == "rewrite":
        sys.stdout.buffer.write(rewrite(sys.stdin.buffer.read()))
        return
    if name == "strip":
        sys.stdout.buffer.write(strip(sys.stdin.buffer.read()))
        return
    handler = COMMANDS.get(name)
    if handler is None:
        refuse(name, argv)
    handler(argv)


if __name__ == "__main__":
    main()
