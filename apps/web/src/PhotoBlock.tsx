import { createContext, useContext, useRef, useState, useSyncExternalStore } from 'react';
import { useMdastNodeUpdater, type JsxComponentDescriptor, type JsxEditorProps, type MdastJsx } from '@mdxeditor/editor';

import { escapeAttr, unescapeAttr, type PhotoAttrs } from './content';

/**
 * Where the Photo blocks sit relative to each other. A block asks for its own
 * place (so the first can hide move-up and the last move-down); the owner of
 * the editor answers moves, because a swap is a change to the whole document.
 */
export interface PhotoStore {
  listeners: Set<() => void>;
  /** The editor wires itself in after mount: where the blocks live, and how a move is made. */
  bind: (root: () => HTMLElement | null, onMove: (block: HTMLElement, direction: -1 | 1) => void) => void;
  root: () => HTMLElement | null;
  move: (block: HTMLElement, direction: -1 | 1) => void;
}

export function createPhotoStore(): PhotoStore {
  let onMove: (block: HTMLElement, direction: -1 | 1) => void = () => {};
  let getRoot: () => HTMLElement | null = () => null;
  const store: PhotoStore = {
    listeners: new Set(),
    bind: (root, move) => {
      getRoot = root;
      onMove = move;
    },
    root: () => getRoot(),
    move: (block, direction) => {
      onMove(block, direction);
      refreshPhotoBlocks(store);
    },
  };
  return store;
}

/** Tells every block to re-read its place, once the editor's DOM has settled. */
export function refreshPhotoBlocks(store: PhotoStore) {
  requestAnimationFrame(() => store.listeners.forEach((l) => l()));
}

export const PhotoContext = createContext<PhotoStore | null>(null);

function place(store: PhotoStore | null, el: HTMLElement | null): string {
  const root = store?.root();
  const blocks = root ? [...root.querySelectorAll('[data-photo-block]')] : [];
  const index = el ? blocks.indexOf(el) : -1;
  return `${index}/${blocks.length}`;
}

/**
 * The editor holds each attribute in its escaped form (see toEditorMarkdown) and
 * prints it back as it is, so this shows the unescaped text and writes the
 * escaped one.
 */
function attrsOf(node: MdastJsx): PhotoAttrs {
  const value = (name: string) => {
    const a = node.attributes.find((x) => x.type === 'mdxJsxAttribute' && x.name === name);
    return a && typeof a.value === 'string' ? unescapeAttr(a.value) : '';
  };
  return { image: value('image'), alt: value('alt'), caption: value('caption'), credit: value('credit') };
}

const FIELDS = ['image', 'alt', 'caption', 'credit'] as const;

/** The in-place editor for one Photo block: alt, caption and credit, and move up/down. */
function PhotoBlockEditor({ mdastNode }: JsxEditorProps) {
  const update = useMdastNodeUpdater<MdastJsx>();
  const store = useContext(PhotoContext);
  const ref = useRef<HTMLDivElement>(null);
  const [attrs, setAttrs] = useState<PhotoAttrs>(() => attrsOf(mdastNode));

  const where = useSyncExternalStore(
    (listener) => {
      store?.listeners.add(listener);
      // The first look happens before siblings exist: look again once mounted.
      if (store) refreshPhotoBlocks(store);
      return () => {
        store?.listeners.delete(listener);
        if (store) refreshPhotoBlocks(store);
      };
    },
    () => place(store, ref.current),
  );
  const [index = -1, total = 0] = where.split('/').map(Number);

  const set = (field: 'alt' | 'caption' | 'credit', value: string) => {
    const next = { ...attrs, [field]: value };
    setAttrs(next);
    update({
      attributes: FIELDS.map((name) => ({ type: 'mdxJsxAttribute' as const, name, value: escapeAttr(next[name]) })),
    });
  };

  return (
    <div ref={ref} data-photo-block="" data-testid="photo-block" className="photo-block" contentEditable={false}>
      <div className="photo-block-head">
        <strong>Photo</strong> <code data-testid="photo-image">{attrs.image}</code>
        {index > 0 && (
          <button type="button" data-testid="photo-up" onClick={() => ref.current && store?.move(ref.current, -1)}>
            Move up
          </button>
        )}
        {index >= 0 && index < total - 1 && (
          <button type="button" data-testid="photo-down" onClick={() => ref.current && store?.move(ref.current, 1)}>
            Move down
          </button>
        )}
      </div>
      <label>
        Alt text (required to publish)
        <input data-testid="photo-alt" value={attrs.alt} onChange={(e) => set('alt', e.target.value)} />
      </label>
      <label>
        Caption
        <input data-testid="photo-caption" value={attrs.caption} onChange={(e) => set('caption', e.target.value)} />
      </label>
      <label>
        Credit
        <input data-testid="photo-credit" value={attrs.credit} onChange={(e) => set('credit', e.target.value)} />
      </label>
    </div>
  );
}

export const PHOTO_DESCRIPTOR: JsxComponentDescriptor = {
  name: 'Photo',
  kind: 'flow',
  hasChildren: false,
  props: FIELDS.map((name) => ({ name, type: 'string' as const })),
  Editor: PhotoBlockEditor,
};
