/**
 * Pure helpers for a story's MDX body (spec sections 4 and 7): the only
 * markup is paragraphs, bold, italic and `<Photo image alt caption credit />`.
 * Kept free of React and MDXEditor so the rules are unit-testable.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes, Parent } from 'mdast';

const ATTR = `[A-Za-z_][\\w-]*\\s*=\\s*(?:"[^"]*"|'[^']*')`;
export const PHOTO_SOURCE = `<Photo(?:\\s+${ATTR})*\\s*/>`;
const ATTR_PARTS = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export interface PhotoAttrs {
  image: string;
  alt: string;
  caption: string;
  credit: string;
}

/** The `<Photo … />` tags in `content`, in order, as written. */
export function photoTags(content: string): string[] {
  return content.match(new RegExp(PHOTO_SOURCE, 'g')) ?? [];
}

/**
 * Attribute values are stored with `&`, `"`, `<` and `>` as entities (`&` first,
 * so a literal `&amp;` survives). The server accepts exactly this form.
 */
export function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ENTITY: Record<string, string> = { amp: '&', quot: '"', lt: '<', gt: '>', '#x22': '"', '#34': '"' };

/** The inverse of escapeAttr, in one pass so `&amp;amp;` becomes `&amp;`, not `&`. */
export function unescapeAttr(value: string): string {
  return value.replace(/&(amp|quot|lt|gt|#x22|#34);/gi, (_m, name: string) => ENTITY[name.toLowerCase()] ?? _m);
}

export function parsePhoto(tag: string): PhotoAttrs {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_PARTS)) attrs[m[1] ?? ''] = unescapeAttr(m[2] ?? m[3] ?? '');
  return {
    image: attrs['image'] ?? '',
    alt: attrs['alt'] ?? '',
    caption: attrs['caption'] ?? '',
    credit: attrs['credit'] ?? '',
  };
}

/** One Photo tag, attributes in the fixed order the spec writes them. */
export function photoTag(p: PhotoAttrs): string {
  return `<Photo image="${escapeAttr(p.image)}" alt="${escapeAttr(p.alt)}" caption="${escapeAttr(p.caption)}" credit="${escapeAttr(p.credit)}" />`;
}

/** Every Photo tag rewritten in the one canonical, escaped form (what the server accepts). */
export function canonicalPhotos(content: string): string {
  return content.replace(new RegExp(PHOTO_SOURCE, 'g'), (tag) => photoTag(parsePhoto(tag)));
}

/**
 * Writes a `<` or `{` in prose as an entity (`&lt;`, `&#123;`), whether the editor
 * printed it escaped (`\\<`) or bare. The server refuses both raw forms, because
 * a backslash can itself be escaped and MDX would then see a live tag or expression.
 * Photo tags are left as they are.
 */
