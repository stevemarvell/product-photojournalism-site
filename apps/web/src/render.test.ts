import { describe, expect, it } from 'vitest';
import { parseBody, parseInline, proseText } from './render';

const texts = (content: string) =>
  parseBody(content).map((b) => (b.kind === 'paragraph' ? b.inlines.map((i) => i.text).join('') : `[photo ${b.photo.image}]`));

describe('the public renderer', () => {
  it('reads paragraphs, bold, italic and Photo tags, in order', () => {
    const blocks = parseBody(
      'First **bold** and *italic* words.\n\n<Photo image="i-1" alt="A &amp; B" caption="Cap &quot;x&quot;" credit="Me" />\n\nSecond\nline.',
    );
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        inlines: [
          { text: 'First ', bold: false, italic: false },
          { text: 'bold', bold: true, italic: false },
          { text: ' and ', bold: false, italic: false },
          { text: 'italic', bold: false, italic: true },
          { text: ' words.', bold: false, italic: false },
        ],
      },
      { kind: 'photo', photo: { image: 'i-1', alt: 'A & B', caption: 'Cap "x"', credit: 'Me' } },
      { kind: 'paragraph', inlines: [{ text: 'Second line.', bold: false, italic: false }] },
    ]);
  });

  it('reads italic inside bold, and a photo set in the middle of a line', () => {
    expect(parseInline('**very *bold* text**')).toEqual([
      { text: 'very ', bold: true, italic: false },
      { text: 'bold', bold: true, italic: true },
      { text: ' text', bold: true, italic: false },
    ]);
    expect(texts('before <Photo image="x" alt="a" /> after')).toEqual(['before', '[photo x]', 'after']);
  });

  // The control that holds whatever is stored: none of these is MDX here, all of them are text.
  it.each([
    ['an import', 'import a from "x"'],
    ['an export', 'export const a = 1'],
    ['an expression', 'Sum: {1 + 1}'],
    ['a script tag', '<script>alert(1)</script>'],
    ['an iframe', '<iframe src="https://evil.example"></iframe>'],
    ['an unknown tag', '<Gallery images={[1,2]} />'],
    ['a Photo tag with an expression', '<Photo image={x} alt="a" />'],
    ['a Photo tag left open', '<Photo image="x" alt="a"'],
    ['a link', '[click](javascript:alert(1))'],
    ['a heading', '# Not a heading'],
    ['an image', '![alt](https://evil.example/x.png)'],
  ])('renders %s as plain text and nothing else', (_name, source) => {
    const blocks = parseBody(source);
    expect(blocks).toHaveLength(1);
    const only = blocks[0];
    expect(only?.kind).toBe('paragraph');
    // Every character survives, as text (entities aside, none present here).
    expect(only?.kind === 'paragraph' ? only.inlines.map((i) => i.text).join('') : '').toBe(source);
    expect(only?.kind === 'paragraph' && only.inlines.every((i) => !i.bold && !i.italic)).toBe(true);
  });

  it('shows literal &lt;script&gt; as the characters <script>, text and not a tag', () => {
    expect(texts('&lt;script&gt;alert(1)&lt;/script&gt; and &#123;x&#125;')).toEqual(['<script>alert(1)</script> and {x}']);
    expect(proseText('&amp;lt;')).toBe('&lt;'); // one pass: never decoded twice
  });

  it('drops markdown backslash escapes and does not take an escaped star for emphasis', () => {
    expect(texts('5 \\* 3 \\* 2')).toEqual(['5 * 3 * 2']);
    expect(parseInline('a \\*b\\* c').every((i) => !i.italic)).toBe(true);
  });

  it('ignores empty paragraphs and a body of nothing', () => {
    expect(parseBody('')).toEqual([]);
    expect(parseBody('\n\n   \n\n')).toEqual([]);
  });
});
