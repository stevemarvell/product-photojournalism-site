// Name-only parsers for a script's runtime exports and its hand-written
// `.d.mts` declarations (#335). Source is parsed, never imported: several
// scripts run code or read project.json at import time.

// One pass, leftmost match wins: a string literal is consumed before anything
// inside it can look like a comment, and its body is blanked so text in a
// template cannot look like an export.
// A regex literal (after an operator or opening bracket) is consumed whole, so a
// quote or backtick inside one does not open a string.
const REGEX = String.raw`(?<=[(,=:[!&|?{};]\s*|return\s+)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*`;
const TOKEN = new RegExp(
  String.raw`\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$|` + REGEX + String.raw`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|` + '`(?:\\\\[\\s\\S]|[^`\\\\])*`',
  'gm',
);

function stripComments(src: string): string {
  return src.replace(TOKEN, (match, lead: string | undefined) => {
    if (match.startsWith('/*')) return '';
    if (match.startsWith('//') || lead !== undefined) return lead ?? '';
    return /^['"`]/.test(match) ? '""' : match;
  });
}

/** Names inside `export { a, b as c }`; a `type` entry is not a runtime name. */
function braceNames(list: string): string[] {
  const names: string[] = [];
  for (const raw of list.split(',')) {
    const entry = raw.trim();
    if (!entry || /^type\s/.test(entry)) continue;
    const parts = entry.split(/\s+as\s+/);
    names.push((parts[1] ?? parts[0] ?? '').trim());
  }
  return names;
}

function collect(src: string, declRe: RegExp): string[] {
  const text = stripComments(src);
  const names = new Set<string>();
  // Forms this name-only parser cannot read: fail loudly, never silently miss names.
  const unreadable = text.match(/^\s*export\s+(?:declare\s+)?(?:\*|(?:const|let|var)\s*[{[])/m);
  if (unreadable) throw new Error(`unsupported export form: ${unreadable[0].trim()}`);
  for (const m of text.matchAll(declRe)) if (m[1]) names.add(m[1]);
  for (const m of text.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const n of braceNames(m[1] ?? '')) names.add(n);
  }
  if (/^\s*export\s+default\b/m.test(text)) names.add('default');
  return [...names].sort();
}

/** Runtime export names of a `.mjs` source. */
export function runtimeExports(src: string): string[] {
  return collect(
    src,
    /^\s*export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s*([A-Za-z_$][\w$]*)/gm,
  );
}

/** Value export names a `.d.mts` declares; types and interfaces are skipped. */
export function declaredExports(src: string): string[] {
  return collect(
    src,
    /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s*([A-Za-z_$][\w$]*)/gm,
  );
}
