import {
  IonApp,
  IonContent,
  IonHeader,
  IonTitle,
  IonToolbar,
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
    return (
      <IonApp>
        <IonHeader>
          <IonToolbar>
            <IonTitle>{__APP_NAME__}</IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonContent>
          <div className="centred">
            <Editor />
          </div>
        </IonContent>
      </IonApp>
    );
  }
  return <PublicSite path={path} />;
}
