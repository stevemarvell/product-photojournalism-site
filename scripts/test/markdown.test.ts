import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  firstHeading,
  renderInline,
  renderMarkdown,
  slug,
} from '../markdown.mjs';

describe('escapeHtml', () => {
  it('escapes the characters that would end a text node or an attribute', () => {
    expect(escapeHtml('a & b <c> "d"')).toBe('a &amp; b &lt;c&gt; &quot;d&quot;');
  });
});

describe('slug', () => {
  it('makes a heading into an anchor', () => {
    expect(slug('Steps of AI Adoption')).toBe('steps-of-ai-adoption');
    expect(slug('0: Gated')).toBe('0-gated');
    expect(slug('`aia0` — the **first** step')).toBe('aia0-the-first-step');
  });
});

describe('renderInline', () => {
  it('renders bold, italic, strikethrough and code', () => {
    expect(renderInline('**a** *b* ~~c~~ `d`')).toBe(
      '<strong>a</strong> <em>b</em> <del>c</del> <code>d</code>',
    );
  });

  it('leaves markup inside a code span alone', () => {
    expect(renderInline('`**not bold**`')).toBe('<code>**not bold**</code>');
  });

  it('does not mistake ordinary prose for a code placeholder', () => {
    // The placeholder is a control character precisely because text like this
    // is everywhere in these docs.
    expect(renderInline('`x` from step 0 to 1 and `y`')).toBe(
      '<code>x</code> from step 0 to 1 and <code>y</code>',
    );
  });

  it('escapes text that is not markup', () => {
    expect(renderInline('5 < 6 & 7 > 2')).toBe('5 &lt; 6 &amp; 7 &gt; 2');
  });

  it('renders links, opening external ones in a new tab', () => {
    expect(renderInline('[docs](https://example.com/a)')).toBe(
      '<a href="https://example.com/a" target="_blank" rel="noreferrer noopener">docs</a>',
    );
    expect(renderInline('[here](#anchor)')).toBe('<a href="#anchor">here</a>');
    expect(renderInline('[mail](mailto:a@b.com)')).toBe('<a href="mailto:a@b.com">mail</a>');
  });

  it('renders an autolink in angle brackets', () => {
    expect(renderInline('see <https://example.com/x>')).toBe(
      'see <a href="https://example.com/x">https://example.com/x</a>',
    );
  });

  it('refuses a scheme that can execute, leaving it as text', () => {
    // The input is this repository's own docs, but a renderer that emits
    // javascript: hrefs is one copied paragraph away from mattering.
    expect(renderInline('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
    expect(renderInline('[x](data:text/html,<script>)')).toContain('[x](data:');
  });
});

describe('renderMarkdown', () => {
  it('renders headings with anchors', () => {
    expect(renderMarkdown('# Title\n\n## Sub one')).toBe(
      '<h1 id="title">Title</h1>\n<h2 id="sub-one">Sub one</h2>',
    );
  });

  it('renders thematic breaks', () => {
    expect(renderMarkdown('a\n\n---\n\nb')).toBe('<p>a</p>\n<hr>\n<p>b</p>');
  });

  it('joins the lines of a paragraph', () => {
    expect(renderMarkdown('one\ntwo\nthree')).toBe('<p>one two three</p>');
  });

  it('renders a tight bullet list without paragraphs inside it', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('renders task list checkboxes, ticked and not', () => {
    const html = renderMarkdown('- [ ] todo\n- [x] done');
    expect(html).toContain('<ul class="tasks">');
    expect(html).toContain('<input type="checkbox" disabled> todo');
    expect(html).toContain('<input type="checkbox" disabled checked> done');
  });

  it('keeps a multi-paragraph bullet together', () => {
    const html = renderMarkdown(['- [ ] **One.** First line', '      wrapped.', '', '      Second paragraph.'].join('\n'));
    expect(html).toContain('<p><strong>One.</strong> First line wrapped.</p>');
    expect(html).toContain('<p>Second paragraph.</p>');
    // One bullet, not two.
    expect(html.match(/<li/g)).toHaveLength(1);
  });

  it('nests a list inside a bullet', () => {
    const html = renderMarkdown(['- outer', '      - inner one', '      - inner two'].join('\n'));
    expect(html).toBe('<ul><li><p>outer</p>\n<ul><li>inner one</li><li>inner two</li></ul></li></ul>');
  });

  it('renders a fenced code block indented inside a bullet', () => {
    const html = renderMarkdown(['- run it:', '', '      ```bash', '      echo hi', '      ```'].join('\n'));
    expect(html).toContain('<pre><code class="language-bash">echo hi\n</code></pre>');
  });

  it('leaves the contents of a code block unrendered and escaped', () => {
    const html = renderMarkdown('```\n<b>**x**</b>\n```');
    expect(html).toBe('<pre><code>&lt;b&gt;**x**&lt;/b&gt;\n</code></pre>');
  });

  it('renders a pipe table with its alignments', () => {
    const html = renderMarkdown(['| A | B |', '| --- | ---: |', '| `x` | 1 |'].join('\n'));
    expect(html).toContain('<th>A</th><th style="text-align:right">B</th>');
    expect(html).toContain('<td><code>x</code></td><td style="text-align:right">1</td>');
  });

  it('renders a blockquote', () => {
    expect(renderMarkdown('> **Note:** a thing')).toBe(
      '<blockquote><p><strong>Note:</strong> a thing</p></blockquote>',
    );
  });

  it('survives an empty document', () => {
    expect(renderMarkdown('')).toBe('');
  });
});

describe('firstHeading', () => {
  it('finds the document title', () => {
    expect(firstHeading('\n\n# Backlog\n\n## Later')).toBe('Backlog');
  });

  it('returns null when there is no level-one heading', () => {
    expect(firstHeading('## Only a subheading')).toBeNull();
  });
});
