import '@ionic/react/css/core.css';
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';
import './editor.css';
import { IonApp, IonContent, setupIonicReact } from '@ionic/react';

import { Editor } from './Editor';

setupIonicReact();

/**
 * The owner-only editor inside Ionic's app chrome. Loaded on demand by App.tsx, so the public
 * pages never download Ionic or the editor.
 */
export default function EditorShell({ path }: { path: string }) {
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
