# Registry metadata validation

Run on 4 October 2026 in the D2 worktree at source
`61f187c527b51e9946f607691dd056e9964d751a`.

Result: **PASS**, exit code **0**. The local validator accepted
[server.json](../../../server.json) with zero errors. Three negative controls
were rejected in the same invocation. Only the in-memory controls were changed.

**Vendor-documented:** the [remote-server guide](https://modelcontextprotocol.io/registry/remote-servers)
and [quickstart](https://modelcontextprotocol.io/registry/quickstart) point to
schema version **2025-12-11**:
[server.schema.json](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json).
The fetched schema declares JSON Schema Draft 7. Its exact bytes and the record
are identified by SHA-256 in the output.

The validator was the already available Python `jsonschema` **4.25.1**.
Python was **3.9.6**. No dependency was installed. The schema was fetched over
HTTPS into memory. No schema file or script was added to the repository.
URI format checks were enabled.

## Exact command

Run from the repository root. The hash check refuses changed schema bytes.
Review any change before updating that expected hash.

```sh
python3 - <<'PY'
import copy
import hashlib
import importlib.metadata
import json
import platform
from pathlib import Path
from urllib.request import urlopen
from jsonschema import Draft7Validator, FormatChecker

schema_url = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"
expected_schema_sha256 = "3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0"
with urlopen(schema_url, timeout=30) as response:
    if response.url != schema_url:
        raise SystemExit("FAIL: unexpected schema redirect")
    schema_bytes = response.read()
schema_sha256 = hashlib.sha256(schema_bytes).hexdigest()
if schema_sha256 != expected_schema_sha256:
    raise SystemExit("FAIL: schema bytes changed; review before validating")
schema = json.loads(schema_bytes)
if schema["$id"] != schema_url:
    raise SystemExit("FAIL: schema identifier mismatch")
Draft7Validator.check_schema(schema)
validator = Draft7Validator(schema, format_checker=FormatChecker())
record_bytes = Path("server.json").read_bytes()
record = json.loads(record_bytes)
validator.validate(record)

def reject(label, candidate):
    errors = list(validator.iter_errors(candidate))
    if not errors:
        raise SystemExit("FAIL: negative control accepted: " + label)
    print("PASS: rejected negative control: " + label)

missing_name = copy.deepcopy(record)
del missing_name["name"]
invalid_transport = copy.deepcopy(record)
invalid_transport["remotes"][0]["type"] = "invalid-transport"
long_description = copy.deepcopy(record)
long_description["description"] = "x" * 101

print("Python: " + platform.python_version())
print("jsonschema: " + importlib.metadata.version("jsonschema"))
print("Schema URL: " + schema_url)
print("Schema version: 2025-12-11; JSON Schema Draft 7")
print("Schema SHA-256: " + schema_sha256)
print("server.json SHA-256: " + hashlib.sha256(record_bytes).hexdigest())
print("PASS: schema self-check")
print("PASS: server.json; 0 validation errors; URI format checks enabled")
reject("missing required name", missing_name)
reject("invalid remote transport", invalid_transport)
reject("101-character description", long_description)
print("PASS: positive record and 3 negative controls in one invocation")
PY
```

## Captured output

```text
Python: 3.9.6
jsonschema: 4.25.1
Schema URL: https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
Schema version: 2025-12-11; JSON Schema Draft 7
Schema SHA-256: 3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0
server.json SHA-256: 8389ba6367f063831fb16e906c2b428b344a76c0e6ba40a62b12e5ddbe28d33f
PASS: schema self-check
PASS: server.json; 0 validation errors; URI format checks enabled
PASS: rejected negative control: missing required name
PASS: rejected negative control: invalid remote transport
PASS: rejected negative control: 101-character description
PASS: positive record and 3 negative controls in one invocation
```

Exit code: `0`.

## Limits and file scope

This validates the metadata against the fetched schema. It does not establish
Registry authorization, name availability, publication, deployed version parity,
endpoint reachability, or consumer compatibility.

**NOT VERIFIED by D2:** delegated completion, per-host support, Registry
publication, and wake. CommonSwarm capability evidence and dated OAuth
measurements are linked in [README.md](README.md). No CommonSwarm service probe,
publisher login, publish, browser session, full test suite, CI run, commit, or
push was performed. HezLead owns the cross-family check.

The assignment adds only `server.json`, `docs/integrations/registry/README.md`,
and this file. Existing files and C1 implementation files were not changed.

