### Dependencies not checkable in Part T1a
- `scripts/timeout-table/run.mjs` (runner implementation, child isolation, worktree setup, signal/exit handlers, and table rendering; piece 2 of 2).
- `scripts/timeout-table/writes.cjs` (imported by `preload.cjs` at line 5 for `originWriteKind`).
- `scripts/timeout-table/mapping.json` (the ref mapping dataset).
- `scripts/timeout-table/` test suite files.

---

### Findings

#### 1. Undeclared `method` identifier in WebSocket block handler causes `ReferenceError`
- **File & Line**: [`scripts/timeout-table/preload.cjs:104`](file:///scripts/timeout-table/preload.cjs#L104)
- **Label**: **PRODUCTION**
- **Concrete Sequence**:
  In [`preload.cjs`](file:///scripts/timeout-table/preload.cjs#L99-L107), `TimeoutTableWebSocket` wraps target origin rewriting in a `try / catch`:
  ```javascript
  class TimeoutTableWebSocket extends OriginalWebSocket {
    constructor(url, protocols) {
      let target;
      try {
        target = rewritten(url);
      } catch (error) {
        record({ method, path: pathOnly(url), status: "BLOCKED", duration_ms: 0 });
        throw error;
      }
  ```
  While `method` is declared locally within the `fetch` override at line 61, no `method` variable exists in the lexical scope of `TimeoutTableWebSocket`. When an invalid, relative, or unpermitted origin WebSocket connection is attempted, `rewritten(url)` throws. Control enters the `catch` block at line 104, where evaluating the object shorthand `{ method, ... }` triggers `ReferenceError: method is not defined` under `"use strict"`.
- **What an Operator or Production Sees**:
  The call to `record(...)` aborts before executing. The blocked WebSocket attempt is never written to `TIMEOUT_TABLE_FETCH_LOG`, failing the commit's stated guarantee ("blocked relative fetch and WebSocket requests log only the pathname (no query string) and are recorded as BLOCKED"). Instead of receiving the intended policy error (`Error: timeout-table blocked a request whose origin is not the profile origin`), the process crashes with an unhandled `ReferenceError: method is not defined`.

---

#### 2. `ts.isPropertyAssignment` checked on `node.name` identifier creates dead branch
- **File & Line**: [`scripts/timeout-table/enumerate.mjs:145`](file:///scripts/timeout-table/enumerate.mjs#L145) (and call sites at [`enumerate.mjs:268`](file:///scripts/timeout-table/enumerate.mjs#L268), [`enumerate.mjs:328`](file:///scripts/timeout-table/enumerate.mjs#L328))
- **Label**: **RIGOUR**
- **Concrete Sequence**:
  In [`enumerateText`](file:///scripts/timeout-table/enumerate.mjs#L324-L330):
  ```javascript
  if (ts.isPropertyAssignment(node)) {
    const name = timeoutBindingName(node.name);
    if (isTimeoutBindingName(name)) {
      const value = valueOf(node.initializer);
      if (value !== null) add(node.name, name, value);
    }
  }
  ```
  `add` receives `node.name` (an `Identifier` or `StringLiteral`), not the `PropertyAssignment` node. `add` then forwards this `node` argument to `normalizedValue(raw, name, file, node)`.
  In [`normalizedValue`](file:///scripts/timeout-table/enumerate.mjs#L145):
  ```javascript
  if (name === "timeout" && ts.isPropertyAssignment(node)) {
    return { value_ms: raw, unit_note: "numeric timeout property; milliseconds unless the cited API defines another unit" };
  }
  ```
  Because `node` is always an `Identifier`, `ts.isPropertyAssignment(node)` is unconditionally `false`.
- **What an Operator or Production Sees**:
  This branch is dead code. Property assignment timeouts named `timeout` fall through to the generic unit note `"milliseconds"` instead of `"numeric timeout property; milliseconds unless the cited API defines another unit"`.

---

VERDICT: FAIL: ReferenceError on blocked WebSocket requests in preload.cjs:104 prevents recording BLOCKED status and crashes the process.