export function entitiseProse(content: string): string {
  const photo = new RegExp(PHOTO_SOURCE, 'g');
  let out = '';
  let at = 0;
  const prose = (text: string) =>
    text.replace(/(\\*)([<{])/g, (_m, slashes: string, ch: string) => {
      // An odd run: the last backslash was the escape, and goes. An even run stays.
      const kept = slashes.length % 2 === 1 ? slashes.slice(1) : slashes;
      return kept + (ch === '<' ? '&lt;' : '&#123;');
    });
  for (const m of content.matchAll(photo)) {
    out += prose(content.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  return out + prose(content.slice(at));
}

/**
 * The text handed to MDXEditor. It decodes attribute entities once on import and
 * prints attribute values back as they are, so the canonical entities are
 * protected by encoding `&` a second time: the editor then holds the escaped
 * form as its value and writes the same bytes back out.
 */
export function toEditorMarkdown(content: string): string {
  return content.replace(new RegExp(PHOTO_SOURCE, 'g'), (tag) => photoTag(parsePhoto(tag)).replace(/&/g, '&amp;'));
}

/**
 * Swaps the Photo block at `index` with its neighbour (`-1` up, `+1` down).
 * Out of range, or at an end, returns the content unchanged: the first photo
 * has no move-up and the last no move-down.
 */
export function movePhoto(content: string, index: number, direction: -1 | 1): string {
  const re = new RegExp(PHOTO_SOURCE, 'g');
  const found = [...content.matchAll(re)];
  const other = index + direction;
  if (index < 0 || index >= found.length || other < 0 || other >= found.length) return content;
  const swap = new Map<number, string>([
    [index, found[other]?.[0] ?? ''],
    [other, found[index]?.[0] ?? ''],
  ]);
  let n = -1;
  return content.replace(re, (tag) => {
    n += 1;
    return swap.get(n) ?? tag;
  });
}

/**
 * Flattens everything the editor does not offer — headings, lists, quotes,
 * links, code, rules — to plain paragraphs, keeping bold, italic and Photo
 * lines. It reads the markdown as a document (mdast), so only real heading,
 * list, quote, link and code nodes are touched; prose that merely looks like
 * markup in the middle of a line is left alone. An ordered-list marker that
 * starts a paragraph (`1984. The year…`) is kept, with its dot escaped so it
 * stays prose. Applied to what is pasted or typed in source view and before
 * every save.
 */
export function flattenMarkdown(markdown: string): string {
  const tree = fromMarkdown(markdown);
  let out = '';
  let at = 0;
  for (const node of tree.children) {
    const start = node.position?.start.offset ?? at;
    out += markdown.slice(at, start) + block(node, markdown);
    at = node.position?.end.offset ?? start;
  }
  return out + markdown.slice(at);
}

const slice = (node: Nodes, src: string) =>
  src.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);

/** The text of a block, markup the editor lacks removed; an unchanged block is returned as written. */
function block(node: Nodes, src: string): string {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return inline(node, src);
    case 'blockquote':
      return node.children.map((c) => block(c, src)).filter(Boolean).join('\n\n');
    case 'list': {
      const start = node.start ?? 1;
      const ordered = node.ordered === true;
      return node.children
        .map((item, i) => {
          const text = item.children.map((c) => block(c, src)).filter(Boolean).join('\n\n');
          if (!ordered) return text;
          const delimiter = src.slice(item.position?.start.offset ?? 0).match(/^\s*\d+([.)])/)?.[1] ?? '.';
          return `${start + i}\\${delimiter} ${text}`;
        })
        .join('\n\n');
    }
    case 'code':
      return node.value;
    case 'thematicBreak':
    case 'definition':
      return '';
    default:
      return slice(node, src);
  }
}

/** A paragraph or heading's text, with links, images and inline code reduced to their text. */
function inline(node: Parent, src: string): string {
  const first = node.children[0]?.position?.start.offset;
  const last = node.children[node.children.length - 1]?.position?.end.offset;
  if (first === undefined || last === undefined) return '';
  // For a heading this leaves out the `#` markers, which are outside its children.
  return span(node.children as Nodes[], first, last, src);
}

/** The source between `from` and `to`, where `children` sit, with their markup replaced. */
function span(children: Nodes[], from: number, to: number, src: string): string {
  let text = '';
  let at = from;
  for (const child of children) {
    const s = child.position?.start.offset;
    const e = child.position?.end.offset;
    if (s === undefined || e === undefined) continue;
    let replacement: string | undefined;
    if (child.type === 'link' || child.type === 'linkReference') replacement = inline(child, src);
    else if (child.type === 'image' || child.type === 'imageReference') replacement = child.alt ?? '';
    else if (child.type === 'inlineCode') replacement = child.value;
    else if ('children' in child && child.children.length > 0) {
      replacement = child.type === 'strong' || child.type === 'emphasis' ? nested(child, s, e, src) : undefined;
    }
    if (replacement === undefined) continue;
    text += src.slice(at, s) + replacement;
    at = e;
  }
  return text + src.slice(at, to);
}

/** A strong or emphasis node: its own markers kept, its contents flattened. */
function nested(node: Parent, from: number, to: number, src: string): string {
  const first = node.children[0]?.position?.start.offset ?? from;
  const last = node.children[node.children.length - 1]?.position?.end.offset ?? to;
  return src.slice(from, first) + span(node.children as Nodes[], first, last, src) + src.slice(last, to);
}

export interface DraftForRule {
  title: string;
  description: string;
  content: string;
}

/**
 * The publish rule (spec section 5) as far as the browser can know it: title,
 * description, at least one Photo, alt on every Photo. Whether each image is
 * processed is the server's to say; pressing Publish shows its 422 reasons.
 */
export function publishBlockers(draft: DraftForRule): string[] {
  const reasons: string[] = [];
  if (!draft.title.trim()) reasons.push('add a title');
  if (!draft.description.trim()) reasons.push('add a description');
  const photos = photoTags(draft.content).map(parsePhoto);
  if (photos.length === 0) reasons.push('add a photo');
  photos.forEach((p, i) => {
    if (!p.alt.trim()) reasons.push(`add alt text to photo ${i + 1}`);
  });
  return reasons;
}
