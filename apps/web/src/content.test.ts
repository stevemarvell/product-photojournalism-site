import { describe, expect, it } from 'vitest';
import { canonicalPhotos, escapeAttr, flattenMarkdown, toEditorMarkdown, unescapeAttr, movePhoto, parsePhoto, photoTag, photoTags, publishBlockers } from './content';

const A = '<Photo image="a" alt="A" caption="" credit="" />';
const B = '<Photo image="b" alt="B" caption="cap" credit="me" />';
const C = '<Photo image="c" alt="C" caption="" credit="" />';

describe('flattenMarkdown', () => {
  it('keeps paragraphs, bold, italic and Photo lines unchanged', () => {
    const md = `Some **bold** and *italic* text.\n\n${B}\n\nMore.`;
    expect(flattenMarkdown(md)).toBe(md);
  });

  it.each([
    ['# Heading', 'Heading'],
    ['### Deep', 'Deep'],
    ['> quoted', 'quoted'],
    ['- item', 'item'],
    ['* item', 'item'],
    ['1. first', '1\\. first'],
    ['[link](http://x.test)', 'link'],
    ['see [a](http://x) and [b](http://y)', 'see a and b'],
    ['![pic](http://x/y.png)', 'pic'],
    ['`code`', 'code'],
    ['<http://x.test>', 'http://x.test'],
  ])('flattens %s', (input, expected) => {
    expect(flattenMarkdown(input)).toBe(expected);
  });

  it('drops rules and fence markers and flattens nested markers', () => {
    expect(flattenMarkdown('---\n```\ncode\n```\n> - nested')).toBe('\ncode\nnested');
  });
});

describe('flattenMarkdown keeps real prose', () => {
  it('keeps the number that starts a sentence, escaping its dot so it stays prose', () => {
    expect(flattenMarkdown('1984. The year everything changed.')).toBe('1984\\. The year everything changed.');
  });
  it('leaves a hyphen or dot inside a line, and a number after other words, alone', () => {
    const md = 'Well - fine. In 1984. Then 2. more, and a-b - c.';
    expect(flattenMarkdown(md)).toBe(md);
  });
  it('flattens a bullet that starts a line (a real list) and keeps bold inside a link', () => {
    expect(flattenMarkdown('the year\n- of the cat')).toBe('the year\nof the cat');
    expect(flattenMarkdown('see [a **bold** link](http://x.test) now')).toBe('see a **bold** link now');
  });
  it('flattens a heading containing emphasis', () => {
    expect(flattenMarkdown('## A *big* day')).toBe('A *big* day');
  });
});

describe('attribute escaping', () => {
  it.each(['He said "go"', 'a &amp; b', 'a & b', 'x <b> y', '&quot;', '&amp;amp;', ''])(
    'round-trips %j through escapeAttr and unescapeAttr, and through a Photo tag',
    (value) => {
      expect(unescapeAttr(escapeAttr(value))).toBe(value);
      expect(escapeAttr(value)).not.toMatch(/["<>]/);
      expect(parsePhoto(photoTag({ image: 'i', alt: value, caption: value, credit: value })).alt).toBe(value);
    },
  );
  it('encodes & first, so a literal &amp; stays distinguishable', () => {
    expect(escapeAttr('He said "go" & &amp;')).toBe('He said &quot;go&quot; &amp; &amp;amp;');
  });
  it('rewrites a Photo tag the editor printed raw into the canonical escaped form', () => {
    expect(canonicalPhotos('<Photo image="a" alt="x <b> & &#x22;q&#x22;" caption="" credit="" />')).toBe(
      '<Photo image="a" alt="x &lt;b&gt; &amp; &quot;q&quot;" caption="" credit="" />',
    );
  });
  it('doubles & for the editor, which decodes once and prints back what it holds', () => {
    expect(toEditorMarkdown(photoTag({ image: 'a', alt: 'a &amp; "b"', caption: '', credit: '' }))).toBe(
      '<Photo image="a" alt="a &amp;amp;amp; &amp;quot;b&amp;quot;" caption="" credit="" />',
    );
  });
});

describe('Photo tags', () => {
  it('round-trips through parse and write, attributes in spec order', () => {
    expect(photoTag(parsePhoto(B))).toBe(B);
    expect(photoTags(`x\n\n${A}\n\n${B}`)).toEqual([A, B]);
  });
});

describe('movePhoto', () => {
  const body = `intro\n\n${A}\n\nmid\n\n${B}\n\n${C}`;
  it('swaps a photo with its neighbour, leaving text in place', () => {
    expect(movePhoto(body, 1, -1)).toBe(`intro\n\n${B}\n\nmid\n\n${A}\n\n${C}`);
    expect(movePhoto(body, 1, 1)).toBe(`intro\n\n${A}\n\nmid\n\n${C}\n\n${B}`);
  });
  it('does nothing past the ends', () => {
    expect(movePhoto(body, 0, -1)).toBe(body);
    expect(movePhoto(body, 2, 1)).toBe(body);
  });
});

describe('publishBlockers', () => {
  it('lists every missing piece', () => {
    expect(publishBlockers({ title: ' ', description: '', content: '' })).toEqual([
      'add a title',
      'add a description',
      'add a photo',
    ]);
  });
  it('requires alt on every photo', () => {
    const r = publishBlockers({ title: 't', description: 'd', content: `${A}\n\n<Photo image="z" alt="" caption="" credit="" />` });
    expect(r).toEqual(['add alt text to photo 2']);
  });
  it('is empty for a passing draft', () => {
    expect(publishBlockers({ title: 't', description: 'd', content: A })).toEqual([]);
  });
});
