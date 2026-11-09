/**
 * The public renderer's parser (spec sections 6 and 13). A published body is MDX text, but it
 * is never run as MDX: this reads exactly four things from it, and everything else is plain
 * text.
 *
 *   - paragraphs (blocks separated by a blank line),
 *   - `**bold**` and `*italic*` inside a paragraph,
 *   - well-formed `<Photo image alt caption credit />` tags (attributes read, entities
 *     undone, by the helpers the editor shares: content.ts).
 *
 * The result is data (`Block[]`), which React then prints as text nodes. Nothing here, and
 * nothing in the component that draws it, builds HTML from the body or evaluates it:
 * `import a from "x"`, `export const a = 1`, `{1 + 1}`, `<script>` and `&lt;script&gt;`
 * each come out as the characters they are. The API refuses most of those on save
 * (`content_problems`); this rule is the control that holds whatever is stored.
 */

import { PHOTO_SOURCE, parsePhoto, type PhotoAttrs } from './content';

export type Inline = { text: string; bold: boolean; italic: boolean };

export type Block = { kind: 'paragraph'; inlines: Inline[] } | { kind: 'photo'; photo: PhotoAttrs };

const PROSE_ENTITY = /&(amp|quot|lt|gt|#x22|#34|#123|#125);/gi;
const PROSE_CHARS: Record<string, string> = {
  amp: '&',
  quot: '"',
  lt: '<',
  gt: '>',
  '#x22': '"',
  '#34': '"',
  '#123': '{',
  '#125': '}',
};

/**
 * The text of a run of prose: the entities the editor writes (`&lt;`, `&#123;` ...) undone in
 * one pass, and markdown backslash-escapes (`\*`) dropped. It yields characters, and a
 * character is only ever displayed: `&lt;script&gt;` is shown as `<script>`, never inserted.
 */
export function proseText(raw: string): string {
  return raw
    .replace(/\\([\\`*_{}[\]()#+\-.!<>&"])/g, '$1')
    .replace(PROSE_ENTITY, (m, name: string) => PROSE_CHARS[name.toLowerCase()] ?? m);
}

// `**bold**` or `*italic*`, the asterisks not backslash-escaped.
const EMPHASIS = /(?<!\\)\*\*(.+?)(?<!\\)\*\*|(?<!\\)\*([^*]+?)(?<!\\)\*/g;

/** One paragraph's inline runs: bold and italic recognised, the rest plain. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (raw: string, bold: boolean, italic: boolean) => {
    if (raw !== '') out.push({ text: proseText(raw), bold, italic });
  };
  let at = 0;
  for (const m of text.matchAll(EMPHASIS)) {
    push(text.slice(at, m.index), false, false);
    if (m[1] !== undefined) {
      // Italic inside bold is the one nesting the editor produces.
      let inner = 0;
      for (const n of m[1].matchAll(EMPHASIS)) {
        if (n[2] === undefined) continue;
        push(m[1].slice(inner, n.index), true, false);
        push(n[2], true, true);
        inner = n.index + n[0].length;
      }
      push(m[1].slice(inner), true, false);
    } else {
      push(m[2] ?? '', false, true);
    }
    at = m.index + m[0].length;
  }
  push(text.slice(at), false, false);
  return out;
}

function paragraphs(text: string): Block[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter((p) => p !== '')
    .map((p) => ({ kind: 'paragraph', inlines: parseInline(p) }));
}

/** The body as blocks, in order. Anything that is not a Photo tag is prose. */
export function parseBody(content: string): Block[] {
  const blocks: Block[] = [];
  let at = 0;
  for (const m of content.matchAll(new RegExp(PHOTO_SOURCE, 'g'))) {
    blocks.push(...paragraphs(content.slice(at, m.index)));
    blocks.push({ kind: 'photo', photo: parsePhoto(m[0]) });
    at = m.index + m[0].length;
  }
  blocks.push(...paragraphs(content.slice(at)));
  return blocks;
}
