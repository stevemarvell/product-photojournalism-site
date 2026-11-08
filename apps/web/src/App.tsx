import {
  IonApp,
  IonContent,
  IonHeader,
  IonText,
  IonTitle,
  IonToolbar,
  setupIonicReact,
} from '@ionic/react';

setupIonicReact();

/**
 * The web app's shell: a placeholder, showing no application, kept live to
 * serve the project's documentation at /docs/ until a real application
 * replaces it.
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
        <div className="centred" data-testid="shell">
          <IonText color="medium">
            <p>No application here yet.</p>
          </IonText>
          <a href="/docs/">The project documentation</a>
        </div>
      </IonContent>
    </IonApp>
  );
}
