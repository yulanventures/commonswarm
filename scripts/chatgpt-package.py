#!/usr/bin/env python3
"""Build a portable OpenAI package using pinned schemas and public listing rules."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys
import zipfile

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent
ENDPOINT = "https://mcp.commonswarm.com/mcp"
ASSET_PATH = "./assets/app-icon-512.png"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text(value, limit, field):
    require(isinstance(value, str) and 0 < len(value) <= limit, f"{field}: expected nonempty string <= {limit} characters")


def https(value, field):
    from urllib.parse import urlsplit
    text(value, 1024, field)
    url = urlsplit(value)
    require(url.scheme == "https" and url.hostname and not url.username and not url.password,
            f"{field}: expected HTTPS URL without credentials")


def validate(package_dir, submission_ready):
    # This lane intentionally permits only two source manifests. Assets and the
    # license come from the repository, so no companion files can enter the ZIP.
    require({p.name for p in package_dir.iterdir()} == {"plugin.json", "mcp.json", "README.md"},
            "package source inventory must be plugin.json, mcp.json, README.md only")
    documents = {}
    for name in ("plugin", "mcp"):
        source = package_dir / f"{name}.json"
        require(source.is_file() and not source.is_symlink(), f"{name}.json must be a regular file")
        document = json.loads(source.read_text())
        schema = json.loads((ROOT / f"scripts/schemas/chatgpt-{name}.schema.json").read_text())
        Draft202012Validator(schema).validate(document)
        documents[name] = document
    plugin, mcp = documents["plugin"], documents["mcp"]
    require(mcp["mcpServers"] == {"commonswarm": {"type": "streamable-http", "url": ENDPOINT}},
            "mcp.json must declare only the hosted CommonSwarm endpoint, with no headers")
    text(plugin.get("description"), 4000, "description")
    import re
    require(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", plugin["name"]) is not None, "name must be submission-safe kebab-case")
    require(re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", plugin.get("version", "")) is not None,
            "version must be an explicit release semantic version")
    require(set(plugin.get("extensions", {})) == {"com.openai"}, "only com.openai extension is supported")
    extension = plugin["extensions"]["com.openai"]
    require(set(extension) == {"interface", "review", "publication"},
            "OpenAI extension must contain only interface, review, publication; no apps or hooks")
    interface = extension["interface"]
    limits = {"displayName": 30, "shortDescription": 30, "longDescription": 4000, "developerName": 80, "category": 120}
    allowed_interface = set(limits) | {"websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL", "logo", "composerIcon"}
    require(isinstance(interface, dict) and set(interface) <= allowed_interface, "unsupported interface field")
    for field, limit in limits.items():
        text(interface.get(field), limit, field)
    for field in ("websiteURL", "privacyPolicyURL", "termsOfServiceURL"):
        https(interface.get(field), field)
    if "supportURL" in interface:
        https(interface["supportURL"], "supportURL")
    for field in ("logo", "composerIcon"):
        require(interface.get(field) == ASSET_PATH, f"{field} must reference the included existing icon")
    review = extension["review"]
    require(isinstance(review, dict) and set(review) <= {"test_cases", "commerce", "commerce_description", "demo_recording_url"},
            "unsupported review field; credentials and reviewer instructions stay outside the ZIP")
    require(review.get("commerce") is False, "commerce must be false")
    text(review.get("commerce_description"), 4000, "commerce_description")
    if "demo_recording_url" in review:
        https(review["demo_recording_url"], "demo_recording_url")
    cases = review.get("test_cases")
    require(isinstance(cases, dict) and set(cases) == {"positive", "negative"}, "review cases must have positive and negative lists")
    for kind, count in (("positive", 5), ("negative", 3)):
        require(isinstance(cases[kind], list) and len(cases[kind]) == count, f"expected exactly {count} {kind} cases")
        for case in cases[kind]:
            require(isinstance(case, dict) and set(case) == {"description", "prompt", "tools_triggered", "expected_behavior"}, "invalid review case fields")
            for field in case:
                text(case[field], 4000, f"{kind}.{field}")
    publication = extension["publication"]
    require(isinstance(publication, dict) and set(publication) == {"release_notes"}, "publication must contain release_notes only; targeting is left to the publisher")
    text(publication["release_notes"], 4000, "release_notes")
    icon = (ROOT / "site/public/brand/app-icon-512.png").read_bytes()
    require(icon[:8] == b"\x89PNG\r\n\x1a\n" and icon[12:16] == b"IHDR", "primary icon must be PNG")
    width, height = struct.unpack(">II", icon[16:24])
    require(48 <= width == height <= 4096 and len(icon) <= 5 * 1024 * 1024, "primary icon violates documented dimensions or size")
    missing = [field for field, value in (("supportURL", interface.get("supportURL")), ("demo_recording_url", review.get("demo_recording_url"))) if not value]
    require(not submission_ready or not missing, "submission prerequisites missing: " + ", ".join(missing))
    contents = {f"{name}.json": (package_dir / f"{name}.json").read_bytes() for name in documents}
    contents[ASSET_PATH.removeprefix("./")] = icon
    contents["LICENSE"] = (ROOT / "LICENSE").read_bytes()
    return contents, missing


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", type=Path, default=ROOT / "distribution/chatgpt-apps")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist-chatgpt")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--submission-ready", action="store_true", help="also require support URL and recording declarations; does not prove live status or vendor acceptance")
    args = parser.parse_args()
    try:
        contents, missing = validate(args.package_dir, args.submission_ready)
        print("PASS: pinned portable schemas, listing limits, eight review cases, endpoint and icon")
        if missing:
            print("DRAFT ONLY: missing " + ", ".join(missing))
        if not args.validate_only:
            args.output_dir.mkdir(parents=True, exist_ok=True)
            output = args.output_dir / "commonswarm-chatgpt.zip"
            # Stored entries avoid compressor-version drift; fixed ordering,
            # timestamp, permissions and no platform-specific extra fields.
            with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
                for name, data in sorted(contents.items()):
                    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                    info.create_system = 3
                    info.external_attr = 0o100644 << 16
                    archive.writestr(info, data)
            print(f"ZIP: {output}")
            print(f"SHA256: {hashlib.sha256(output.read_bytes()).hexdigest()}")
            print("ARCHIVE: " + ", ".join(sorted(contents)))
        return 0
    except (ValueError, OSError, KeyError, TypeError, struct.error) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    except Exception as error:
        from jsonschema.exceptions import ValidationError
        if isinstance(error, ValidationError):
            print(f"FAIL: JSON schema at {'/'.join(map(str, error.path))}: {error.message}", file=sys.stderr)
            return 1
        raise


if __name__ == "__main__":
    sys.exit(main())
