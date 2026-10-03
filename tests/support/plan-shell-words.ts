// Decode literal shell words for compile-only plan inspection. This never
// evaluates expansions or executes a command. Adjacent quote segments belong
// to one word, including the '\'' spelling used by nested SSH commands.
export function planShellWords(source: string): string[] {
  const words: string[] = [];
  let word = "", quote = "", started = false;
  const flush = () => {
    if (started) words.push(word);
    word = ""; started = false;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\" && quote !== "'") {
      const next = source[++i];
      if (next === "\n") continue;
      if (next === undefined) throw new Error("unterminated shell escape");
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += "\\";
      word += next; started = true; continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === "#" && !started) {
      const end = source.indexOf("\n", i);
      if (end < 0) break;
      i = end; continue;
    }
    if (/\s|[;|&()<>]/.test(char)) { flush(); continue; }
    word += char; started = true;
  }
  if (quote) throw new Error("unterminated shell quote");
  flush();
  return words;
}
