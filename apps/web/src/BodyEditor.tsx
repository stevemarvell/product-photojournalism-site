import { createPortal } from 'react-dom';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  BoldItalicUnderlineToggles,
  Button,
  MDXEditor,
  diffSourcePlugin,
  insertJsx$,
  jsxPlugin,
  toolbarPlugin,
  usePublisher,
  useCellValue,
  viewMode$,
  type MDXEditorMethods,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';

import { canonicalPhotos, entitiseProse, escapeAttr, flattenMarkdown, movePhoto, toEditorMarkdown } from './content';
import { uploadImage, UploadRefusedError } from './images-api';
import { PHOTO_DESCRIPTOR, PhotoContext, createPhotoStore } from './PhotoBlock';

/** One file the owner picked, as the upload list shows it. */
export interface UploadRow {
  key: number;
  name: string;
  state: 'uploading' | 'done' | 'refused';
  percent: number;
  message: string;
}

type PickPhotos = (files: File[], insert: (imageId: string) => void) => void;

/** The photo button: a multi-file picker. Each chosen file is uploaded; see `useUploads`. */
/** Where the Add photo button is drawn: a node below the editor, set by BodyEditor. */
const AddPhotoSlot = createContext<HTMLElement | null>(null);

function PhotoButton({ onPick }: { onPick: PickPhotos }) {
  const slot = useContext(AddPhotoSlot);
  const insert = usePublisher(insertJsx$);
  const input = useRef<HTMLInputElement>(null);
  // The editor's own context is needed to insert a block, so the button stays a toolbar
  // child but is drawn below the text, where the design puts it.
  const button = (
    <button
      type="button"
      data-testid="photo-button"
      className="add-photo"
      title="Insert photos"
      onClick={() => input.current?.click()}
    >
      + Add photo
    </button>
  );
  return (
    <>
      {slot ? createPortal(button, slot) : button}
      <input
        ref={input}
        type="file"
        multiple
        accept="image/*"
        hidden
        data-testid="photo-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = ''; // so choosing the same files again still fires
          if (files.length === 0) return;
          onPick(files, (imageId) =>
            insert({
              name: 'Photo',
              kind: 'flow',
              props: { image: escapeAttr(imageId), alt: '', caption: '', credit: '' },
            }),
          );
        }}
      />
    </>
  );
}

function Toolbar({ onLeaveSource, onPick }: { onLeaveSource: () => void; onPick: PickPhotos }) {
  const mode = useCellValue(viewMode$);
  const setMode = usePublisher(viewMode$);
  const source = mode === 'source';
  return (
    <>
      {!source && <BoldItalicUnderlineToggles options={['Bold', 'Italic']} />}
      {!source && <PhotoButton onPick={onPick} />}
      <Button
        data-testid="source-toggle"
        aria-pressed={source}
        onClick={() => {
          if (source) onLeaveSource();
          setMode(source ? 'rich-text' : 'source');
        }}
      >
        {source ? 'Visual view' : 'Source view'}
      </Button>
    </>
  );
}

/**
 * MDXEditor limited to what a story offers (spec section 7): paragraphs, bold,
 * italic and the Photo block. The heading, list, quote, link and code plugins
 * are simply not loaded, so there are no such nodes to create or paste; and
 * `flattenMarkdown` strips the markdown for them from source view and from
 * every change, so it cannot reach the saved draft either.
 */
export function BodyEditor({ initial, onChange }: { initial: string; onChange: (markdown: string) => void }) {
  const editor = useRef<MDXEditorMethods>(null);
  const container = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const nextKey = useRef(0);

  const patch = useCallback((key: number, change: Partial<UploadRow>) => {
    setUploads((rows) => rows.map((r) => (r.key === key ? { ...r, ...change } : r)));
  }, []);

  /**
   * Uploads run side by side, but the blocks go in strictly in the order the files were
   * chosen: each file's block is inserted only once every earlier file has been inserted
   * or has failed, however the uploads finish. A refused file gets a message and no block.
   */
  const pick = useCallback<PickPhotos>((files, insert) => {
    const rows = files.map((f): UploadRow => ({
      key: nextKey.current++,
      name: f.name,
      state: 'uploading',
      percent: 0,
      message: '',
    }));
    setUploads((current) => [...current, ...rows]);
    const results = files.map((file, i) =>
      uploadImage(file, (percent) => patch(rows[i]!.key, { percent })).then(
        (info) => info,
        (error: unknown) => {
          const message = error instanceof UploadRefusedError ? error.message : `${file.name}: the upload failed.`;
          patch(rows[i]!.key, { state: 'refused', message });
          return null;
        },
      ),
    );
    void (async () => {
      for (const [i, result] of results.entries()) {
        const info = await result;
        if (!info) continue;
        insert(info.id);
        patch(rows[i]!.key, { state: 'done', percent: 100 });
      }
    })();
  }, [patch]);
  const pickPhotos = useRef<PickPhotos>(pick);
  useEffect(() => {
    pickPhotos.current = pick;
  }, [pick]);

  const handleChange = useCallback(
    (markdown: string) => {
      onChange(entitiseProse(canonicalPhotos(flattenMarkdown(markdown))));
    },
    [onChange],
  );

  const [store] = useState(createPhotoStore);
  useEffect(() => {
    store.bind(
      () => container.current,
      (block, direction) => {
        const blocks = [...(container.current?.querySelectorAll('[data-photo-block]') ?? [])];
        const current = editor.current?.getMarkdown() ?? '';
        const next = movePhoto(current, blocks.indexOf(block), direction);
        if (next === current) return;
        editor.current?.setMarkdown(toEditorMarkdown(next));
        handleChange(next);
      },
    );
  }, [store, handleChange]);

  const plugins = useMemo(
    () => [
      jsxPlugin({ jsxComponentDescriptors: [PHOTO_DESCRIPTOR] }),
      diffSourcePlugin({ viewMode: 'rich-text' }),
      toolbarPlugin({
        toolbarContents: () => (
          <Toolbar
            onPick={(files, insert) => pickPhotos.current(files, insert)}
            onLeaveSource={() => {
              // Source view may hold markup the visual editor has no node for.
              const current = editor.current?.getMarkdown() ?? '';
              const flat = toEditorMarkdown(flattenMarkdown(current));
              if (flat !== current) editor.current?.setMarkdown(flat);
            }}
          />
        ),
      }),
    ],
    [],
  );

  return (
    <PhotoContext.Provider value={store}>
      <AddPhotoSlot.Provider value={slot}>
      <div
        ref={container}
        data-testid="body-editor"
      >
        <MDXEditor
          ref={editor}
          markdown={toEditorMarkdown(flattenMarkdown(initial))}
          onChange={handleChange}
          plugins={plugins}
          contentEditableClassName="body-editor-content"
        />
        <div ref={setSlot} className="add-photo-slot" />
        {uploads.length > 0 && (
          <ul data-testid="uploads" className="uploads" aria-live="polite">
            {uploads.map((u) => (
              <li key={u.key} data-testid="upload-row" data-state={u.state}>
                {u.state === 'uploading' && (
                  <>
                    {u.name}: uploading {u.percent}% <progress max={100} value={u.percent} />
                  </>
                )}
                {u.state === 'done' && <>{u.name}: uploaded</>}
                {u.state === 'refused' && <span role="alert">{u.message}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      </AddPhotoSlot.Provider>
    </PhotoContext.Provider>
  );
}
