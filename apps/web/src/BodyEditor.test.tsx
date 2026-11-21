import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BodyEditor } from './BodyEditor';

afterEach(() => cleanup());

const PHOTO = '<Photo image="img-1" alt="A harbour" caption="Dawn" credit="S. Marvell" />';
const BODY = `First **bold** and *italic*.\n\n${PHOTO}\n\nLast.`;

describe('the body editor toolbar', () => {
  it('offers bold, italic, a photo button and the source toggle, and nothing else', async () => {
    render(<BodyEditor initial="" onChange={() => {}} />);
    await screen.findByTestId('source-toggle');
    const labels = [...document.querySelectorAll('[role="toolbar"] button, [role="toolbar"] [role="button"]')].map(
      (b) => (b.getAttribute('title') ?? b.getAttribute('aria-label') ?? b.textContent ?? '').toLowerCase(),
    );
    expect(labels.some((l) => l.includes('bold'))).toBe(true);
    expect(labels.some((l) => l.includes('italic'))).toBe(true);
    // The photo button is drawn below the text, outside the toolbar, as the design has it.
    expect(labels.some((l) => l.includes('photo'))).toBe(false);
    const add = screen.getByTestId('photo-button');
    expect(add.textContent).toBe('+ Add photo');
    expect(add.closest('[role="toolbar"]')).toBeNull();
    for (const banned of ['underline', 'link', 'heading', 'list', 'quote', 'block type', 'table', 'code', 'image']) {
      expect(labels.filter((l) => l.includes(banned)), banned).toEqual([]);
    }
  });
});

describe('visual and source views', () => {
  it('shows the Photo block in the visual view with its fields', async () => {
    render(<BodyEditor initial={BODY} onChange={() => {}} />);
    expect((await screen.findByTestId('photo-alt') as HTMLInputElement).value).toBe('A harbour');
    expect((screen.getByTestId('photo-caption') as HTMLInputElement).value).toBe('Dawn');
    expect((screen.getByTestId('photo-credit') as HTMLInputElement).value).toBe('S. Marvell');
  });

  it('round-trips text and the Photo tag unchanged through source view and back', async () => {
    const onChange = vi.fn();
    render(<BodyEditor initial={BODY} onChange={onChange} />);
    await screen.findByTestId('photo-alt');
    fireEvent.click(screen.getByTestId('source-toggle'));
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull());
    const source = document.querySelector('.cm-content')?.textContent ?? '';
    expect(source).toContain(PHOTO);
    expect(source).toContain('First **bold** and *italic*.');
    fireEvent.click(screen.getByTestId('source-toggle'));
    expect((await screen.findByTestId('photo-alt') as HTMLInputElement).value).toBe('A harbour');
    // Editing a field writes the same tag back, attributes in spec order.
    fireEvent.change(screen.getByTestId('photo-caption'), { target: { value: 'Dusk' } });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls.at(-1)?.[0] as string;
    expect(last).toContain('<Photo image="img-1" alt="A harbour" caption="Dusk" credit="S. Marvell" />');
    expect(last).toContain('First **bold** and *italic*.');
  });

  it('flattens markup the editor does not offer when it is loaded', async () => {
    render(<BodyEditor initial={'# Big\n\n- one\n\n> quote\n\n[x](http://e.test)'} onChange={() => {}} />);
    await screen.findByTestId('source-toggle');
    const content = document.querySelector('.body-editor-content');
    expect(content?.querySelector('h1,h2,ul,ol,blockquote,a')).toBeNull();
    expect(content?.textContent).toContain('Big');
    expect(content?.textContent).toContain('x');
  });

  it('writes special characters in alt, caption and credit as entities, and reads them back unchanged', async () => {
    const onChange = vi.fn();
    const tag = '<Photo image="img-1" alt="He said &quot;go&quot; &amp;amp; left" caption="a &lt;b&gt;" credit="" />';
    render(<BodyEditor initial={tag} onChange={onChange} />);
    const alt = (await screen.findByTestId('photo-alt')) as HTMLInputElement;
    expect(alt.value).toBe('He said "go" &amp; left');
    expect((screen.getByTestId('photo-caption') as HTMLInputElement).value).toBe('a <b>');
    fireEvent.change(screen.getByTestId('photo-credit'), { target: { value: 'R & "D"' } });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)?.[0]).toBe(
      '<Photo image="img-1" alt="He said &quot;go&quot; &amp;amp; left" caption="a &lt;b&gt;" credit="R &amp; &quot;D&quot;" />',
    );
  });

  it('saves a < or { typed in prose as an entity, never as a backslash escape', async () => {
    const onChange = vi.fn();
    render(<BodyEditor initial={`5 &lt; 6 and &#123;x}\n\n${PHOTO}`} onChange={onChange} />);
    fireEvent.change(await screen.findByTestId('photo-credit'), { target: { value: 'z' } });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const saved = onChange.mock.calls.at(-1)?.[0] as string;
    expect(saved).toContain('5 &lt; 6 and &#123;x}');
    expect(saved).not.toMatch(/\\[<{]/);
  });
});
