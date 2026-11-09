import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BoldItalicUnderlineToggles,
  Button,
  DialogButton,
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

import { flattenMarkdown, movePhoto } from './content';
import { PHOTO_DESCRIPTOR, PhotoContext, createPhotoStore } from './PhotoBlock';

function PhotoButton() {
  const insert = usePublisher(insertJsx$);
  return (
    <DialogButton
      tooltipTitle="Insert photo"
      buttonContent={<span data-testid="photo-button">Photo</span>}
      dialogInputPlaceholder="Image id"
      submitButtonTitle="Insert photo"
      onSubmit={(id) => {
        if (!id.trim()) return;
        insert({
          name: 'Photo',
          kind: 'flow',
          props: { image: id.trim(), alt: '', caption: '', credit: '' },
        });
      }}
    />
  );
}

function Toolbar({ onLeaveSource }: { onLeaveSource: () => void }) {
  const mode = useCellValue(viewMode$);
  const setMode = usePublisher(viewMode$);
  const source = mode === 'source';
  return (
    <>
      {!source && <BoldItalicUnderlineToggles options={['Bold', 'Italic']} />}
      {!source && <PhotoButton />}
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

  const handleChange = useCallback(
    (markdown: string) => {
      const flat = flattenMarkdown(markdown);
      onChange(flat);
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
        editor.current?.setMarkdown(next);
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
            onLeaveSource={() => {
              // Source view may hold markup the visual editor has no node for.
              const current = editor.current?.getMarkdown() ?? '';
              const flat = flattenMarkdown(current);
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
      <div
        ref={container}
        data-testid="body-editor"
      >
        <MDXEditor
          ref={editor}
          markdown={flattenMarkdown(initial)}
          onChange={handleChange}
          plugins={plugins}
          contentEditableClassName="body-editor-content"
        />
      </div>
    </PhotoContext.Provider>
  );
}
