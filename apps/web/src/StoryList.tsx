import { useEffect, useState } from 'react';

import { createStory, listStories, type StorySummary } from './stories-api';

/** The last-saved moment as a short date and time in the owner's own locale. */
export function formatSaved(iso: string | undefined): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The owner's list at /editor: every story, live or not, in the order the API returns. */
export function StoryList({ navigate = (url: string) => window.location.assign(url) }) {
  const [stories, setStories] = useState<StorySummary[] | 'loading' | 'failed'>('loading');
  const [liveOnly, setLiveOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);

  useEffect(() => {
    let live = true;
    listStories().then(
      (s) => live && setStories(s),
      () => live && setStories('failed'),
    );
    return () => {
      live = false;
    };
  }, []);

  const create = async () => {
    setCreating(true);
    setCreateFailed(false);
    try {
      const story = await createStory();
      navigate(`/editor/${story.id}`);
    } catch {
      setCreateFailed(true);
      setCreating(false);
    }
  };

  const shown = Array.isArray(stories) ? stories.filter((s) => !liveOnly || s.live) : [];

  return (
    <div data-testid="story-list" className="ed-list">
      <div className="ed-list-head">
        <h1>Stories</h1>
        <div className="ed-list-tools">
          <label className="ed-check">
            <input
              type="checkbox"
              data-testid="filter-live"
              checked={liveOnly}
              onChange={(e) => setLiveOnly(e.target.checked)}
            />
            Live only
          </label>
          <button type="button" className="ed-btn ed-btn-solid" data-testid="new-story" disabled={creating} onClick={() => void create()}>
            New story
          </button>
        </div>
      </div>
      {createFailed && <p role="alert">Could not create a story.</p>}
      {stories === 'loading' && <p role="status">Loading…</p>}
      {stories === 'failed' && <p role="alert">The stories could not be loaded.</p>}
      {Array.isArray(stories) && (
        <div className="ed-table" data-testid="story-table">
          <div className="ed-row ed-row-head">
            <span>Title</span>
            <span>Status</span>
            <span>Last saved</span>
          </div>
          {shown.map((s) => (
            <div key={s.id} className="ed-row" data-testid="story-row">
              <a href={`/editor/${s.id}`}>{s.title.trim() || 'Untitled'}</a>
              <span className={`ed-status ${s.live ? 'is-live' : 'is-off'}`} data-testid="live-flag">
                <span className="ed-dot" aria-hidden="true" />
                {s.live ? 'Live' : 'Not live'}
              </span>
              <span className="ed-saved" data-testid="last-saved">
                {formatSaved(s.updated_at)}
              </span>
            </div>
          ))}
          {shown.length === 0 && <p className="ed-empty">No stories to show.</p>}
        </div>
      )}
    </div>
  );
}
