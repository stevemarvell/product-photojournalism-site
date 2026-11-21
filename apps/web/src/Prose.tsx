import type { ReactNode } from 'react';

import type { Inline } from './render';

/**
 * One paragraph, drawn from `parseBody`'s inline runs. Shared by the public page and the
 * editor's preview so both show the same text. Text nodes only: React prints a string as
 * text, whatever characters it holds; no HTML is built from the body.
 */
export function Paragraph({ inlines }: { inlines: Inline[] }) {
  return (
    <p>
      {inlines.map((r, j) => {
        let node: ReactNode = r.text;
        if (r.italic) node = <em>{node}</em>;
        if (r.bold) node = <strong>{node}</strong>;
        return <span key={j}>{node}</span>;
      })}
    </p>
  );
}
