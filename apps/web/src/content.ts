/**
 * Pure helpers for a story's MDX body (spec sections 4 and 7): the only
 * markup is paragraphs, bold, italic and `<Photo image alt caption credit />`.
 * Kept free of React and MDXEditor so the rules are unit-testable.
 */

const ATTR = `[A-Za-z_][\\w-]*\\s*=\\s*(?:"[^"]*"|'[^']*')`;
const PHOTO_SOURCE = `<Photo(?:\\s+${ATTR})*\\s*/>`;
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

export function parsePhoto(tag: string): PhotoAttrs {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_PARTS)) attrs[m[1] ?? ''] = m[2] ?? m[3] ?? '';
  return {
    image: attrs['image'] ?? '',
    alt: attrs['alt'] ?? '',
    caption: attrs['caption'] ?? '',
    credit: attrs['credit'] ?? '',
  };
}

/** One Photo tag, attributes in the fixed order the spec writes them. */
export function photoTag(p: PhotoAttrs): string {
  const esc = (v: string) => v.replace(/"/g, '&quot;');
  return `<Photo image="${esc(p.image)}" alt="${esc(p.alt)}" caption="${esc(p.caption)}" credit="${esc(p.credit)}" />`;
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
 * lines. Applied to what is pasted or typed in source view and again before
 * every save, so such markup never reaches the stored draft.
 */
export function flattenMarkdown(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const raw of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    if (raw.trimStart().startsWith('<Photo')) {
      out.push(raw);
      continue;
    }
    let line = raw;
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s{0,3}(=+|-+)\s*$/.test(line)) continue;
    line = line.replace(/^\s{0,3}#{1,6}(\s+|$)/, '');
    for (;;) {
      const next = line.replace(/^\s*(>\s?|[-*+]\s+|\d+[.)]\s+)/, '');
      if (next === line) break;
      line = next;
    }
    line = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
      .replace(/`([^`]*)`/g, '$1');
    out.push(line);
  }
  return out.join('\n');
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
