import { useEffect, useState } from 'react';
import {
  IonApp,
  IonContent,
  IonHeader,
  IonText,
  IonTitle,
  IonToolbar,
  setupIonicReact,
} from '@ionic/react';

import { fetchHealth } from './api';

setupIonicReact();

/**
 * The web app's shell: a placeholder, showing no application, kept live to
 * serve the project's documentation at /docs/ until a real application
 * replaces it.
 */
export function App() {
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [database, setDatabase] = useState('');

  useEffect(() => {
    let live = true;
    fetchHealth()
      .then((h) => {
        if (!live) return;
        setDatabase(`${h.database.adapter}, ${h.database.reachable ? 'reachable' : 'unreachable'}`);
        setStatus('ok');
      })
      .catch(() => {
        if (live) setStatus('error');
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <IonApp>
      <IonHeader>
        <IonToolbar>
          <IonTitle>{__APP_NAME__}</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="centred" data-testid="shell">
          <IonText color="medium">
            <p>No application here yet.</p>
          </IonText>
          {status === 'loading' && <p data-testid="api-status">Contacting the API…</p>}
          {status === 'ok' && <p data-testid="api-status">API ok. Database: {database}</p>}
          {status === 'error' && (
            <p data-testid="api-error" role="alert">
              The API could not be reached.
            </p>
          )}
          <a href="/docs/">The project documentation</a>
        </div>
      </IonContent>
    </IonApp>
  );
}
