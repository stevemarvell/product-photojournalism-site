import {
  IonApp,
  IonContent,
  setupIonicReact,
} from '@ionic/react';

import { Editor } from './Editor';
import { PublicSite } from './PublicSite';

setupIonicReact();

/**
 * The web app: the public site (PublicSite.tsx) for everyone, and the owner-only editor
 * at /editor (Editor.tsx). The public pages are a plain white page of their own, outside
 * Ionic's app chrome; the editor keeps it.
 */
export function App() {
  const path = window.location.pathname;
  if (/^\/editor(\/|$)/.test(path)) {
    const onStory = /\/editor\/[^/]/.test(path);
    return (
      <IonApp>
        <header className="ed-bar">
          <div className={`ed-bar-inner ${onStory ? 'ed-wide' : 'ed-narrow'}`}>
            {onStory ? (
              <>
                <span id="editor-bar-left">
                  {/* Shown until the drafting screen mounts and brings its own (which saves first). */}
                  <a href="/editor" className="ed-bar-link ed-bar-default" data-testid="bar-stories">
                    ← Stories
                  </a>
                </span>
                <span id="editor-bar-right" />
              </>
            ) : (
              <>
                <span className="ed-bar-name">
                  {__APP_NAME__}
                  <span className="ed-bar-tag">Editor</span>
                </span>
                <a href="/" className="ed-bar-link">
                  View site
                </a>
              </>
            )}
          </div>
        </header>
        <IonContent>
          <div className="ed-root">
            <Editor />
          </div>
        </IonContent>
      </IonApp>
    );
  }
  return <PublicSite path={path} />;
}
