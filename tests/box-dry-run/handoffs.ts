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
export interface TransferProduct { path: string; source: string; mode: string; owner: string }
const tokens = (line: string): string[] => (line.match(/(?:"[^"\n]*"|'[^'\n]*'|[^\s;"']+)+/g) ?? [])
  .map((word) => word.replace(/["']/g, ""));

function expansions(block: HandoffBlock): (value: string) => string[] {
  const vars = new Map<string, string[]>([
    ["SHA", ["{sha}"]], ["RELEASE_SHA", ["{sha}"]], ["WINDOW_ID", ["{window}"]],
  ]);
  for (const match of block.source.matchAll(/^\s*([A-Z][A-Z0-9_]*)=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#]+))\s*$/gm)) {
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
  for (const match of block.source.matchAll(/\bfor ([A-Z][A-Z0-9_]*) in ([^;\n]+); do/g)) {
    const values = tokens(match[2]!);
    const expanded = values.flatMap((value) => {
      const name = /^\$([A-Z][A-Z0-9_]*)$/.exec(value)?.[1];
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
    const match = [...value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)/g)].find((item) => vars.has(item[1] ?? item[2]!));
    if (!match || !vars.has(match[1] ?? match[2]!)) return [value];
    return vars.get(match[1] ?? match[2]!)!.flatMap((replacement) => expand(
      value.slice(0, match.index) + replacement + value.slice(match.index + match[0].length), depth + 1));
  };
  return (value) => expand(value);
}

export function transferProducts(block: HandoffBlock): TransferProduct[] {
  if (block.host.startsWith("box ")) return [];
  const expand = expansions(block);
  const products = new Map<string, TransferProduct>();
  const text = block.source.replace(/\\\n\s*/g, " ");
  for (const line of text.split("\n")) {
    const words = tokens(line);
    if (words[0] === "scp" && words.length >= 3) {
      const destination = words[2]!;
      const remote = /^(ops|commonswarm)@[^:]+:(.*)$/.exec(destination);
      if (!remote) throw new Error(`${block.file}:${block.line}: unrecognized scp handoff: ${line}`);
      const sources = expand(words[1]!);
      const paths = expand(remote[2]!);
      for (let i = 0; i < paths.length; i++) products.set(paths[i]!, {
        path: paths[i]!, source: sources[i] ?? sources[0]!, mode: "0600", owner: `${remote[1]}:${remote[1]}`,
      });
    }
    // Resolve the final box-side install back to the Mac source transferred by scp.
    // Intermediate scratch copies are removed by this producer; later blocks consume the final products.
    if (words[0] === "install" && words.includes("-o") && !words.includes("-d")) {
      const sources = expand(words.at(-2)!);
      const paths = expand(words.at(-1)!);
      const mode = words[words.indexOf("-m") + 1]!;
      const owner = `${words[words.indexOf("-o") + 1]}:${words[words.indexOf("-g") + 1]}`;
      for (let i = 0; i < paths.length; i++) {
        const source = sources[i] ?? sources[0]!;
        const transferred = products.get(source);
        if (transferred) products.set(paths[i]!, { path: paths[i]!, source: transferred.source, mode, owner });
      }
    }
  }
  return [...products.values()].filter((product) => ![...products.values()].some((other) => other.path !== product.path && other.source === product.source && other.owner === "root:root" && product.path.startsWith("/tmp/")));
}

function pathReferences(block: HandoffBlock): string[] {
  const expand = expansions(block);
  const expressions = block.source.match(/(?:\/(?:home|run|tmp|srv)\/|\$\{?[A-Z][A-Z0-9_]*\}?\/)[a-zA-Z0-9_./${}*-]+|\$(?:WINDOW_ENV|SESSION)\b/g) ?? [];
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
    const writes = [...producer.source.matchAll(/(?:(?<!>)>(?!>)\s*|install\s+[^\n]*?\/dev\/null\s+)["']?(\$\{?[A-Z][A-Z0-9_]*\}?(?:\/[a-zA-Z0-9_./${}*-]+)?|\/(?:home|run|tmp|srv)\/[a-zA-Z0-9_./${}*-]+)/g)]
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
