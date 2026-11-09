import { useEffect, useState } from 'react';

import { createStory, listStories, type StorySummary } from './stories-api';

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
    <div data-testid="story-list">
      <button type="button" data-testid="new-story" disabled={creating} onClick={() => void create()}>
        New story
      </button>
      {createFailed && <p role="alert">Could not create a story.</p>}
      <label>
        <input
          type="checkbox"
          data-testid="filter-live"
          checked={liveOnly}
          onChange={(e) => setLiveOnly(e.target.checked)}
        />{' '}
        Live only
      </label>
      {stories === 'loading' && <p role="status">Loading…</p>}
      {stories === 'failed' && <p role="alert">The stories could not be loaded.</p>}
      {Array.isArray(stories) && shown.length === 0 && <p>No stories to show.</p>}
      <ul>
        {shown.map((s) => (
          <li key={s.id} data-testid="story-row">
            <a href={`/editor/${s.id}`}>{s.title.trim() || 'Untitled'}</a>{' '}
            <span data-testid="live-flag">{s.live ? 'Live' : 'Not live'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
