// Shell-text inventory for the documented host boundary, independent of fixture coverage.
// Paths stay symbolic here: the boundary adapter resolves them for its particular fixture.
import { planShellWords } from "../support/plan-shell-words.js";
import { readFileSync } from "node:fs";
export interface HandoffBlock { file: string; step: string; host: string; source: string; line: number }
export interface Handoff {
  producer: HandoffBlock;
  consumer: HandoffBlock;
  path: string;
  direction: "mac-to-box" | "box-to-mac";
  source?: string;
  mode?: string;
  owner?: string;
}
export interface TransferProduct { path: string; source: string; mode: string; owner: string; remote?: boolean; kind?: "file" | "directory" }
const UNKNOWN_TRANSPORT = /\b(?:sftp|ftp|lftp|rcp|rclone|bbcp|unison|sshpass)\b/;
// An impossible shell argv byte distinguishes captured data from literal text.
// Its meaning must survive projection until the executable/destination boundary.
const CAPTURED_STDOUT = "\0captured-stdout\0";
const shellTokens = (line: string): string[] => line.match(/(?:"[^"]*"|'[^']*'|[^\s;"']+)+/g) ?? [];
const tokens = (line: string): string[] => shellTokens(line)
  .map((word) => word.replace(/["']/g, ""));

// Call only outside quotes/escapes. A comment starts a token, not just after
// any whitespace byte: escaped whitespace/operators still belong to a word.
function shellCommentStart(source: string, index: number): boolean {
  const escapedAt = (at: number): boolean => {
    let backslashes = 0;
    while (at > 0 && source[--at] === "\\") backslashes++;
    return backslashes % 2 === 1;
  };
  // An unquoted backslash-newline contributes neither data nor a boundary.
  while (index >= 2 && source[index - 1] === "\n" && source[index - 2] === "\\" && !escapedAt(index - 2)) index -= 2;
  // A substitution closes a word component, unlike a subshell/group close.
  // Project the prefix with the same grammar the writer scanner uses, so nested
  // command/process substitutions and arithmetic expansions keep an adjacent #.
  if (source[index - 1] === ")" && !escapedAt(index - 1) &&
      substitutionPrograms(source.slice(0, index)).outer.endsWith(CAPTURED_STDOUT)) return false;
  return index === 0 || (/[\s;|&()<>]/.test(source[index - 1]!) && !escapedAt(index - 1));
}

function unclosedShellQuote(source: string): boolean {
  let quote = "", escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "#" && shellCommentStart(source, index)) {
      const newline = source.indexOf("\n", index);
      if (newline < 0) break;
      index = newline;
    }
  }
  return Boolean(quote);
}

// Here-document bodies belong to stdin, not the Mac shell's assignment scope.
function outsideHeredocs(source: string): string {
  const lines = source.split("\n");
  const outer: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    outer.push(line);
    const here = /<<(-?)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (here) while (++index < lines.length &&
      (here[1] ? lines[index]!.replace(/^\t+/, "") : lines[index]) !== here[3]) { /* stdin */ }
  }
  return outer.join("\n");
}

function expansions(block: HandoffBlock, locals: Record<string, string> = {}): (value: string) => string[] {
  const vars = new Map<string, string[]>([
    ["SHA", ["{sha}"]], ["RELEASE_SHA", ["{sha}"]], ["WINDOW_ID", ["{window}"]],
  ]);
  for (const match of block.source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#]+))\s*$/gm)) {
    const value = match[2] ?? match[3] ?? match[4]!;
    if (!value.includes("$(") && !value.includes("`") && !/^\$[0-9]+$/.test(value) && !["SHA", "RELEASE_SHA", "WINDOW_ID"].includes(match[1]!)) vars.set(match[1]!, [value]);
  }
  // Some blocks inherit PROOF_DIR through sourced state (e.g. runbook-17's generated DB
  // session), without assigning it locally. Their sourced window path identifies that
  // proof root. Ignoring it loses H0 files even though copy-back explicitly selects them.
  if (!vars.has("PROOF_DIR")) {
    const windows = [...block.source.matchAll(/^\s*\.\s+["']?(\/[^\s"']+\/window\.env)["']?\s*$/gm)]
      .map((match) => match[1]!.slice(0, -"/window.env".length));
    if (windows.length) {
      const paths = [...new Set(windows.map((path) => path.replace(/\$\{(?:RELEASE_SHA|SHA)\}|\$(?:RELEASE_SHA|SHA)\b/g, "{sha}")))];
      if (paths.length !== 1) throw new Error(`${block.file}:${block.line}: ambiguous sourced window paths: ${paths.join(", ")}`);
      vars.set("PROOF_DIR", paths);
    }
  }
  for (const match of block.source.matchAll(/\bfor ([A-Za-z_][A-Za-z0-9_]*) in ([^;\n]+); do/g)) {
    const values = tokens(match[2]!);
    const expanded = values.flatMap((value) => {
      const name = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value)?.[1];
      return name && vars.has(name) ? vars.get(name)!.flatMap(tokens) : [value];
    });
    if (expanded.every((value) => !value.includes("$"))) vars.set(match[1]!, expanded);
    else {
      const name = match[1]!;
      const accepted = new RegExp(`case "\\$${name}" in ([a-z|]+)\\)`).exec(block.source)?.[1];
      if (accepted) vars.set(name, accepted.split("|"));
    }
  }
  for (const [name, value] of Object.entries(locals)) vars.set(name, [value]);
  const expand = (value: string, depth = 0): string[] => {
    if (depth > 12) return [value];
    const match = [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)].find((item) => vars.has(item[1] ?? item[2]!));
    if (!match || !vars.has(match[1] ?? match[2]!)) return [value];
    return vars.get(match[1] ?? match[2]!)!.flatMap((replacement) => expand(
      value.slice(0, match.index) + replacement + value.slice(match.index + match[0].length), depth + 1));
  };
  return (value) => expand(value);
}

export interface RemoteOperation {
  command: string;
  script?: string;
  delimiter?: string;
  stdinProducer?: { path: string; writers: string[] };
  stdinFile?: string;
  localArgvSource?: string;
  // A Mac command substitution owns this output, not the remote environment.
  capture?: { name: string; localStateSource?: string };
  // These sinks belong to the Mac SSH executable, never to the remote shell.
  localOutputPaths?: string[];
}

function selectedPlanScript(block: HandoffBlock, command: string, program: string): string {
  const file = /\$[A-Z0-9_]+\/(docs\/[A-Za-z0-9_./-]+\.md)/.exec(command)?.[1];
  const step = /^matches=\[b for b in blocks if b\.splitlines\(\)\[0\]=='# step: ([a-z0-9-]+)'\]$/m.exec(program)?.[1];
  const lines = program.trim().split("\n");
  if (!file || file.split("/").includes("..") || !step || lines.length !== 5 || lines[0] !== "import pathlib,re,sys" ||
      lines[1] !== "blocks=re.findall(r'```sh\\n(.*?)\\n```',pathlib.Path(sys.argv[1]).read_text(),re.S)" ||
      !/^assert len\(matches\)==1, '[^']+'$/.test(lines[3]!) || lines[4] !== "print(matches[0])") {
    throw new Error(`${block.file}:${block.line}: unknown transfer form: opaque plan selector`);
  }
  const selected = [...readFileSync(file, "utf8").matchAll(/^```sh\n([\s\S]*?)^```$/gm)]
    .map((match) => match[1]!).filter((source) => source.split("\n")[0] === `# step: ${step}`);
  if (selected.length !== 1) throw new Error(`${block.file}:${block.line}: plan selector requires one ${step}`);
  return selected[0]!;
}
export type BoundaryOperation = { transfer: TransferProduct; transport: "scp" | "rsync"; flags: string[] } | { remote: RemoteOperation };

