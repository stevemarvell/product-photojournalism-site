import { lazy, Suspense } from 'react';

import { PublicSite } from './PublicSite';

// The editor and Ionic load only on /editor: the public pages carry neither.
const EditorShell = lazy(() => import('./EditorShell'));

/**
 * The web app: the public site (PublicSite.tsx) for everyone, and the owner-only editor
 * at /editor (EditorShell.tsx). The public pages are a plain page of their own, outside
 * Ionic's app chrome; the editor keeps it.
 */
export function App() {
  const path = window.location.pathname;
  if (/^\/editor(\/|$)/.test(path)) {
    return (
      <Suspense fallback={<p>Loading…</p>}>
        <EditorShell path={path} />
      </Suspense>
    );
  }
  return <PublicSite path={path} />;
}
