import { Component, type ReactNode } from 'react';

/**
 * Catches a failed load of the lazy editor chunk (offline, or a deploy replaced the file) and
 * offers a reload, instead of leaving a blank page.
 */
export class EditorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" data-testid="editor-load-failed" style={{ padding: 24, font: '16px/1.5 system-ui, sans-serif' }}>
        <p>The editor could not load.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