// Keep the remote command's shell quoting and here-document bytes. Only the Mac stdout
// sink is removed; it is not a box product. File-fed scripts must have a visible writer.
export function macBoundaryOperations(block: HandoffBlock, locals: Record<string, string> = {}): BoundaryOperation[] {
  if (block.host.startsWith("box ")) return [];
  const expand = expansions({ ...block, source: outsideHeredocs(block.source) }, locals);
  const lines = block.source.split("\n");
  const scripts = new Map<string, { script?: string; delimiter?: string; stdinProducer?: { path: string; writers: string[] } }>();
  const operations: BoundaryOperation[] = [];
  const unknown = (line: string): never => { throw new Error(`${block.file}:${block.line}: unknown transfer form: ${line.trim()}`); };
  const commandExpansion = (command: string): string => {
    let quote = "", escaped = false, start = 0, result = "";
    for (let index = 0; index < command.length; index++) {
      const char = command[index]!;
      if (escaped) { escaped = false; continue; }
      if (char === "\\" && quote !== "'") { escaped = true; continue; }
      if (char === '"' && quote !== "'") { quote = quote === '"' ? "" : '"'; continue; }
      if (char !== "'" || quote === '"') continue;
      if (quote === "'") {
        result += command.slice(start, index + 1);
        quote = "";
      } else {
        result += expand(command.slice(start, index))[0]!;
        start = index;
        quote = "'";
        continue;
      }
      start = index + 1;
    }
    return result + expand(command.slice(start))[0]!;
  };
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (/^\s*#/.test(line)) continue;
    while (line.endsWith("\\") && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i]!;
    if (/\bssh\s/.test(line) || /^\s*(?:scp|rsync)\s/.test(line)) {
      // A heredoc in an enclosing capture is read by the stdin scanner below;
      // its body must not be swallowed while joining a quoted SSH argv.
      while (unclosedShellQuote(line) && !/<<-?['"]?[A-Za-z_]/.test(line) && i + 1 < lines.length) line += "\n" + lines[++i]!;
      if (unclosedShellQuote(line) && !/<<-?['"]?[A-Za-z_]/.test(line)) unknown(line);
    }
    const here = /<<(-?)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    let script: string | undefined;
    if (here) {
      const body: string[] = [];
      while (++i < lines.length && (here[1] ? lines[i]!.replace(/^\t+/, "") : lines[i]) !== here[3]) body.push(lines[i]!);
      if (i === lines.length) unknown(line);
      script = body.join("\n") + "\n";
      const file = /(?<![<>])([>]{1,2})\s*("[^"]+"|'[^']+'|[^\s<]+)/.exec(line);
      if (file && !/\bssh\s/.test(line)) {
        const path = tokens(file[2]!)[0]!;
        const delimiter = `${here[2]}${here[3]}${here[2]}`;
        const writer = `${line}\n${script}${here[3]}\n`;
        if (/^\s*cat\s+/.test(line)) {
          const prior = file[1] === ">>" ? scripts.get(path) : undefined;
          if (prior?.stdinProducer || (prior && prior.delimiter !== delimiter)) {
            scripts.set(path, { stdinProducer: { path, writers: [...(prior.stdinProducer?.writers ?? []), writer] } });
          } else scripts.set(path, { script: (prior?.script ?? "") + script, delimiter });
        }
        else {
          const prior = file[1] === ">>" ? scripts.get(path)?.stdinProducer?.writers ?? [] : [];
          scripts.set(path, { stdinProducer: { path, writers: [...prior, writer] } });
        }
      }
    }
    // Unknown transport commands cannot silently disappear from inventory. HTTP reads
    // are not transfers; upload flags and remote-copy tools are host-boundary operations.
    if (UNKNOWN_TRANSPORT.test(line) ||
        /\bcurl\b.*(?:--upload-file|--data-binary|-T)\b/.test(line)) unknown(line);
    const words = shellTokens(line.trim());
    if (["scp", "rsync"].includes(words[0] ?? "")) {
      const command = words.shift()! as "scp" | "rsync";
      const flags: string[] = [];
      while (words[0]?.startsWith("-")) {
        const flag = tokens(words.shift()!)[0]!;
        flags.push(flag);
        if (command === "scp" && (flag !== "-p" || flags.length !== 1)) unknown(line);
        const known = command === "scp" ? flag === "-p" : /^-[avzhn]+$/.test(flag) || ["--delete", "--ignore-existing", "--relative"].includes(flag);
        if (!known && !["-e", "--rsh", "--exclude", "--include", "-o", "-P", "-i"].includes(flag)) unknown(line);
        if (["-e", "--rsh", "--exclude", "--include", "-o", "-P", "-i"].includes(flag)) {
          if (!words.length) unknown(line);
          flags.push(tokens(words.shift()!)[0]!);
        }
      }
      const operands = words.filter((word) => !word.startsWith(">") && !/^[0-9]+>/.test(word));
      const destination = operands.pop();
      const remote = /^(ops|commonswarm)@[^:]+:(\/.*)$/.exec(tokens(destination ?? "")[0] ?? "");
      if (!remote || !operands.length || operands.some((word) => /^[^/]+@[^:]+:/.test(tokens(word)[0]!))) unknown(line);
      const segments = (raw: string): Array<{ value: string; quote: string }> => {
        const result: Array<{ value: string; quote: string }> = [];
        let quote = "", value = "";
        for (const char of raw) {
          if (char === "\\" && quote !== "'") unknown(line);
          if ((char === "'" || char === '"') && (!quote || quote === char)) {
            if (value) result.push({ value, quote });
            value = ""; quote = quote ? "" : char;
          } else value += char;
        }
        if (quote) unknown(line);
        if (value) result.push({ value, quote });
        return result;
      };
      const values = (raw: string): string[] => {
        const parts = segments(raw);
        let words = [""];
        for (const part of parts) {
          if (part.quote !== "'" && /\$\(|`/.test(part.value)) unknown(line);
          if (part.quote !== "'" && /\$\{|\$[@*]/.test(part.value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ""))) unknown(line);
          const resolved = part.quote === "'" ? [part.value] : expand(part.value);
          if (!part.quote && (/[{}*?\[\]]/.test(part.value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "")) ||
            resolved.some((value) => /[*?\[\]]/.test(value)))) unknown(line);
          const fields = resolved.flatMap((value) => {
            if (part.quote || !/\$/.test(part.value) || !/\s/.test(value)) return [value];
            // Prefix/suffix concatenation across split fields needs a fuller
            // grammar. A bare variable has unambiguous shell field splitting.
            if (parts.length !== 1 || !/^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(raw)) unknown(line);
            return value.split(/\s+/).filter(Boolean);
          });
          words = words.flatMap((prefix) => fields.map((field) => prefix + field));
        }
        return words;
      };
      const iterationNames = (raw: string): string[] => [...new Set(segments(raw).filter((part) => part.quote !== "'")
        .flatMap((part) => [...part.value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)]
          .map((match) => match[1] ?? match[2]!)).filter((name) => expand(`$${name}`).length > 1))];
      const destinations = values(destination!);
      const paths = destinations.map((value) => /^(?:ops|commonswarm)@[^:]+:(\/.*)$/.exec(value)?.[1] ?? unknown(line));
      if (!paths.length || (operands.length > 1 && paths.some((path) => !path.endsWith("/")))) unknown(line);
      for (const operand of operands) {
        // A quoted literal containing spaces is one argv. An unquoted variable
        // can split into several. Brace/glob/array forms require a grammar we
        // do not own: refuse them instead of inventing one symbolic filename.
        const sources = values(operand);
        // Two independently expanded sides need their iteration relationship,
        // not an index zip that can silently omit a source/destination pair.
        if (!sources.length || sources.some((source) => !source)) unknown(line);
        if (paths.length > 1 && sources.length > 1) {
          const sourceNames = iterationNames(operand), destinationNames = iterationNames(destination!);
          if (sources.length !== paths.length || sourceNames.length !== 1 || destinationNames.length !== 1 ||
            sourceNames[0] !== destinationNames[0]) unknown(line);
        }
        if (sources.length > 1 && paths.length === 1 && !paths[0]!.endsWith("/")) unknown(line);
        for (let n = 0; n < Math.max(paths.length, sources.length); n++) {
          const path = paths[n] ?? paths[0]!;
          const source = sources[n] ?? sources[0]!;
          assertWriterDestination(path);
          operations.push({ transport: command, flags, transfer: {
            path: path.endsWith("/") && !source.endsWith("/") ? path + source.split("/").at(-1)! : path,
            source, mode: "0600", owner: `${remote![1]}:${remote![1]}`,
            ...(command === "rsync" && source.endsWith("/") ? { kind: "directory" as const } : {}),
          } });
        }
      }
      continue;
    }
    if (!/\bssh\s/.test(line) && /[A-Za-z_][A-Za-z0-9_-]*@[^\s:]+:/.test(line)) unknown(line);
    const ssh = /\bssh\s/.exec(line);
    if (!ssh) continue;
    const captured = /([A-Za-z_][A-Za-z0-9_]*)="?\$\($/.exec(line.slice(0, ssh.index).trim());
    let capture: RemoteOperation["capture"];
    if (captured) {
      let tail = lines.slice(i + 1).join("\n");
      // Preserve the producer's actual local calculations and writer after its
      // SSH output arrives. Transfers remain separate ordered operations.
      const assignment = /^\s*[A-Za-z_][A-Za-z0-9_]*=/m.exec(tail);
      if (assignment) tail = tail.slice(assignment.index);
      tail = tail.split(/^\s*(?:scp|rsync|ssh)\s/m)[0]!.replace(/\n\)\s*$/, "");
      capture = { name: captured[1]!,
        ...(/\.env["']/.test(tail) && /printf '[^'\n]*%q/.test(tail)
          ? { localStateSource: tail } : {}) };
    }
    const sshPipelines = shellCommands(line.slice(ssh.index), true);
    const refuse = (cause?: unknown): never => {
      throw new Error(`${block.file}:${block.line} ${block.step}: unsupported Mac SSH pipeline: ${sshPipelines[0]!.trim()}`, { cause });
    };
    // The adjacency scan also parses pipe consumers when their argv mentions
    // ssh. Keep those strict executable refusals at the owning pipeline's
    // boundary; list-separated neighbors retain their own errors.
    if (sshPipelines.some((pipeline, index) => {
      const commands = shellCommands(pipeline);
      if (index === 0) commands.shift();
      try { return commands.some((text) => /\bssh\b/.test(text) && executableWords(text)[0] === "ssh"); }
      catch (error) {
        if (index === 0) return refuse(error);
        throw error;
      }
    })) {
      throw new Error(`${block.file}:${block.line} ${block.step}: unknown transfer form: multiple SSH commands on one Mac line: ${line.trim()}`);
    }
    let sshText = sshPipelines[0]!.trim();
    // A close of the enclosing Mac command substitution ends ssh too. Any
    // redirections after it belong to the outer command, not the remote stdin.
    let substitutionQuote = "", substitutionEscape = false;
    for (let n = 0; line.slice(0, ssh.index).includes("$(") && n < sshText.length; n++) {
      const c = sshText[n]!;
      if (substitutionEscape) { substitutionEscape = false; continue; }
      if (c === "\\" && substitutionQuote !== "'") { substitutionEscape = true; continue; }
      if (substitutionQuote) { if (c === substitutionQuote) substitutionQuote = ""; continue; }
      if (c === "'" || c === '"') { substitutionQuote = c; continue; }
      if (c === ")") { sshText = sshText.slice(0, n); break; }
    }
    const sshCommand = shellCommands(sshText)[0]!;
    if (sshCommand.length < sshText.length) {
      // Inventory the local pipe consumers before projecting just SSH. A
      // retained stdout writer has no replay here and must not borrow bytes
      // from an unrelated transfer. Non-stdout consumers (e.g. archive
      // extraction) retain their existing boundary handling.
      let paths: string[];
      try { paths = outputPaths(sshText.slice(sshCommand.length), expand).flatMap(expand); }
      catch (error) { return refuse(error); }
      if (/^\s*\|&?\s*$/.test(sshText.slice(sshCommand.length))) refuse();
      if (paths.some((path) => path !== "/dev/null")) refuse();
      sshText = sshCommand.trim();
    }
    const sshHere = /<<(-?)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(sshText);
    if (sshHere && here?.[3] !== sshHere[3]) unknown(line);
    let command = sshText;
    // Stop at the Mac redirection, pipeline or command-substitution close, while
    // respecting quotes and escapes inside the remote command string.
    let quote = "", escaped = false, end = command.length;
    for (let n = 0; n < command.length; n++) {
      const c = command[n]!;
      if (escaped) { escaped = false; continue; }
      if (c === "\\" && quote !== "'") { escaped = true; continue; }
      if (quote) { if (c === quote) quote = ""; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (["<", ">", "|", ")", ";"].includes(c)) {
        const descriptor = ["<", ">"].includes(c) ? /\s([0-9]+)$/.exec(command.slice(0, n))?.[1] : undefined;
        end = n - (descriptor?.length ?? 0);
        break;
      }
    }
    command = command.slice(0, end).trim();
    const commandVariable = /\s"\$([A-Za-z_][A-Za-z0-9_]*)"$/.exec(command)?.[1];
    const formatter = commandVariable && new RegExp(`^\\s*printf -v ${commandVariable} '%q ' ([^\\n]+)$`, "m")
      .exec(lines.slice(0, i).join("\n"));
    if (formatter && /\$\(|`/.test(formatter[1]!)) unknown(line);
    const formatted = formatter ? { localArgvSource: formatter[0]!.trim() } : {};
    const localOutputPaths = outputPaths(sshText.slice(end), expand).flatMap(expand)
      .filter((path) => path !== "/dev/null");
    const localOutputs = localOutputPaths.length ? { localOutputPaths } : {};
    if (!/\b(?:ops|commonswarm)@(?:100\.115\.66\.74|yulan-vps-1)\b/.test(command)) unknown(line);
    if (!sshHere) {
      const input = /(?<!<)<(?!<)\s*("[^"]+"|'[^']+'|[^\s)]+)/.exec(sshText.slice(end));
      if (input) {
        const path = tokens(input[1]!)[0]!;
        const found = scripts.get(path);
        // Data-file stdin must remain a dependency. Executable bash stdin
        // still needs its visible writer; no opaque script is admitted here.
        if (!found) {
          // External data stdin has exact plan writers. Keep the full
          // commands pinned independently of the plan being inspected: a
          // mutation must not become its own admission rule.
          const writer = /^ssh -o BatchMode=yes ops@(?:100\.115\.66\.74|yulan-vps-1)\s+([\s\S]+)$/.exec(command);
          const remote = String.raw`"sudo -n -i /bin/bash -c 'set -euo pipefail; umask 077; test ! -e \"$STAGING_ROOT/human-session.json\"; test ! -L \"$STAGING_ROOT/human-session.json\"; cat >\"$STAGING_ROOT/human-session.json\"; chmod 0600 \"$STAGING_ROOT/human-session.json\"'"`;
          const cleanup = String.raw`"sudo -n python3 -c '
import os, pathlib, sys
proof = pathlib.Path(\"/home/commonswarm/stack/release-proofs/eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922\")
required = sys.argv[1] == \"yes\"
exists = proof.is_dir() and not proof.is_symlink()
assert exists or (not required and not proof.exists() and not proof.is_symlink()), \"FAIL hm37a-prep-cleanup-transfer: active proof missing or unsafe\"
data = sys.stdin.buffer.read()
if exists:
    dest = proof / \"hm37a-prep-cleanup.json\"
    assert not dest.is_symlink(), \"FAIL hm37a-prep-cleanup-transfer: receipt symlink\"
    dest.write_bytes(data)
    os.chown(dest, 0, 0)
    os.chmod(dest, 0o600)
    state = dest.stat()
    assert dest.is_file() and dest.read_bytes() == data and (state.st_uid, state.st_gid, state.st_mode & 0o777) == (0, 0, 0o600), \"FAIL hm37a-prep-cleanup-transfer: destination verification\"
    print(\"hm37a-prep-cleanup-transfer: verified\")
else:
    print(\"hm37a-prep-cleanup-transfer: early abort; Mac receipt retained\")
' '$REQUIRE_PROOF'"`;
          const cleanupWriter = block.step === "hm37a-prep-seat-cleanup" &&
            path === "$CLEANUP_RECEIPT" && writer?.[1] === cleanup;
          const failure = String.raw`"sudo -n -i /bin/bash -c 'set -euo pipefail; proof=/home/commonswarm/stack/release-proofs/$SHA; test -d \"\$proof\"; test ! -L \"\$proof\"; umask 077; cat >\"\$proof/$FILE\"; chmod 0600 \"\$proof/$FILE\"'"`;
          const failureWriter = block.step === "hm37a-failure-evidence-transfer" &&
            path === "$EVIDENCE_DIR/$FILE" && writer?.[1] === failure &&
            /^\s*for FILE in hm37a-local-control-old\.json hm37a-local-control-new\.json hm37-loopback-boundaries\.json hm37-public-boundaries\.json hm37-mcp-hostname-boundaries\.json; do$/m.test(block.source);
          const resume = String.raw`'sudo -n python3 -c '\''import json,os,pathlib,sys; p=pathlib.Path("/home/commonswarm/stack/release-proofs/eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922"); assert p.is_dir() and not p.is_symlink(), "FAIL resume-transfer/proof"; data=sys.stdin.buffer.read(); v=json.loads(data); inv=json.loads((p/"hm37a-prep-seat-inventory.json").read_text()); assert len(v["principal_ids"])==len(set(v["principal_ids"]))==3 and set(v["principal_ids"])==set(s["principal_id"] for s in inv["seats"]), "FAIL resume-transfer/receipt-principals"; assert v["workspace_id"]=="c2ea0541-f56d-4c73-bf71-56c5405c4934" and v["revoked_readback"] is True and v["active_unexpired_token_count"]==0, "FAIL resume-transfer/receipt-state"; f=p/"hm37a-prep-cleanup.json"; assert not f.is_symlink(), "FAIL resume-transfer/symlink"; f.write_bytes(data); os.chown(f,0,0); os.chmod(f,0o600); assert f.read_bytes()==data and f.stat().st_uid==0 and f.stat().st_gid==0 and f.stat().st_mode & 0o777==0o600, "FAIL resume-transfer/destination"'\'''`;
          const resumeWriter = block.step === "hm37a-close-resume-transfer" && path === "$FILE" && writer?.[1] === resume;
          if ((writer?.[1] !== remote && !cleanupWriter && !failureWriter && !resumeWriter) || sshText.slice(end).trim() !== input[0].trim() ||
              /[\x60*?]|\$\(|\$\{[^}]*[@*]/.test(path)) unknown(line);
        }
        operations.push({ remote: { command: commandExpansion(command), ...(found ?? { stdinFile: expand(path)[0]! }), ...formatted, ...localOutputs, ...(capture ? { capture } : {}) } });
        continue;
      }
      if (/\bbash\s+-s\b/.test(command)) {
        const prefix = line.slice(0, ssh.index);
        if (!here || script === undefined || !/^\s*python3\s+-\s+"[^"\n]+"\s+<<'[^']+'\s*\|\s*$/.test(prefix)) unknown(line);
        operations.push({ remote: { command: commandExpansion(command), script: selectedPlanScript(block, prefix, script!),
          delimiter: "'PLAN_SELECTED'", ...localOutputs } });
        continue;
      }
    }
    operations.push({ remote: { command: commandExpansion(command), ...formatted, ...localOutputs, ...(capture ? { capture } : {}), ...(sshHere && script !== undefined
      ? { script, delimiter: `${sshHere[1]}${sshHere[2]}${sshHere[3]}${sshHere[2]}` } : {}) } });
  }
  return operations;
}

// A writer can follow a pipeline or a list operator. Quoted payloads and escaped
// operators remain data; parsing them as commands would invent remote products.
function shellCommands(line: string, retainPipeline = false): string[] {
  const commands: string[] = [];
  const substitutions = new Map(substitutionPrograms(line).spans.map(({ start, end }) => [start, end]));
  let start = 0, quote = "", escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    // Keep substitution programs intact; their list/pipeline operators and
    // quotes do not delimit the containing command's argv or pipeline.
    const substitutionEnd = substitutions.get(index);
    if (substitutionEnd !== undefined) { index = substitutionEnd; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "#" && shellCommentStart(line, index)) {
      commands.push(line.slice(start, index));
      const newline = line.indexOf("\n", index);
      if (newline < 0) return commands.filter((command) => command.trim());
      index = newline;
      start = index + 1;
      continue;
    }
    if (char === "\n" || char === ";" || (char === "|" && line[index - 1] !== ">" &&
        (!retainPipeline || line[index + 1] === "|" || line[index - 1] === "|")) ||
        (char === "&" && !/[<>]/.test(line[index - 1] ?? "") && !(retainPipeline && line[index - 1] === "|"))) {
      commands.push(line.slice(start, index));
      start = index + 1;
    }
  }
  commands.push(line.slice(start));
  return commands.filter((command) => command.trim());
}

// Read shell words at the executable boundary, rather than matching a bare
// command spelling anywhere in the line. Quoting and escapes may spell an
// executable path; they do not make quoted payloads into executable tokens.
function executableWords(command: string): string[] {
  const words: string[] = [];
  const rawWords: string[] = [];
  const dynamicBasenames: boolean[] = [];
  let dynamic = false;
  let word = "", raw = "", started = false, quote = "", escaped = false;
  const flush = (): void => {
    if (started) { words.push(word); rawWords.push(raw); dynamicBasenames.push(dynamic); }
    word = ""; raw = ""; started = false; dynamic = false;
  };
  for (const char of command.trimStart()) {
    if (escaped) {
      raw += char;
      // In double quotes a backslash only quotes these shell characters.
      if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(char)) word += "\\";
      word += char; started = true; escaped = false; continue;
    }
    if (char === "\\" && quote !== "'") { raw += char; escaped = true; started = true; continue; }
    if (quote) {
      raw += char;
      if (char === quote) quote = "";
      else {
        if (char === "/") dynamic = false;
        if (quote !== "'" && ["$", "`", "\0"].includes(char)) dynamic = true;
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') { raw += char; quote = char; started = true; continue; }
    if (/\s/.test(char)) { flush(); continue; }
    if (char === "#" && !started) break;
    // Redirection targets are inventoried separately. Do not split a quoted
    // operand containing an operator, or count a descriptor as a file operand.
    if (char === "<" || char === ">") { if (!/^\d*$/.test(word)) flush(); else { word = ""; raw = ""; started = false; } break; }
    if (char === "/") dynamic = false;
    if (["$", "`", "\0"].includes(char)) dynamic = true;
    raw += char; word += char; started = true;
  }
  flush();
  const name = (value: string | undefined): string => value?.split("/").at(-1) ?? "";
  const shift = (): string | undefined => { rawWords.shift(); dynamicBasenames.shift(); return words.shift(); };
  // Shell assignment names must be unquoted. env/sudo instead receive ordinary
  // argv, where a quoted NAME=value word still defines their environment.
  while (/^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\+?=/.test(rawWords[0] ?? "")) {
    // Arithmetic/command substitutions contain whitespace that is not an
    // executable argv boundary. Their outer assignment is not a command.
    if (rawWords[0]!.includes("$(") || /^[^=]+=\(/.test(rawWords[0]!)) return [];
    shift();
  }
  while (["sudo", "env", "command", "exec"].includes(name(words[0]))) {
    if (dynamicBasenames[0] || words[0]?.includes(CAPTURED_STDOUT)) {
      throw new Error(`unknown writer executable form: ${command.trim()}`);
    }
    const wrapper = name(shift());
    while (words[0]?.startsWith("-")) {
      const option = shift()!;
      if (option === "--") break;
      if (wrapper === "sudo" && ["-u", "-g", "--user", "--group"].includes(option)) {
        if (!shift()) throw new Error(`unknown writer executable form: ${command.trim()}`);
      } else if (!(wrapper === "sudo" ? /^-[niH]+$/.test(option) || ["--non-interactive", "--login"].includes(option)
        : wrapper === "env" ? ["-i", "--ignore-environment"].includes(option)
        : wrapper === "command" && option === "-p")) {
        throw new Error(`unknown writer executable option: ${option}`);
      }
    }
    if (["env", "sudo"].includes(wrapper)) {
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) shift();
    }
  }
  if (words.length) {
    const casePattern = rawWords[0]!.endsWith(")");
    const capturedExecutable = words[0]!.includes(CAPTURED_STDOUT);
    words[0] = name(words[0]);
    // An unresolved executable can be a writer. Its directory may be symbolic
    // when its basename is literal, but guessing a variable basename loses
    // ownership silently (e.g. T=/usr/bin/tee followed by $T).
    if ((dynamicBasenames[0] && !casePattern) || capturedExecutable) {
      throw new Error(`unknown writer executable form: ${command.trim()}`);
    }
    // This filename-list command only emits digests on stdout; its surrounding
    // redirection is inventoried independently. No xargs operand can become a
    // writer destination here. Other xargs programs still refuse visibly.
    let utility = name(words[2]);
    if (rawWords[2] === words[2]) utility = utility.replace(/\)$/, "");
    if (words[0] === "xargs" && words.length === 3 && words[1] === "-0" &&
        utility === "sha256sum" && !dynamicBasenames[2]) return [utility];
    // These utilities execute another argv. Until their option grammars are
    // supported, refusing the envelope keeps wrapped writers visible.
    if (["nice", "nohup", "timeout", "stdbuf", "ionice", "setsid", "chrt", "xargs", "time"].includes(words[0]!)) {
      throw new Error(`unknown writer executable wrapper: ${command.trim()}`);
    }
  }
  return words;
}

// Command substitutions execute even inside a double-quoted assignment. Pull
// complete programs out before splitting pipelines; single-quoted prose and
// escaped dollars remain data. Replacing only the capture keeps its stdout
// from masquerading as an executable or a writer operand in the outer command.
function substitutionPrograms(line: string, arithmetic = false): { outer: string; programs: string[]; incomplete: boolean; spans: Array<{ start: number; end: number }> } {
  let quote = "", escaped = false, start = 0, outer = "";
  let incomplete = false;
  const programs: string[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (char === "'" && quote !== '"') { quote = quote === "'" ? "" : "'"; continue; }
    if (char === '"' && quote !== "'") { quote = quote === '"' ? "" : '"'; continue; }
    if (char === "#" && !quote && shellCommentStart(line, index)) {
      const newline = line.indexOf("\n", index);
      if (newline < 0) break;
      index = newline;
      continue;
    }
    if (quote === "'") continue;
    if (char === "`") {
      let end = index + 1, program = "";
      for (; end < line.length && line[end] !== "`"; end++) {
        // Legacy substitution removes escapes for $, ` and backslash before
        // interpreting its body. An escaped inner backtick is a nested capture.
        if (line[end] === "\\" && ["$", "`", "\\"].includes(line[end + 1] ?? "")) end++;
        program += line[end];
      }
      if (end === line.length) { incomplete = true; continue; }
      spans.push({ start: index, end });
      programs.push(program);
      outer += line.slice(start, index) + CAPTURED_STDOUT;
      start = end + 1;
      index = end;
      continue;
    }
    const process = !arithmetic && !quote && ["<", ">"].includes(char) && line[index + 1] === "(";
    const arithmeticCommand = !arithmetic && !quote && char === "(" && line[index + 1] === "(";
    if (!process && !arithmeticCommand && (char !== "$" || line[index + 1] !== "(")) continue;
    let depth = arithmeticCommand ? 2 : 1, innerQuote = "", innerEscape = false, end = index + 2;
    for (; end < line.length; end++) {
      const next = line[end]!;
      if (innerEscape) { innerEscape = false; continue; }
      if (next === "\\" && innerQuote !== "'") { innerEscape = true; continue; }
      if (innerQuote) { if (next === innerQuote) innerQuote = ""; continue; }
      if (next === "'" || next === '"') { innerQuote = next; continue; }
      if (next === "#" && shellCommentStart(line.slice(index + 2), end - index - 2)) {
        const newline = line.indexOf("\n", end);
        if (newline < 0) { end = line.length; break; }
        end = newline;
        continue;
      }
      if (next === "(") depth++;
      if (next === ")" && --depth === 0) break;
    }
    if (depth !== 0) { incomplete = true; continue; }
    spans.push({ start: index, end });
    const program = line.slice(index + 2, end);
    // Arithmetic is data, but any nested command substitutions still execute.
    if (arithmeticCommand) programs.push(...substitutionPrograms(program.slice(0, -1), true).programs);
    else if (!process && program.startsWith("(")) programs.push(...substitutionPrograms(program.slice(1, -1), true).programs);
    else programs.push(program);
    outer += line.slice(start, index) + (arithmeticCommand ? ":" : CAPTURED_STDOUT);
    start = end + 1;
    index = end;
  }
  return { outer: outer + line.slice(start), programs, incomplete, spans };
}

function writerSourceLines(source: string): string[] {
  const lines = outsideHeredocs(source).replace(/\\\n/g, "").split("\n");
  const logical: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!;
    while ((substitutionPrograms(line).incomplete || unclosedShellQuote(line)) && index + 1 < lines.length) line += "\n" + lines[++index]!;
    if (substitutionPrograms(line).incomplete) throw new Error(`unknown writer shell form: unterminated command substitution: ${line.trim()}`);
    if (unclosedShellQuote(line)) throw new Error(`unknown writer shell form: unterminated quote: ${line.trim()}`);
    logical.push(line);
  }
  return logical;
}

// Shell -c is an interpreter boundary, not quoted data. Inspect its literal
// script recursively; positional argv, dynamic scripts and unsupported flags
// refuse visibly rather than returning an incomplete writer inventory.
function writerCommands(line: string, depth = 0, expand?: (value: string) => string[], captured = false): string[] {
  if (depth > 12) throw new Error("unknown writer executable form: nested shell depth");
  const substitutions = substitutionPrograms(line);
  if (substitutions.incomplete) throw new Error(`unknown writer shell form: unterminated command substitution: ${line.trim()}`);
  return [...substitutions.programs.flatMap((program) => writerCommands(program, depth + 1, expand, true)),
    ...shellCommands(substitutions.outer).flatMap((command) => {
    // A captured runtime query can use a path assigned in the owning block.
    // Resolve only its executable word, never the rest of the script or argv.
    // Missing/dynamic values still reach the opaque-executable refusal below.
    if (captured && expand) {
      const variable = /^\s*("?)(\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*))\1(?=\s|$)/.exec(command);
      if (variable) {
        const resolved = expand(variable[2]!);
        if (resolved.length === 1 && /^\/[A-Za-z0-9_./-]+$/.test(resolved[0]!)) {
          command = `'${resolved[0]}'` + command.slice(variable[0].length);
        }
      }
    }
    let words: string[];
    try { words = executableWords(command); }
    catch (cause) {
      if (depth > 0) throw new Error(`unknown writer shell form: ${command.trim()}`, { cause });
      throw cause;
    }
    if (words[0] === "eval") throw new Error(`unknown writer executable form: ${command.trim()}`);
    if (depth > 0 && ["ssh", "scp"].includes(words[0] ?? "")) {
      throw new Error(`unknown transfer form: nested transport ${command.trim()}`);
    }
    // The contained literal-script projection supports simple commands and
    // pipelines. Control flow/functions need a shell grammar; never silently
    // mistake their keywords or delimiters for a non-writing executable.
    if (depth > 0 && (/[(){}]/.test(words[0] ?? "") ||
        ["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "!"].includes(words[0] ?? ""))) {
      throw new Error(`unknown writer shell form: ${command.trim()}`);
    }
    if (!["sh", "bash"].includes(words[0] ?? "")) return [command];
    const at = words.findIndex((word, index) => index > 0 && (/^-[^-]*c/.test(word) || word === "--command"));
    if (at < 0) return [command];
    const option = words[at]!;
    const literalScript = /(?:-[eluc]*c[eluc]*|--command)\s+'/.test(command);
    if (at !== 1 || !/^-[eluc]+$/.test(option) || words.length !== 3 || (/[$`]/.test(words[2]!) && !literalScript)) {
      throw new Error(`unknown writer shell form: ${command.trim()}`);
    }
    const scriptExpand = expansions({ file: "literal-shell", step: "literal-shell", host: "box ", line: 0,
      source: words[2]!.replace(/;\s*/g, "\n") });
    return writerSourceLines(words[2]!)
      .flatMap((body) => writerCommands(body, depth + 1, expand))
      .flatMap((body) => scriptExpand(body));
  })];
}

function redirectedOutputPaths(line: string): string[] {
  if (/^\s*#/.test(line)) return [];
  const paths: string[] = [];
  let quote = "", escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "#" && shellCommentStart(line, index)) {
      const newline = line.indexOf("\n", index);
      if (newline < 0) break;
      index = newline;
      continue;
    }
    if (char !== ">" || line[index - 1] === "<") continue;
    if (line[index + 1] === ">") index++;
    if (line[index + 1] === "|") index++;
    if (line[index + 1] === "&") continue;
    const target = /^\s*("[^"]+"|'[^']+'|[^\s;|&]+)/.exec(line.slice(index + 1));
    if (target) {
      paths.push(tokens(target[1]!)[0]!);
      index += target[0].length;
    }
  }
  return paths;
}

function outputPaths(line: string, expand?: (value: string) => string[]): string[] {
  const paths = redirectedOutputPaths(substitutionPrograms(line).outer);
  // curl owns both its response body and header file even when stdout is
  // captured for the status code. Parse command operands, not quoted prose or
  // the response URL. These paths have the same producer/consumer contract as
  // shell redirections.
  for (const command of writerCommands(line, 0, expand)) {
    // Redirections inside a shell script belong to that script's producer too.
    if (command !== line) paths.push(...redirectedOutputPaths(command));
    // tee is a writer even in a pipeline, with an environment assignment, or
    // behind sudo. Inspect command operands so quoted prose and stdin bodies
    // cannot invent products. Both standalone box and SSH writers use this.
    const executable = executableWords(command);
    if (executable[0] === "tee") {
      const words = executable.slice(1);
      let operands = false;
      for (const word of words) {
        if (!operands && word === "--") { operands = true; continue; }
        if (!operands && ["-a", "--append", "-i", "--ignore-interrupts"].includes(word)) continue;
        if (!operands && word.startsWith("-")) throw new Error(`unknown tee writer option: ${word}`);
        paths.push(word);
      }
    }
    // Captured curl and tee use the same executable boundary above.
    const curl = executable;
    if (curl[0] !== "curl") continue;
    const words = curl.slice(1);
    for (let index = 0; index < words.length; index++) {
      const word = words[index]!;
      if (["-o", "--output", "-D", "--dump-header"].includes(word)) {
        const path = words[++index];
        if (!path) throw new Error(`unknown curl writer form: ${command.trim()}`);
        paths.push(path);
      } else {
        const joined = /^(?:--output=|--dump-header=|-o(?=.)|-D(?=.))(.+)$/.exec(word);
        if (joined) paths.push(joined[1]!);
      }
    }
  }
  for (const path of paths) assertWriterDestination(path);
  return paths;
}

function assertWriterDestination(path: string): void {
  if (path.includes(CAPTURED_STDOUT)) {
    throw new Error(`unknown writer destination form: ${path}`);
  }
}

// Mac-local SSH sinks and post-capture writers keep their producing operation,
// so an unrelated transfer cannot borrow their coverage. Discovery supplies no
// bytes: a later transfer still requires the writer's actual retained file.
export function capturedMacProducts(block: HandoffBlock): Array<{ path: string; producer: RemoteOperation }> {
  return macBoundaryOperations(block).flatMap((operation) => {
    if (!("remote" in operation)) return [];
    const local = operation.remote.localOutputPaths ?? [];
    if (!operation.remote.capture?.localStateSource) return local.map((path) => ({ path, producer: operation.remote }));
    const source = operation.remote.capture.localStateSource;
    const expand = expansions({ ...block, source: outsideHeredocs(source) });
    // /dev/null discards a probe's stdout; it is not a retained writer product
    // that a later transfer can consume or use to claim producer coverage.
    return [...local, ...writerSourceLines(source).flatMap((line) => outputPaths(line, expand).flatMap(expand))]
      .filter((path) => path !== "/dev/null").map((path) => ({ path, producer: operation.remote }));
  });
}

export function capturedMacProductPaths(block: HandoffBlock): string[] {
  return capturedMacProducts(block).map((product) => product.path);
}

// Local copies retain both operands. A read can claim this writer only when
// its source is an input or an earlier product; a shared basename is not enough.
export function localCopyProducts(block: HandoffBlock): Array<{ source: string; path: string }> {
  // Read-discovery prefixes can end inside non-shell source or quoted data.
  // Validate copy grammar only when the executable boundary actually has cp.
  const commands = shellCommands(block.source.replace(/\\\n/g, ""));
  if (!commands.some((command) => executableWords(command)[0] === "cp")) return [];
  const expand = expansions({ ...block, source: outsideHeredocs(block.source) });
  return writerSourceLines(block.source).flatMap((line) => writerCommands(line, 0, expand).flatMap((command) => {
    const words = executableWords(command);
    if (words[0] !== "cp") return [];
    const operands = words.slice(1);
    while (operands[0]?.startsWith("-")) {
      const option = operands.shift()!;
      if (option === "--") break;
      if (!/^-[apfrRv]+$/.test(option) && !["--reflink=auto", "--reflink=always", "--reflink=never"].includes(option)) {
        throw new Error(`unknown local copy option: ${option}`);
      }
    }
    if (operands.length !== 2) throw new Error(`unknown local copy form: ${command.trim()}`);
    const sources = expand(operands[0]!), paths = expand(operands[1]!);
    if (sources.length !== 1 || paths.length !== 1) throw new Error(`unknown local copy form: ${command.trim()}`);
    assertWriterDestination(paths[0]!);
    // A trailing slash proves a directory operand, not a retained file path.
    // Source type/basename expansion is not established by this copy grammar.
    if (paths[0]!.endsWith("/")) throw new Error(`unknown local copy directory destination: ${command.trim()}`);
    return [{ source: sources[0]!, path: paths[0]! }];
  }));
}

function shellWrites(block: HandoffBlock): TransferProduct[] {
  const expand = expansions({ ...block, source: outsideHeredocs(block.source) });
  const products = new Map<string, TransferProduct>();
  const add = (expression: string, mode = "0600", kind: "file" | "directory" = "file", source = ""): void => {
    for (const path of expand(expression)) {
      assertWriterDestination(path);
      if (!/^\/(?:home|run|tmp|srv)\//.test(path) && !/^\$/.test(path)) continue;
      products.set(path, { path, source, mode, owner: "root:root", remote: true, kind });
    }
  };
  const lines = writerSourceLines(block.source);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    if (UNKNOWN_TRANSPORT.test(line) || /\b(?:curl|wget)\b.*(?:--upload-file|--post-file|--data-binary|-T)\b/.test(line)) {
      throw new Error(`${block.file}:${block.line}: unknown transfer form: ${line.trim()}`);
    }
    for (const path of outputPaths(line, expand)) add(path);
    for (const commandText of writerCommands(line, 0, expand)) {
      // Strip stdin/stdout redirections before taking a destination operand.
      const words = executableWords(commandText);
      const command = words[0];
      if (["scp", "ssh"].includes(command ?? "")) {
        throw new Error(`${block.file}:${block.line}: unknown transfer form: ${line.trim()}`);
      }
      const mode = words.includes("-m") ? words[words.indexOf("-m") + 1]! : "0600";
      if (["install", "cp", "mv", "ln"].includes(command ?? "")) {
        add(words.at(-1)!, mode, words.includes("-d") ? "directory" : "file", words.at(-2));
      } else if (command === "mkdir" && words.includes("-p")) {
        const operands = words.slice(1).filter((word, index, rest) => !word.startsWith("-") && rest[index - 1] !== "-m");
        for (const operand of operands) add(operand, words.includes("-m") ? mode : "0755", "directory");
      } else if (command === "rsync") {
        const flags = words.slice(1).filter((word) => word.startsWith("-"));
        const operands = words.slice(1).filter((word) => !word.startsWith("-"));
        if (flags.some((flag) => !/^-[avzhn]+$/.test(flag) && !["--delete", "--ignore-existing", "--relative"].includes(flag)) ||
            operands.length !== 2 || operands.some((operand) => operand.includes("@"))) {
          throw new Error(`${block.file}:${block.line}: unknown transfer form: ${line.trim()}`);
        }
        add(operands[1]!, "0755", "directory", operands[0]);
      } else if (command === "tar" && words.some((word) => /^-[^-]*x/.test(word) || word === "--extract")) {
        const at = words.findIndex((word) => word === "-C" || word === "--directory");
        if (at >= 0) add(words[at + 1]!, "0755", "directory");
        else throw new Error(`${block.file}:${block.line}: unknown transfer form: ${line.trim()}`);
      }
    }
  }
  return [...products.values()];
}

export function transferProducts(block: HandoffBlock): TransferProduct[] {
  const operations = macBoundaryOperations(block);
  const products = new Map<string, TransferProduct>();
  for (const operation of operations) {
    if ("transfer" in operation) { products.set(operation.transfer.path, operation.transfer); continue; }
    const remote = operation.remote;
    const host = /\b(?:ops|commonswarm)@[^\s'";]+/.exec(remote.command)!;
    let command = remote.command.slice(host.index + host[0].length).trim();
    if (remote.localArgvSource) {
      const formatter = /^printf -v ([A-Za-z_][A-Za-z0-9_]*) '%q ' (.+)$/.exec(remote.localArgvSource)!;
      if (command !== `"$${formatter[1]}"`) throw new Error(`${block.file}:${block.line}: unknown formatted SSH argv`);
      command = formatter[2]!;
    } else {
      // SSH joins its command argv. Remove the enclosing Mac quote, preserving
      // the quotes that the remote shell receives inside that argument.
      command = planShellWords(command).join(" ");
    }
    // Outer assignments resolve argv such as STAGING_ROOT. Do not treat the Mac's
    // local writes as remote; only this SSH command and its stdin are inspected.
    const outer = expansions({ ...block, source: outsideHeredocs(block.source) });
    const argv = /\bbash -s -- (.*)/.exec(command)?.[1];
    if (/\bbash\s+-s\b/.test(command) && remote.stdinProducer) {
      throw new Error(`${block.file}:${block.line}: unknown transfer form: generated bash stdin from ${remote.stdinProducer.path}`);
    }
    let body = /\bbash\s+-s\b/.test(command) ? remote.script ?? "" : command;
    // A quoted delimiter suppresses expansion by the Mac shell. An unquoted
    // heredoc expands there before ssh sends the bytes to the remote shell.
    if (remote.script !== undefined && !/["']/.test(remote.delimiter ?? "")) body = outer(body)[0]!;
    if (argv) {
      const args = tokens(argv);
      body = body.replace(/\$\{([1-9][0-9]*)\}|\$([1-9])(?![0-9])/g,
        (original, braced: string | undefined, plain: string | undefined) => {
          const argument = args[Number(braced ?? plain) - 1];
          if (argument && /[$`]/.test(argument) && outer(argument).some((value) => value !== argument)) {
            if (remote.localArgvSource && outer(argument).length === 1) return outer(argument)[0]!;
            throw new Error(`${block.file}:${block.line}: unknown transfer form: unresolved SSH positional argv ${argument}`);
          }
          return argument ?? original;
        });
    }
    for (const product of shellWrites({ ...block, source: command + "\n" + body })) {
      if (!products.has(product.path) || product.path.startsWith("/home/") || product.kind === "directory") products.set(product.path, product);
    }
  }
  return [...products.values()];
}

export function blockPathReferences(block: HandoffBlock): string[] {
  const expand = expansions(block);
  const expressions = block.source.match(/(?:\/(?:home|run|tmp|srv)\/|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/)[a-zA-Z0-9_./${}*-]+|\$(?:WINDOW_ENV|SESSION)\b/g) ?? [];
  return [...new Set(expressions.flatMap(expand))];
}

export function crossHostHandoffs(blocks: HandoffBlock[]): Handoff[] {
  const release = /test "\$RELEASE_SHA" = ([0-9a-f]{40})/.exec(blocks.map((b) => b.source).join("\n"))?.[1];
  const normalize = (path: string): string => release ? path.replaceAll(release, "{sha}") : path;
  const inventory = new Map<string, Handoff>();
  const add = (handoff: Handoff): void => {
    const key = `${handoff.producer.file}:${handoff.producer.step}:${handoff.consumer.file}:${handoff.consumer.step}:${handoff.path}`;
    inventory.set(key, handoff);
  };
  const references = new Map(blocks.map((block) => [block, blockPathReferences(block).map(normalize)]));
  // Discover the curated archive's allowed member names from the manifest producer, including item lists.
  // A proof-directory scratch file is not a readback simply because another block uses tar -T.
  const memberExpressions = blocks.flatMap((block) => [
    ...[...block.source.matchAll(/COPY_BACK_FILES\+?=\(([\s\S]*?)\)/g)].flatMap((match) => tokens(match[1]!)),
    ...[...block.source.matchAll(/cat >[^\n]*item-copy-back-files\.list[^\n]*<<'FILES'\n([\s\S]*?)\nFILES/g)]
      .flatMap((match) => match[1]!.split("\n")),
  ]).filter((name) => name && !name.startsWith("#") && (!name.includes("$") || /\$\{VERSION\}/.test(name)));
  const admitted = memberExpressions.map((expression) => {
    const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\$\\\{VERSION\\\}/g, "[0-9]{14}");
    return new RegExp(`^${escaped}$`);
  });
  for (const producer of blocks) {
    if (!producer.host.startsWith("box ")) {
      for (const product of transferProducts(producer)) {
        const consumers = blocks.filter((block) => block.host.startsWith("box ") && references.get(block)!.includes(normalize(product.path)));
        // The ssh install is itself a consumer on the other host, even if no standalone box block reads it.
        for (const consumer of consumers.length ? consumers : [producer]) add({
          producer, consumer, direction: "mac-to-box", ...product, path: normalize(product.path),
        });
      }
      continue;
    }
    const expand = expansions({ ...producer, source: outsideHeredocs(producer.source) });
    const writes = writerSourceLines(producer.source)
      .flatMap((line) => {
        if (!/^\s*#/.test(line) && UNKNOWN_TRANSPORT.test(line)) {
          throw new Error(`${producer.file}:${producer.line}: unknown transfer form: ${line.trim()}`);
        }
        return outputPaths(line, expand).flatMap(expand);
      }).map(normalize)
      .filter((path) => /^\/(?:home|run|tmp|srv)\//.test(path));
    // A handoff can be a copied file or a switched symlink as well as redirected stdout.
    for (const line of writerSourceLines(producer.source).flatMap((line) => writerCommands(line, 0, expand))) {
      if (/^\s*#/.test(line)) continue;
      const words = executableWords(line);
      if (!["cp", "mv", "ln", "install"].includes(words[0] ?? "") || words.includes("-d")) continue;
      const destination = words.filter((word) => !word.startsWith(">") && !/^[0-9]+>/.test(word)).at(-1);
      if (destination) {
        assertWriterDestination(destination);
        writes.push(...expand(destination).map((path) => { assertWriterDestination(path); return normalize(path); })
          .filter((path) => /^\/(?:home|run|tmp|srv)\//.test(path)));
      }
    }
    for (const path of new Set(writes)) {
      for (const consumer of blocks.filter((block) => !block.host.startsWith("box "))) {
        const direct = references.get(consumer)!.includes(path);
        // Curated archives consume box proof products through -T. Include the producer-owned members
        // as well as the manifest; the whole copy-back block checks the actual selected membership.
        const privateFile = /\/(?:window\.env|[^/]*\.err)$/.test(path) || (path.endsWith(".log") && !path.endsWith(".docker.log"));
        const selectedMember = admitted.some((pattern) => pattern.test(path.split("/").at(-1)!)) || path.endsWith(".docker.log");
        const manifest = /\/release-proofs\//.test(path) && !privateFile && selectedMember && /tar .* -T .*copy-back\.list/.test(consumer.source);
        if (direct || manifest) add({ producer, consumer, path, direction: "box-to-mac" });
      }
    }
  }
  return [...inventory.values()];
}
