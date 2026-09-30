// Shell-text inventory for the documented host boundary, independent of fixture coverage.
// Paths stay symbolic here: the boundary adapter resolves them for its particular fixture.
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
const tokens = (line: string): string[] => (line.match(/(?:"[^"\n]*"|'[^'\n]*'|[^\s;"']+)+/g) ?? [])
  .map((word) => word.replace(/["']/g, ""));

function expansions(block: HandoffBlock): (value: string) => string[] {
  const vars = new Map<string, string[]>([
    ["SHA", ["{sha}"]], ["RELEASE_SHA", ["{sha}"]], ["WINDOW_ID", ["{window}"]],
  ]);
  for (const match of block.source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#]+))\s*$/gm)) {
    const value = match[2] ?? match[3] ?? match[4]!;
    if (!value.includes("$(") && !/^\$[0-9]+$/.test(value) && !["SHA", "RELEASE_SHA", "WINDOW_ID"].includes(match[1]!)) vars.set(match[1]!, [value]);
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
  const expand = (value: string, depth = 0): string[] => {
    if (depth > 12) return [value];
    const match = [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)].find((item) => vars.has(item[1] ?? item[2]!));
    if (!match || !vars.has(match[1] ?? match[2]!)) return [value];
    return vars.get(match[1] ?? match[2]!)!.flatMap((replacement) => expand(
      value.slice(0, match.index) + replacement + value.slice(match.index + match[0].length), depth + 1));
  };
  return (value) => expand(value);
}

export interface RemoteOperation { command: string; script?: string; delimiter?: string; stdinProducer?: { path: string; writers: string[] } }
export type BoundaryOperation = { transfer: TransferProduct; transport: "scp" | "rsync"; flags: string[] } | { remote: RemoteOperation };

// Keep the remote command's shell quoting and here-document bytes. Only the Mac stdout
// sink is removed; it is not a box product. File-fed scripts must have a visible writer.
export function macBoundaryOperations(block: HandoffBlock): BoundaryOperation[] {
  if (block.host.startsWith("box ")) return [];
  const expand = expansions(block);
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
    while (line.endsWith("\\") && i + 1 < lines.length) line = line.slice(0, -1) + " " + lines[++i]!.trimStart();
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
    const words = tokens(line.trim());
    if (["scp", "rsync"].includes(words[0] ?? "")) {
      const command = words.shift()! as "scp" | "rsync";
      const flags: string[] = [];
      while (words[0]?.startsWith("-")) {
        const flag = words.shift()!;
        flags.push(flag);
        const known = command === "scp" ? /^-[prqCv]+$/.test(flag) : /^-[avzhn]+$/.test(flag) || ["--delete", "--ignore-existing", "--relative"].includes(flag);
        if (!known && !["-e", "--rsh", "--exclude", "--include", "-o", "-P", "-i"].includes(flag)) unknown(line);
        if (["-e", "--rsh", "--exclude", "--include", "-o", "-P", "-i"].includes(flag)) {
          if (!words.length) unknown(line);
          flags.push(words.shift()!);
        }
      }
      const operands = words.filter((word) => !word.startsWith(">") && !/^[0-9]+>/.test(word));
      const destination = operands.pop();
      const remote = /^(ops|commonswarm)@[^:]+:(\/.*)$/.exec(destination ?? "");
      if (!remote || !operands.length || operands.some((word) => /^[^/]+@[^:]+:/.test(word))) unknown(line);
      for (const operand of operands) {
        const sources = expand(operand);
        const paths = expand(remote![2]!);
        for (let n = 0; n < paths.length; n++) operations.push({ transport: command, flags, transfer: {
          path: paths[n]!.endsWith("/") && !operand.endsWith("/") ? paths[n]! + (sources[n] ?? sources[0]!).split("/").at(-1)! : paths[n]!, source: sources[n] ?? sources[0]!, mode: "0600", owner: `${remote![1]}:${remote![1]}`,
          ...(command === "rsync" && operand.endsWith("/") ? { kind: "directory" as const } : {}),
        } });
      }
      continue;
    }
    if (!/\bssh\s/.test(line) && /[A-Za-z_][A-Za-z0-9_-]*@[^\s:]+:/.test(line)) unknown(line);
    const ssh = /\bssh\s/.exec(line);
    if (!ssh) continue;
    let command = line.slice(ssh.index).trim();
    // Stop at the Mac redirection, pipeline or command-substitution close, while
    // respecting quotes and escapes inside the remote command string.
    let quote = "", escaped = false, end = command.length;
    for (let n = 0; n < command.length; n++) {
      const c = command[n]!;
      if (escaped) { escaped = false; continue; }
      if (c === "\\" && quote !== "'") { escaped = true; continue; }
      if (quote) { if (c === quote) quote = ""; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (["<", ">", "|", ")", ";"].includes(c)) { end = n; break; }
    }
    command = command.slice(0, end).trim();
    if (!/\b(?:ops|commonswarm)@(?:100\.115\.66\.74|yulan-vps-1)\b/.test(command)) unknown(line);
    if (!here) {
      const input = /(?<!<)<(?!<)\s*("[^"]+"|'[^']+'|[^\s)]+)/.exec(line);
      if (input) {
        const found = scripts.get(tokens(input[1]!)[0]!);
        if (!found) unknown(line);
        operations.push({ remote: { command: commandExpansion(command), ...found! } });
        continue;
      }
      if (/\bbash\s+-s\b/.test(command)) unknown(line);
    }
    operations.push({ remote: { command: commandExpansion(command), ...(script !== undefined ? { script, delimiter: `${here![1]}${here![2]}${here![3]}${here![2]}` } : {}) } });
  }
  return operations;
}

// A writer can follow a pipeline or a list operator. Quoted payloads and escaped
// operators remain data; parsing them as commands would invent remote products.
function shellCommands(line: string): string[] {
  const commands: string[] = [];
  let start = 0, quote = "", escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === ";" || char === "|" || (char === "&" && !/[<>]/.test(line[index - 1] ?? ""))) {
      commands.push(line.slice(start, index));
      start = index + 1;
    }
  }
  commands.push(line.slice(start));
  return commands.filter((command) => command.trim());
}

function outputPaths(line: string): string[] {
  const paths: string[] = [];
  let quote = "", escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char !== ">" || line[index - 1] === "<") continue;
    if (line[index + 1] === ">") index++;
    if (line[index + 1] === "&") continue;
    const target = /^\s*("[^"]+"|'[^']+'|[^\s;|&]+)/.exec(line.slice(index + 1));
    if (target) {
      paths.push(tokens(target[1]!)[0]!);
      index += target[0].length;
    }
  }
  return paths;
}

function shellWrites(block: HandoffBlock): TransferProduct[] {
  const expand = expansions(block);
  const products = new Map<string, TransferProduct>();
  const add = (expression: string, mode = "0600", kind: "file" | "directory" = "file", source = ""): void => {
    for (const path of expand(expression)) {
      if (!/^\/(?:home|run|tmp|srv)\//.test(path) && !/^\$/.test(path)) continue;
      products.set(path, { path, source, mode, owner: "root:root", remote: true, kind });
    }
  };
  const lines = block.source.replace(/\\\n\s*/g, " ").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const here = /<<-?['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (here) while (++index < lines.length && lines[index]!.trim() !== here[1]) { /* stdin data, not shell code */ }
    if (/^\s*#/.test(line)) continue;
    if (UNKNOWN_TRANSPORT.test(line) || /\b(?:curl|wget)\b.*(?:--upload-file|--post-file|--data-binary|-T)\b/.test(line)) {
      throw new Error(`${block.file}:${block.line}: unknown transfer form: ${line.trim()}`);
    }
    for (const path of outputPaths(line)) add(path);
    for (const commandText of shellCommands(line)) {
      // Strip stdin/stdout redirections before taking a destination operand.
      const words = tokens(commandText.replace(/\s+[0-9]*[<>].*$/, "").trim());
      if (words[0] === "sudo") words.splice(0, words.findIndex((word) => ["install", "cp", "mv", "tee", "mkdir", "ln", "tar"].includes(word)));
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
      } else if (command === "tee") {
        for (const operand of words.slice(1).filter((word) => !word.startsWith("-"))) add(operand);
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
    // SSH joins its command argv. Remove the enclosing Mac quote, preserving
    // the quotes that the remote shell receives inside that argument.
    const enclosingQuote = /^(['"])([\s\S]*)\1$/.exec(command);
    if (enclosingQuote) command = enclosingQuote[2]!;
    // Outer assignments resolve argv such as STAGING_ROOT. Do not treat the Mac's
    // local writes as remote; only this SSH command and its stdin are inspected.
    const outer = expansions(block);
    const argv = /\bbash -s -- (.*)/.exec(command)?.[1];
    if (/\bbash\s+-s\b/.test(command) && remote.stdinProducer) {
      throw new Error(`${block.file}:${block.line}: unknown transfer form: generated bash stdin from ${remote.stdinProducer.path}`);
    }
    let body = /\bbash\s+-s\b/.test(command) ? remote.script ?? "" : command;
    if (argv) {
      const args = tokens(argv).map((arg) => outer(arg)[0]!);
      body = body.replace(/\$\{([1-9][0-9]*)\}|\$([1-9])(?![0-9])/g,
        (original, braced: string | undefined, plain: string | undefined) => args[Number(braced ?? plain) - 1] ?? original);
    }
    const assignments = block.source.split("\n").filter((line) => !line.includes("$(") &&
      (/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(line) || /^\s*for [A-Z]/.test(line))).join("\n");
    for (const product of shellWrites({ ...block, source: assignments + "\n" + command + "\n" + body })) {
      if (!products.has(product.path) || product.path.startsWith("/home/") || product.kind === "directory") products.set(product.path, product);
    }
  }
  return [...products.values()];
}

function pathReferences(block: HandoffBlock): string[] {
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
  const references = new Map(blocks.map((block) => [block, pathReferences(block).map(normalize)]));
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
    const expand = expansions(producer);
    const writes = [...producer.source.matchAll(/(?:(?<!>)>(?!>)\s*|install\s+[^\n]*?\/dev\/null\s+)["']?(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?:\/[a-zA-Z0-9_./${}*-]+)?|\/(?:home|run|tmp|srv)\/[a-zA-Z0-9_./${}*-]+)/g)]
      .flatMap((match) => expand(match[1]!)).map(normalize);
    // A handoff can be a copied file or a switched symlink as well as redirected stdout.
    for (const line of producer.source.replace(/\\\n\s*/g, " ").split("\n")) {
      const words = tokens(line);
      if (!["cp", "mv", "ln", "install"].includes(words[0] ?? "") || words.includes("-d")) continue;
      const destination = words.filter((word) => !word.startsWith(">") && !/^[0-9]+>/.test(word)).at(-1);
      if (destination) writes.push(...expand(destination).map(normalize).filter((path) => /^\/(?:home|run|tmp|srv)\//.test(path)));
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
