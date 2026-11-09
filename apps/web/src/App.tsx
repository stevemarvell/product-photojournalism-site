import { useEffect, useState } from 'react';
import {
  IonApp,
  IonButton,
  IonContent,
  IonHeader,
  IonText,
  IonTitle,
  IonToolbar,
  setupIonicReact,
} from '@ionic/react';

import { ApiNotConfiguredError, fetchHealth, loginUrl } from './api';
import { Editor } from './Editor';

setupIonicReact();

/**
 * The web app's shell: a placeholder, showing no application, kept live to
 * serve the project's documentation at /docs/ until a real application
 * replaces it. /editor is the owner-only editor (see Editor.tsx).
 */
export function App() {
  return (
    <IonApp>
      <IonHeader>
        <IonToolbar>
          <IonTitle>{__APP_NAME__}</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="centred">
          {/^\/editor(\/|$)/.test(window.location.pathname) ? <Editor /> : <Home />}
        </div>
      </IonContent>
    </IonApp>
  );
}

function Home() {
  const [status, setStatus] = useState<'loading' | 'ok' | 'error' | 'unconfigured'>('loading');
  const [database, setDatabase] = useState('');

  useEffect(() => {
    let live = true;
    fetchHealth()
      .then((h) => {
        if (!live) return;
        setDatabase(`${h.database.adapter}, ${h.database.reachable ? 'reachable' : 'unreachable'}`);
        setStatus('ok');
      })
      .catch((e: unknown) => {
        if (!live) return;
        setStatus(e instanceof ApiNotConfiguredError ? 'unconfigured' : 'error');
      });
    return () => {
      live = false;
    };
  }, []);

  const refused = new URLSearchParams(window.location.search).get('signin') === 'refused';

  return (
    <div data-testid="shell">
      <IonText color="medium">
        <p>No application here yet.</p>
      </IonText>
      {refused && (
        <p data-testid="signin-refused" role="alert">
          Sign-in was refused.
        </p>
      )}
      {status === 'loading' && <p data-testid="api-status">Contacting the API…</p>}
      {status === 'ok' && <p data-testid="api-status">API ok. Database: {database}</p>}
      {status === 'unconfigured' && (
        <p data-testid="api-error" role="alert">
          API address not configured.
        </p>
      )}
      {status === 'error' && (
        <p data-testid="api-error" role="alert">
          The API could not be reached.
        </p>
      )}
      <IonButton data-testid="sign-in" href={loginUrl()}>
        Sign in with Vercel
      </IonButton>
      <br />
      <a href="/docs/">The project documentation</a>
    </div>
  );
}
