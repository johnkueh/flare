// Reads and edits a wrangler.jsonc without losing its comments or layout:
// flare-push adds what's missing at the end of the top-level object (or of
// "vars") and leaves everything else as it was.

/** The text with every comment blanked to spaces, so positions still line up. */
export function maskComments(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      if (i < text.length) out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else out += c;
  }
  return out;
}

/** JSONC → value: comments and trailing commas allowed. */
export function parseJsonc(text) {
  return JSON.parse(maskComments(text).replace(/,(\s*[}\]])/g, "$1"));
}

/** Where each top-level key's value starts, in the masked text. */
function topLevelKeys(masked) {
  const keys = new Map();
  let depth = 0;
  let lastString = null;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '"') {
      let j = i + 1;
      while (j < masked.length && masked[j] !== '"') j += masked[j] === "\\" ? 2 : 1;
      lastString = masked.slice(i + 1, j);
      i = j;
    } else if (c === ":" && depth === 1 && lastString !== null) {
      let j = i + 1;
      while (/\s/.test(masked[j])) j++;
      keys.set(lastString, j);
      lastString = null;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (!/\s/.test(c)) lastString = null;
  }
  return keys;
}

/** The index of the `}` closing the object that opens at `open`. */
function closingBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '"') {
      let j = i + 1;
      while (j < masked.length && masked[j] !== '"') j += masked[j] === "\\" ? 2 : 1;
      i = j;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced braces");
}

/** Adds `"key": value` as the last member of the object closing at `close`,
 *  at the end of the last member's line (after any comment there). */
function appendMember(text, masked, close, key, value, indent) {
  let prev = close - 1;
  while (prev >= 0 && /\s/.test(masked[prev])) prev--;
  const needsComma = masked[prev] !== "{" && masked[prev] !== ",";
  let eol = text.indexOf("\n", prev);
  if (eol === -1 || eol > close) eol = close;
  const member = `${indent}${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`)}`;
  return `${text.slice(0, prev + 1)}${needsComma ? "," : ""}${text.slice(prev + 1, eol)}\n${member}${eol === close ? " " : ""}${text.slice(eol)}`;
}

/** Adds a top-level key; throws if it's already there. */
export function addTopLevel(text, key, value) {
  const masked = maskComments(text);
  if (topLevelKeys(masked).has(key)) throw new Error(`"${key}" is already there`);
  const open = masked.indexOf("{");
  return appendMember(text, masked, closingBrace(masked, open), key, value, "  ");
}

/** Sets `"vars"."name"` (adding "vars" if needed); throws if it's already set. */
export function addVar(text, name, value) {
  const masked = maskComments(text);
  const at = topLevelKeys(masked).get("vars");
  if (at === undefined) return addTopLevel(text, "vars", { [name]: value });
  if (masked[at] !== "{") throw new Error(`"vars" isn't an object`);
  if (name in (parseJsonc(text).vars ?? {})) throw new Error(`vars.${name} is already set`);
  return appendMember(text, masked, closingBrace(masked, at), name, value, "    ");
}

/** A .dev.vars (dotenv) file: KEY=value, with "quoted" values that may span
 *  lines and use \n escapes. */
export function parseDevVars(text) {
  const vars = {};
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(lines[n]);
    if (!m) continue;
    const [, key, rest] = m;
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") {
      vars[key] = rest.replace(/\s+#.*$/, "").trim();
      continue;
    }
    let value = rest.slice(1);
    while (!closes(value, quote) && n + 1 < lines.length) value += `\n${lines[++n]}`;
    value = value.slice(0, value.lastIndexOf(quote));
    vars[key] = quote === '"' ? value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : value;
  }
  return vars;
}

function closes(value, quote) {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && quote === '"') i++;
    else if (value[i] === quote) return true;
  }
  return false;
}
