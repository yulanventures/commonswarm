#!/usr/bin/env python3
"""Pinned-image, throwaway-container control for the edge main service."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[2]
IMAGE = "public.ecr.aws/supabase/edge-runtime:v1.73.13"
NAMES = []
STUB = """Deno.serve(async (request) => {
  const url = new URL(request.url);
  if (url.searchParams.has('burn')) {
    const held = [];
    while (true) {
      held.push(new Array(250000).fill(7));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return Response.json({ method: request.method, path: url.pathname,
    query: url.search, body: await request.text() });
});
"""


def run(*args, check=True):
    return subprocess.run(args, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=check)


def logs(name):
    result = run("docker", "logs", name, check=False)
    return (result.stdout + result.stderr).splitlines()


def events(name, event):
    result = []
    for line in logs(name):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("event") == event:
            result.append(value)
    return result


def wait_for(predicate, seconds, label):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.5)
    raise AssertionError("timed out waiting for " + label)


def request(port, path, method="GET", body=None, headers=None, timeout=15):
    req = urllib.request.Request("http://127.0.0.1:%s%s" % (port, path),
                                 data=body, headers=headers or {}, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        response_headers = {k.lower(): v for k, v in response.headers.items()
                            if k.lower() not in ("date", "connection")}
        return response.status, response_headers, response.read().decode()


def start(name, main, stub, deploy):
    args = ["docker", "run", "-d", "--init", "--entrypoint", "/bin/bash", "--name", name,
            "-p", "127.0.0.1::9000", "-v", str(main) + ":/home/deno/main:ro",
            "-v", str(stub) + ":/home/deno/functions-source:ro",
            "-v", str(deploy / "bootstrap.sh") + ":/home/deno/deploy/bootstrap.sh:ro",
            "-v", str(deploy / "h0-deno.json") + ":/home/deno/deploy/h0-deno.json:ro"]
    for key, value in {
        "SUPABASE_URL": "http://127.0.0.1:54321",
        "SUPABASE_ANON_KEY": "test-only",
        "SUPABASE_SERVICE_ROLE_KEY": "test-only",
        "SWARM_DATABASE_URL": "postgres://test:test@127.0.0.1:5432/test",
        "SWARM_SELF_SERVE": "1",
        "SWARM_ENV": "test",
    }.items():
        args += ["-e", key + "=" + value]
    args += [IMAGE, "/home/deno/deploy/bootstrap.sh", "start", "--main-service",
             "/home/deno/main", "--port", "9000", "--policy", "per_worker",
             "--max-parallelism", "4", "--graceful-exit-timeout", "70"]
    run(*args)
    NAMES.append(name)
    mapping = run("docker", "port", name, "9000/tcp", check=False)
    assert mapping.returncode == 0, "port: %s; logs: %s" % (
        mapping.stderr, " | ".join(logs(name)[-12:]))
    port = mapping.stdout.strip().rsplit(":", 1)[1]
    try:
        wait_for(lambda: healthy(port), 45, name + " health")
    except AssertionError:
        state = run("docker", "inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", name,
                    check=False).stdout.strip()
        raise AssertionError("%s failed health (%s): %s" % (
            name, state, " | ".join(logs(name)[-12:])))
    return port


def healthy(port):
    try:
        return request(port, "/health", timeout=1)[0] == 200
    except (OSError, TimeoutError):
        return False


def stop(name):
    began = time.monotonic()
    run("docker", "stop", "-t", "80", name)
    return time.monotonic() - began


def matrix(port):
    cases = [
        ("GET", "/functions/v1/command/a?x=1", None, {}),
        ("POST", "/functions/v1/read", b"body", {"Content-Type": "text/plain"}),
        ("OPTIONS", "/functions/v1/capability/x", None,
         {"Access-Control-Request-Headers": "authorization"}),
        ("GET", "/functions/v1", None, {}),
        ("GET", "/functions/v1/unknown", None, {}),
        ("GET", "/other", None, {}),
        ("GET", "/functions/v1/activity", None, {}),
        ("PUT", "/functions/v1/h0/x", b"update", {}),
        ("HEAD", "/functions/v1/command", None, {}),
        ("GET", "/health", None, {}),
        ("OPTIONS", "/functions/v1/unknown", None, {}),
        ("GET", "/_internal/metric", None, {}),
    ]
    return [request(port, path, method, body, headers)
            for method, path, body, headers in cases]


def main():
    run("docker", "image", "inspect", IMAGE)  # no pull
    prefix = "edgemem-live-%s" % os.getpid()
    with tempfile.TemporaryDirectory(prefix="edgemem-control-") as temporary:
        temp = Path(temporary)
        baseline = temp / "baseline"
        baseline.mkdir()
        archive = temp / "base.tar"
        with archive.open("wb") as output:
            subprocess.run(["git", "archive", "origin/main", "deploy/edge-runtime/main",
                            "deploy/edge-runtime/bootstrap.sh", "deploy/edge-runtime/h0-deno.json"],
                           cwd=ROOT, stdout=output, check=True)
        with tarfile.open(archive) as source:
            source.extractall(baseline)
        deploy = ROOT / "deploy/edge-runtime"
        stub = temp / "stub"
        for function in ("command", "read", "capability", "activity", "h0"):
            target = stub / function
            target.mkdir(parents=True)
            (target / "index.ts").write_text(STUB)
        base_name = prefix + "-base"
        lane_name = prefix + "-lane"
        base_port = start(base_name, baseline / "deploy/edge-runtime/main", stub,
                          baseline / "deploy/edge-runtime")
        lane_port = start(lane_name, deploy / "main", stub, deploy)
        lane_ready_at = time.monotonic()
        base_matrix = matrix(base_port)
        lane_matrix = matrix(lane_port)
        for index, (expected, actual) in enumerate(zip(base_matrix, lane_matrix), 1):
            assert expected == actual, "request %s: %r != %r" % (index, expected, actual)
        assert lane_matrix[-1][0] == 404 and lane_matrix[-1][2] == "Function not found"
        print("request matrix: 12/12 status, headers, body match origin/main")
        base_seconds = stop(base_name)
        assert base_seconds < 10, "baseline stop took %.1fs" % base_seconds
        print("origin/main stop: %.1fs" % base_seconds)

        starts = events(lane_name, "edge_worker_started")
        keys = [entry["workerKey"] for entry in starts]
        assert len(keys) == len(set(keys)) and len(keys) >= 4, starts
        print("worker starts: %s unique keys, one line per key" % len(keys))
        try:
            request(lane_port, "/functions/v1/command?burn=1", timeout=30)
        except (OSError, TimeoutError):
            pass  # the runtime may close the request when the worker hits its limit
        ended = wait_for(lambda: events(lane_name, "edge_worker_ended"),
                         30, "worker retirement record")
        command_keys = {entry["workerKey"] for entry in starts
                        if entry["functionName"] == "command"}
        assert any(entry["workerKey"] in command_keys and
                   entry["functionName"] == "command" for entry in ended), ended
        all_start_keys = [entry["workerKey"] for entry in
                          events(lane_name, "edge_worker_started")]
        assert len(all_start_keys) == len(set(all_start_keys)), all_start_keys
        print("worker ends: %s observed after retirement" % len(ended))

        samples = wait_for(lambda: events(lane_name, "edge_runtime_metrics"),
                           66, "one-minute metrics record")
        assert time.monotonic() - lane_ready_at < 65, "first metrics sample missed period"
        assert isinstance(samples[0]["metrics"], dict), samples[0]
        print("runtime metrics: %s JSON record within one 60s period" % len(samples))
        lane_seconds = stop(lane_name)
        assert lane_seconds < 10, "lane stop took %.1fs" % lane_seconds
        print("lane stop: %.1fs" % lane_seconds)

        mutant = temp / "mutant"
        shutil.copytree(deploy / "main", mutant)
        index = mutant / "index.ts"
        source = index.read_text()
        old = '  clearInterval(workerInventoryTimer);\n  clearInterval(runtimeMetricsTimer);'
        assert source.count(old) == 1
        index.write_text(source.replace(old, '  // mutation: intervals remain live'))
        mutant_name = prefix + "-mutant"
        start(mutant_name, mutant, stub, deploy)
        mutant_seconds = stop(mutant_name)
        assert 65 <= mutant_seconds < 80, "mutant stop took %.1fs" % mutant_seconds
        assert any("did not able to terminate the workers" in line
                   for line in logs(mutant_name)), "missing timeout diagnostic"
        print("mutation (clearInterval removed) stop: %.1fs; 70s timeout diagnostic present" % mutant_seconds)


if __name__ == "__main__":
    try:
        main()
    finally:
        for name in NAMES:
            run("docker", "rm", "-f", name, check=False)
