// A small Markdown renderer, covering exactly the subset `docs/*.md` uses.
//
// This exists instead of a dependency because the input is two files in this
// repository rather than arbitrary user content: the failure mode of an
// unsupported construct is a doc page that reads oddly — caught by the tests
// beside it — not a security boundary. A renderer small enough to read whole
// is worth more here than one that handles every CommonMark corner.
//
// Supported: ATX headings, thematic breaks, fenced code, pipe tables,
// blockquotes, nested bullet lists (including task-list checkboxes and
// multi-paragraph items), paragraphs, and the inline set — code spans,
// autolinks, links, strikethrough, bold, italic.

const LIST_ITEM = /^(\s*)([-*+])(\s+)(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*$/;
const THEMATIC_BREAK = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w-]*)\s*$/;
const TABLE_DELIMITER = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;

/** HTML-escapes text destined for a text node or a quoted attribute. */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A heading's anchor: lowercase, punctuation dropped, spaces hyphenated.
 * Deliberately plain, because these ids end up in URLs people paste.
 */
export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[`*~[\]()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// href values are built from already-escaped text, so &amp; has to come back
// before the URL is used — otherwise a query string gains a literal "amp;".
const unescapeUrl = (url) => url.replace(/&amp;/g, '&').replace(/&quot;/g, '"');

// Only schemes that cannot execute script. An unrecognised one — javascript:
// most of all — renders as plain text rather than as a link.
const SAFE_URL = /^(?:https?:\/\/|mailto:|#|\/|\.{0,2}\/)/i;

/** Renders the inline constructs within one already-joined run of text. */
export function renderInline(text) {
  // Code spans are extracted before escaping so their contents are never
  // scanned for emphasis or links — ** inside backticks stays literal.
  // The placeholder is NUL because prose can contain anything printable —
  // these docs are full of strings like "step 0 to 1".
  const codes = [];
  let out = String(text).replace(/(`+)([\s\S]*?)\1/g, (_whole, _ticks, code) => {
    codes.push(code.replace(/^ (.*) $/, '$1'));
    return `\u0000${codes.length - 1}\u0000`;
  });

  out = escapeHtml(out);

  // <https://example.com> — an autolink. Runs before the [text](url) form so a
  // bare URL in angle brackets is not mistaken for stray markup.
  out = out.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, (_whole, url) => {
    const href = unescapeUrl(url);
    return `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`;
  });

  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    const href = unescapeUrl(url);
    if (!SAFE_URL.test(href)) return whole;
    const external = /^https?:\/\//i.test(href);
    const attrs = external ? ' target="_blank" rel="noreferrer noopener"' : '';
    return `<a href="${escapeHtml(href)}"${attrs}>${label}</a>`;
  });

  out = out.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');
  out = out.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][\s\S]*?)\*(?!\*)/g, '$1<em>$2</em>');

  return out.replace(/\u0000(\d+)\u0000/g, (_whole, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}

const leadingSpaces = (line) => line.length - line.trimStart().length;

const startsBlock = (line) =>
  line.trim() === '' ||
  HEADING.test(line) ||
  THEMATIC_BREAK.test(line) ||
  FENCE.test(line) ||
  LIST_ITEM.test(line) ||
  /^\s*>/.test(line) ||
  /^\s*\|/.test(line);

const cells = (row) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

/**
 * Collects one bullet list starting at `start`, returning its items as arrays
 * of dedented lines plus the index of the first line after the list.
 *
 * An item owns every following line indented past its own marker, blank lines
 * included, which is what lets a single bullet hold several paragraphs, a code
 * fence, or a nested list.
 */
function collectList(lines, start, indent) {
  const items = [];
  let i = start;

  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]);
    if (!match || match[1].length !== indent) break;

    const body = [];
    i += 1;
    while (i < lines.length) {
      if (lines[i].trim() === '') {
        // A blank line only continues the item if something indented follows;
        // otherwise it ends the list.
        let ahead = i;
        while (ahead < lines.length && lines[ahead].trim() === '') ahead += 1;
        if (ahead >= lines.length || leadingSpaces(lines[ahead]) <= indent) break;
        for (; i < ahead; i += 1) body.push('');
        continue;
      }
      if (leadingSpaces(lines[i]) <= indent) break;
      body.push(lines[i]);
      i += 1;
    }

    // Continuation lines are indented to sit under the item's text, which is
    // not necessarily marker plus one space. Dedent by what they actually use.
    const used = body.filter((line) => line.trim() !== '').map(leadingSpaces);
    const dedent = used.length > 0 ? Math.min(...used) : 0;
    items.push([match[4], ...body.map((line) => line.slice(dedent))]);
  }

  return { items, next: i };
}

