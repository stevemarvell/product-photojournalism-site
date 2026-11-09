import { useContext, useState, type ReactNode } from 'react';

import { parsePhoto, photoTags, unescapeAttr } from './content';
import { resolveUrl, type ImageState } from './images-api';
import { ImageStatusContext } from './useImageStatuses';
import type { DraftText } from './stories-api';

/**
 * Why the draft cannot be previewed yet, or null when it can (spec section 7): every
 * image in it must be ready. Processing (or not yet asked about) wins over failed, since
 * waiting may still fix it.
 */
export function previewBlocker(imageIds: readonly string[], states: ReadonlyMap<string, ImageState>): string | null {
  const status = (id: string) => states.get(id)?.status ?? 'loading';
  const all = imageIds.map(status);
  if (all.some((s) => s === 'processing' || s === 'loading')) return 'Preview is unavailable: photos are still processing.';
  if (all.some((s) => s === 'failed')) return 'Preview is unavailable: a photo failed to process. Remove it and upload it again.';
  if (all.some((s) => s === 'missing')) return 'Preview is unavailable: a photo could not be found.';
  return null;
}

/** Bold and italic only, as the editor allows; everything else is text. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{unescapeAttr(part.slice(2, -2))}</strong>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{unescapeAttr(part.slice(1, -1))}</em>;
    return unescapeAttr(part);
  });
}

function Block({ source }: { source: string }) {
  const states = useContext(ImageStatusContext);
  if (/^<Photo\b/.test(source)) {
    const photo = parsePhoto(source);
    const state = states.get(photo.image);
    const versions = state && 'web_versions' in state ? state.web_versions : [];
    const largest = versions[versions.length - 1];
    return (
      <figure data-testid="preview-photo">
        {largest && (
          <img
            src={resolveUrl(largest.url)}
            srcSet={versions.map((v) => `${resolveUrl(v.url)} ${v.width}w`).join(', ')}
            sizes="100vw"
            alt={photo.alt}
          />
        )}
        {photo.caption && <figcaption>{photo.caption}</figcaption>}
        {photo.credit && <small>{photo.credit}</small>}
      </figure>
    );
  }
  return <p>{inline(source)}</p>;
}

/** The draft laid out roughly as a reader sees it. Minimal until the public renderer (#16) exists. */
function PreviewBody({ draft }: { draft: DraftText }) {
  const tags = photoTags(draft.content);
  const pieces: string[] = [];
  let rest = draft.content;
  for (const tag of tags) {
    const at = rest.indexOf(tag);
    pieces.push(...rest.slice(0, at).split(/\n{2,}/), tag);
    rest = rest.slice(at + tag.length);
  }
  pieces.push(...rest.split(/\n{2,}/));
  return (
    <article data-testid="preview" className="preview">
      <h1>{draft.title}</h1>
      {(draft.date || draft.location) && <p>{[draft.date, draft.location].filter(Boolean).join(' · ')}</p>}
      {pieces.filter((p) => p.trim()).map((p, i) => (
        <Block key={i} source={p.trim()} />
      ))}
    </article>
  );
}

/**
 * The preview toggle. While any photo in the draft is not ready the button is greyed out
 * and says why; it cannot open.
 */
export function DraftPreview({ draft, imageIds }: { draft: DraftText; imageIds: readonly string[] }) {
  const states = useContext(ImageStatusContext);
  const [open, setOpen] = useState(false);
  const blocker = previewBlocker(imageIds, states);
  return (
    <div className="preview-area">
      <button
        type="button"
        data-testid="preview-button"
        className={blocker ? 'greyed' : undefined}
        aria-disabled={blocker ? true : undefined}
        disabled={blocker !== null}
        onClick={() => setOpen((o) => !o)}
      >
        {open && !blocker ? 'Close preview' : 'Preview'}
      </button>
      {blocker && (
        <span data-testid="preview-reason" role="status">
          {' '}
          {blocker}
        </span>
      )}
      {open && !blocker && <PreviewBody draft={draft} />}
    </div>
  );
}
