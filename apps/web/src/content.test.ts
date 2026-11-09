import { describe, expect, it } from 'vitest';
import { flattenMarkdown, movePhoto, parsePhoto, photoTag, photoTags, publishBlockers } from './content';

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
    ['1. first', 'first'],
    ['[link](http://x.test)', 'link'],
    ['see [a](http://x) and [b](http://y)', 'see a and b'],
    ['![pic](http://x/y.png)', 'pic'],
    ['`code`', 'code'],
    ['<http://x.test>', 'http://x.test'],
  ])('flattens %s', (input, expected) => {
    expect(flattenMarkdown(input)).toBe(expected);
  });

  it('drops rules and fence markers and flattens nested markers', () => {
    expect(flattenMarkdown('---\n```\ncode\n```\n> - nested')).toBe('code\nnested');
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