function renderItem(body) {
  const checkbox = /^\[([ xX])\]\s+(.*)$/.exec(body[0] ?? '');
  const lines = checkbox ? [checkbox[2], ...body.slice(1)] : body;
  const html = renderBlocks(lines);

  // A one-paragraph bullet reads better without the <p>, and matches how the
  // source is written; anything richer keeps its block structure.
  const tight = /^<p>([\s\S]*)<\/p>$/.exec(html);
  const inner = tight && !tight[1].includes('<p>') ? tight[1] : html;

  if (!checkbox) return `<li>${inner}</li>`;
  const checked = checkbox[1] === ' ' ? '' : ' checked';
  return `<li class="task"><input type="checkbox" disabled${checked}> ${inner}</li>`;
}

/** Renders a block sequence. Recursive: list items and quotes re-enter here. */
export function renderBlocks(lines) {
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, indent, ticks, lang] = fence;
      const closing = new RegExp(`^\\s*${ticks[0]}{${ticks.length},}\\s*$`);
      const body = [];
      i += 1;
      while (i < lines.length && !closing.test(lines[i])) {
        body.push(lines[i].slice(indent.length));
        i += 1;
      }
      i += 1;
      const attr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${attr}>${escapeHtml(body.join('\n'))}\n</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const id = escapeHtml(slug(heading[2]));
      out.push(`<h${level} id="${id}">${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_DELIMITER.test(lines[i + 1])) {
      const header = cells(line);
      const aligns = cells(lines[i + 1]).map((spec) => {
        if (/^:-+:$/.test(spec)) return ' style="text-align:center"';
        if (/^-+:$/.test(spec)) return ' style="text-align:right"';
        return '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(cells(lines[i]));
        i += 1;
      }
      const head = header.map((c, n) => `<th${aligns[n] ?? ''}>${renderInline(c)}</th>`).join('');
      const body = rows
        .map((row) => {
          const tds = row.map((c, n) => `<td${aligns[n] ?? ''}>${renderInline(c)}</td>`).join('');
          return `<tr>${tds}</tr>`;
        })
        .join('');
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(body)}</blockquote>`);
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const { items, next } = collectList(lines, i, item[1].length);
      i = next;
      const tasks = items.every((body) => /^\[[ xX]\]\s/.test(body[0] ?? ''));
      out.push(`<ul${tasks ? ' class="tasks"' : ''}>${items.map(renderItem).join('')}</ul>`);
      continue;
    }

    const paragraph = [line.trim()];
    i += 1;
    while (i < lines.length && !startsBlock(lines[i])) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }

  return out.join('\n');
}

/** Renders a whole Markdown document to an HTML fragment. */
export function renderMarkdown(markdown) {
  return renderBlocks(String(markdown).replace(/\r\n?/g, '\n').split('\n'));
}

/** The text of the document's first level-one heading, if it has one. */
export function firstHeading(markdown) {
  for (const line of String(markdown).replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^#\s+(.*?)\s*#*$/.exec(line);
    if (heading) return heading[1].trim();
  }
  return null;
}
