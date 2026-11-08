import { useEffect, useState } from 'react';
import { IonButton, IonText } from '@ionic/react';

import { fetchSession, loginUrl, signOut, type Session } from './api';

/**
 * The editor route (/editor). A placeholder for the real editor: what matters
 * here is the guard. Until /auth/me has said "signed in" it renders nothing of
 * the editor, and when it says signed out it sends the visitor to sign in.
 * (The API refuses every write on its own; this only keeps the page honest.)
 */
export function Editor({ navigate = (url: string) => window.location.assign(url) }) {
  const [session, setSession] = useState<Session | 'loading'>('loading');

  useEffect(() => {
    let live = true;
    fetchSession().then((s) => {
      if (!live) return;
      setSession(s);
      if (s.state === 'signed-out') navigate(loginUrl());
    });
    return () => {
      live = false;
    };
    // navigate is stable for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (session === 'loading' || session.state === 'signed-out') {
    return (
      <p data-testid="editor-redirecting" role="status">
        Checking sign-in…
      </p>
    );
  }
  if (session.state === 'unconfigured') {
    return (
      <p data-testid="editor-unconfigured" role="alert">
        Sign-in is not configured yet.
      </p>
    );
  }
  return (
    <div data-testid="editor-content">
      <IonText>
        <p>Signed in as {session.name}. The editor will be here.</p>
      </IonText>
      <IonButton
        data-testid="sign-out"
        onClick={() => {
          void signOut()
            .then(fetchSession)
            .then(setSession)
            .then(() => navigate('/'));
        }}
      >
        Sign out
      </IonButton>
    </div>
  );
}
