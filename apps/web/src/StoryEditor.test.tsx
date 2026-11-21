import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Drafting } from './StoryEditor';
import { StoryList } from './StoryList';
import type { StoryDetail } from './stories-api';

beforeEach(() => vi.stubEnv('VITE_API_URL', '/api'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const PHOTO = '<Photo image="img-1" alt="A harbour" caption="" credit="" />';

function story(over: Partial<StoryDetail['draft']> = {}): StoryDetail {
  return {
    id: 's1',
    live: false,
    updated_at: '2026-11-09T10:00:00Z',
    published: null,
    draft: { title: '', description: '', location: '', date: null, content: '', ...over },
  };
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function stubFetch(handler: Handler) {
  const spy = vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  // The screen also follows the images its draft names (GET /images/:id); these tests are
  // about stories, so those reads are answered "ready" and are not counted in the spy.
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    /\/images\/[^/]+$/.test(url) && !init?.method
      ? Promise.resolve(json({ id: 'x', status: 'ready', web_versions: [], width: 1, height: 1, byte_size: 1 }))
      : spy(url, init),
  );
  return spy;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('story fields and autosave', () => {
  it('saves title, description, date and location as draft fields, apart from the content', async () => {
    const fetchSpy = stubFetch(() => json({ ...story(), updated_at: '2026-11-09T10:00:01Z' }));
    render(<Drafting story={story({ content: PHOTO })} />);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'Harbour' } });
    fireEvent.change(screen.getByTestId('field-description'), { target: { value: 'Dawn at the harbour' } });
    fireEvent.change(screen.getByTestId('field-date'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByTestId('field-location'), { target: { value: 'Falmouth' } });
    expect(screen.getByTestId('save-indicator').textContent).toBe('Saving…');
    await waitFor(() => expect(screen.getByTestId('save-indicator').textContent).toBe('Saved'), { timeout: 4000 });
    // One debounced save carrying every change, and the updated_at last seen.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/stories/s1/draft');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      title: 'Harbour',
      description: 'Dawn at the harbour',
      date: '2026-11-01',
      location: 'Falmouth',
      content: PHOTO,
      updated_at: '2026-11-09T10:00:00Z',
      client_id: expect.any(String),
      seq: expect.any(Number),
    });
  });

  it('sends the newer updated_at on the next save', async () => {
    let n = 0;
    const fetchSpy = stubFetch(() => json({ ...story(), updated_at: `2026-11-09T10:00:0${++n}Z` }));
    render(<Drafting story={story()} />);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'a' } });
    await waitFor(() => expect(screen.getByTestId('save-indicator').textContent).toBe('Saved'), { timeout: 4000 });
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'ab' } });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(JSON.parse((fetchSpy.mock.calls[1]?.[1] as RequestInit).body as string).updated_at).toBe('2026-11-09T10:00:01Z');
  });

  it('on a 409 stops autosaving and says it changed elsewhere', async () => {
    const fetchSpy = stubFetch(() => json({ detail: 'changed' }, 409));
    render(<Drafting story={story()} />);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'a' } });
    await waitFor(() => expect(screen.getByTestId('conflict').textContent).toContain('Changed elsewhere, reload'), {
      timeout: 4000,
    });
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'ab' } });
    await new Promise((r) => setTimeout(r, 1200));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('publish')).toHaveProperty('disabled', true);
  });
});

describe('leaving with an edit still inside the pause', () => {
  const saved = () => json({ ...story(), updated_at: '2026-11-09T10:00:01Z' });

  it('sends the edit when the screen unmounts before the pause ends', async () => {
    const fetchSpy = stubFetch(saved);
    const { unmount } = render(<Drafting story={story()} />);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'Typed just now' } });
    expect(fetchSpy).not.toHaveBeenCalled(); // still inside the debounce
    unmount();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/stories/s1/draft');
    expect(JSON.parse(init.body as string).title).toBe('Typed just now');
  });

  it('sends the edit on pagehide with keepalive, so closing the tab does not lose it', () => {
    const fetchSpy = stubFetch(saved);
    render(<Drafting story={story()} />);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'Closing now' } });
    window.dispatchEvent(new Event('pagehide'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body as string).title).toBe('Closing now');
  });

  it('stores newer text sent on pagehide while the first save is in flight, against the API rules', async () => {
    // A server that applies the API's rule: accept the stored updated_at, or the base of
    // this same client's last save. Save A is applied at once but its response never arrives.
    const server = { updatedAt: '2026-11-09T10:00:00Z', by: '', prev: '', title: '', n: 0, seq: 0 };
    const fetchSpy = stubFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      const own =
        body.client_id === server.by && body.updated_at === server.prev && body.seq > server.seq;
      if (body.updated_at !== server.updatedAt && !own) return json({ detail: 'changed' }, 409);
      server.n += 1;
      Object.assign(server, { prev: body.updated_at, by: body.client_id, title: body.title, seq: body.seq });
      server.updatedAt = `2026-11-09T10:00:0${server.n}Z`;
      return json({ ...story(), updated_at: server.updatedAt });
    });
    fetchSpy.mockImplementationOnce((_url, init) => {
      const body = JSON.parse(init?.body as string);
      Object.assign(server, {
        n: 1,
        prev: body.updated_at,
        by: body.client_id,
        title: body.title,
        seq: body.seq,
      });
      server.updatedAt = '2026-11-09T10:00:01Z';
      return new Promise<Response>(() => {}); // lands on the server; the response never comes
    });
    render(<Drafting story={story()} />);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'First' } });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1), { timeout: 4000 });
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'Newer' } });
    window.dispatchEvent(new Event('pagehide'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const first = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
    const init = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    const second = JSON.parse(init.body as string);
    expect(init.keepalive).toBe(true);
    expect(second.title).toBe('Newer');
    expect(second.client_id).toEqual(expect.any(String));
    expect(second.client_id).toBe(first.client_id);
    expect(second.seq).toBeGreaterThan(first.seq); // a later save of this tab
    expect(second.updated_at).toBe(first.updated_at); // the same base: only the client id lets it in
    await waitFor(() => expect(server.title).toBe('Newer'));
  });

  it('All stories saves the pending edit before it navigates', async () => {
    const order: string[] = [];
    stubFetch(() => {
      order.push('put');
      return saved();
    });
    const navigate = vi.fn(() => order.push('navigate'));
    render(<Drafting story={story()} navigate={navigate} />);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'Last words' } });
    fireEvent.click(screen.getByTestId('all-stories'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/editor'));
    expect(order).toEqual(['put', 'navigate']);
  });

  it('All stories stays, rather than lose the edit, when the save fails', async () => {
    stubFetch(() => new Response('x', { status: 500 }));
    const navigate = vi.fn();
    render(<Drafting story={story()} navigate={navigate} />);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'Unsaved' } });
    fireEvent.click(screen.getByTestId('all-stories'));
    await waitFor(() => expect(screen.getByTestId('save-indicator').textContent).toContain('Could not save'));
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('a refused save and the unsaved-changes prompt', () => {
  const refused = () =>
    json({ detail: { message: 'content not allowed', reasons: ['only Photo tags are allowed'] } }, 422);

  it('shows the server reasons next to the indicator when the save is refused', async () => {
    stubFetch(refused);
    render(<Drafting story={story()} />);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'x' } });
    await waitFor(() => expect(screen.getByTestId('save-refused').textContent).toContain('only Photo tags are allowed'), {
      timeout: 4000,
    });
    expect(screen.getByTestId('save-indicator').textContent).toBe('Not saved');
  });

  it('All stories does not trap the owner: it shows the reasons and offers to leave anyway', async () => {
    stubFetch(refused);
    const navigate = vi.fn();
    render(<Drafting story={story()} navigate={navigate} />);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('all-stories'));
    await waitFor(() => expect(screen.getByTestId('leave-blocked')).toBeTruthy());
    expect(screen.getByTestId('save-refused').textContent).toContain('only Photo tags are allowed');
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('leave-anyway'));
    expect(navigate).toHaveBeenCalledWith('/editor');
    // A deliberate leave is not asked about a second time.
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('registers a beforeunload prompt while changes are unsaved and clears it once saved', async () => {
    stubFetch(() => json({ ...story(), updated_at: '2026-11-09T10:00:01Z' }));
    render(<Drafting story={story()} />);
    const prompts = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(prompts()).toBe(false); // nothing typed yet
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'x' } });
    await waitFor(() => expect(prompts()).toBe(true)); // inside the pause, and in flight
    await waitFor(() => expect(screen.getByTestId('save-indicator').textContent).toBe('Saved'), { timeout: 4000 });
    await waitFor(() => expect(prompts()).toBe(false));
  });
});

describe('publish', () => {
  it('is disabled with a short reason when the draft fails the rule', () => {
    stubFetch(() => json({}));
    render(<Drafting story={story({ title: 'T', content: '<Photo image="i" alt="" caption="" credit="" />' })} />);
    expect(screen.getByTestId('publish')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('publish-reason').textContent).toContain('add a description');
    expect(screen.getByTestId('publish-reason').textContent).toContain('add alt text to photo 1');
  });

  it('is enabled for a passing draft, and pressing it calls the API', async () => {
    const fetchSpy = stubFetch((url) =>
      url.endsWith('/publish') ? json({ ...story(), live: true, updated_at: '2026-11-09T10:00:05Z' }) : json(story()),
    );
    render(<Drafting story={story({ title: 'T', description: 'D', content: PHOTO })} />);
    const button = screen.getByTestId('publish');
    expect(button).toHaveProperty('disabled', false);
    expect(screen.queryByTestId('publish-reason')).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('publish-message').textContent).toContain('Published'));
    expect(fetchSpy).toHaveBeenCalledWith('/api/stories/s1/publish', { method: 'POST' });
  });

  it('shows the server reasons on a 422 (an image that is not ready)', async () => {
    stubFetch(() => json({ detail: { message: 'publish refused', reasons: ['Photo 1: image img-1 is not ready'] } }, 422));
    render(<Drafting story={story({ title: 'T', description: 'D', content: PHOTO })} />);
    fireEvent.click(screen.getByTestId('publish'));
    await waitFor(() => expect(screen.getByTestId('publish-message').textContent).toContain('image img-1 is not ready'));
  });

  it('asks the confirm seam first and does not publish when it says no', async () => {
    const fetchSpy = stubFetch(() => json(story()));
    const confirmPublish = vi.fn().mockResolvedValue(false);
    render(<Drafting story={story({ title: 'T', description: 'D', content: PHOTO })} confirmPublish={confirmPublish} />);
    fireEvent.click(screen.getByTestId('publish'));
    await waitFor(() => expect(confirmPublish).toHaveBeenCalled());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

const PUBLISHED = { title: 'Live title', description: 'Live', location: '', date: null, content: PHOTO };

/** A story published before: `live` as stated, a draft as stated (the published text above). */
function publishedStory(over: { live?: boolean; draft?: Partial<StoryDetail['draft']> } = {}): StoryDetail {
  return {
    id: 's1',
    live: over.live ?? true,
    updated_at: '2026-11-09T10:00:00Z',
    published: PUBLISHED,
    draft: { ...PUBLISHED, ...over.draft },
  };
}

const action = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);

describe('lifecycle actions (issue #17)', () => {
  it('Revert is hidden for a never-published story', () => {
    stubFetch(() => json(story()));
    render(<Drafting story={story({ title: 'T' })} />);
    expect(screen.queryByTestId('revert')).toBeNull();
    expect(screen.queryByTestId('unpublish')).toBeNull();
    expect(screen.queryByTestId('republish')).toBeNull();
  });

  it('Revert is disabled while the draft matches the published text, enabled once it differs', () => {
    stubFetch(() => json(story()));
    render(<Drafting story={publishedStory()} />);
    expect(screen.getByTestId('revert')).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'Edited' } });
    expect(screen.getByTestId('revert')).toHaveProperty('disabled', false);
  });

  it('shows Unpublish only when live and Republish only when published before and not live', () => {
    stubFetch(() => json(story()));
    const { unmount } = render(<Drafting story={publishedStory({ live: true })} />);
    expect(screen.getByTestId('unpublish')).toBeTruthy();
    expect(screen.queryByTestId('republish')).toBeNull();
    unmount();
    render(<Drafting story={publishedStory({ live: false })} />);
    expect(screen.getByTestId('republish')).toBeTruthy();
    expect(screen.queryByTestId('unpublish')).toBeNull();
  });

  it('says Publish will update the live version when live and the draft differs, and not otherwise', () => {
    stubFetch(() => json(story()));
    const { unmount } = render(<Drafting story={publishedStory({ live: true, draft: { title: 'Newer' } })} />);
    expect(screen.getByTestId('update-live-note').textContent).toBe('Publish will update the live version.');
    unmount();
    render(<Drafting story={publishedStory({ live: true })} />);
    expect(screen.queryByTestId('update-live-note')).toBeNull();
    cleanup();
    render(<Drafting story={publishedStory({ live: false, draft: { title: 'Newer' } })} />);
    expect(screen.queryByTestId('update-live-note')).toBeNull();
  });

  it('Unpublish calls the API and flips the buttons', async () => {
    const spy = stubFetch(() => json({ ...publishedStory({ live: false }), updated_at: '2026-11-09T10:00:01Z' }));
    render(<Drafting story={publishedStory()} />);
    fireEvent.click(screen.getByTestId('unpublish'));
    await waitFor(() => expect(screen.getByTestId('republish')).toBeTruthy());
    expect(action(spy)).toEqual(['POST /api/stories/s1/unpublish']);
    expect(screen.queryByTestId('unpublish')).toBeNull();
  });

  it('Republish calls the API and flips the buttons', async () => {
    const spy = stubFetch(() => json(publishedStory({ live: true })));
    render(<Drafting story={publishedStory({ live: false })} />);
    fireEvent.click(screen.getByTestId('republish'));
    await waitFor(() => expect(screen.getByTestId('unpublish')).toBeTruthy());
    expect(action(spy)).toEqual(['POST /api/stories/s1/republish']);
  });

  it('shows the API reasons when it refuses an action', async () => {
    stubFetch(() => json({ detail: { message: 'action not allowed', reasons: ['the story is not live'] } }, 422));
    render(<Drafting story={publishedStory()} />);
    fireEvent.click(screen.getByTestId('unpublish'));
    await waitFor(() => expect(screen.getByTestId('publish-message').textContent).toContain('the story is not live'));
  });

  it('Publish over published text asks first; cancelling publishes nothing', async () => {
    const spy = stubFetch(() => json(publishedStory()));
    render(<Drafting story={publishedStory({ draft: { title: 'Newer' } })} />);
    fireEvent.click(screen.getByTestId('publish'));
    expect(await screen.findByTestId('confirm')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId('publish')).toHaveProperty('disabled', false);
  });

  it('Publish over published text goes ahead once confirmed', async () => {
    const spy = stubFetch(() => json({ ...publishedStory(), updated_at: '2026-11-09T10:00:01Z' }));
    render(<Drafting story={publishedStory({ draft: { title: 'Newer' } })} />);
    fireEvent.click(screen.getByTestId('publish'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(screen.getByTestId('publish-message').textContent).toContain('Published'));
    expect(action(spy).at(-1)).toBe('POST /api/stories/s1/publish');
  });

  it('Publish of a never-published story does not ask', async () => {
    const spy = stubFetch(() => json({ ...publishedStory(), updated_at: '2026-11-09T10:00:01Z' }));
    render(<Drafting story={story({ title: 'T', description: 'D', content: PHOTO })} />);
    fireEvent.click(screen.getByTestId('publish'));
    await waitFor(() => expect(screen.getByTestId('publish-message').textContent).toContain('Published'));
    expect(screen.queryByTestId('confirm')).toBeNull();
    expect(action(spy)).toEqual(['POST /api/stories/s1/publish']);
  });

  it('Revert asks first; cancelling changes nothing and calls nothing', async () => {
    const spy = stubFetch(() => json(publishedStory()));
    render(<Drafting story={publishedStory({ draft: { title: 'Newer' } })} />);
    fireEvent.click(screen.getByTestId('revert'));
    expect(await screen.findByTestId('confirm')).toBeTruthy();
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
    expect((screen.getByTestId('field-title') as HTMLInputElement).value).toBe('Newer');
  });

  it('Revert, confirmed, reloads the draft and its updated_at, and the next save uses it', async () => {
    const reverted = { ...publishedStory(), updated_at: '2026-11-09T10:05:00Z' };
    const spy = stubFetch((url) => json(url.endsWith('/revert') ? reverted : { ...reverted, updated_at: '2026-11-09T10:06:00Z' }));
    render(<Drafting story={publishedStory({ draft: { title: 'Newer' } })} />);
    fireEvent.click(screen.getByTestId('revert'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect((screen.getByTestId('field-title') as HTMLInputElement).value).toBe('Live title'));
    expect(action(spy)).toEqual(['POST /api/stories/s1/revert']);
    expect(screen.getByTestId('revert')).toHaveProperty('disabled', true); // now matches
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'After revert' } });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(JSON.parse((spy.mock.calls[1]?.[1] as RequestInit).body as string).updated_at).toBe('2026-11-09T10:05:00Z');
  });

  it('Revert sends a pending autosave and waits for the one in flight, then reverts, in that order', async () => {
    const finish: ((r: Response) => void)[] = [];
    const order: string[] = [];
    const spy = stubFetch((url, init) => {
      order.push(`${init?.method} ${url}`);
      if (init?.method === 'PUT') {
        return new Promise<Response>((resolve) => finish.push(resolve)) as unknown as Response;
      }
      return json({ ...publishedStory(), updated_at: '2026-11-09T10:09:00Z' });
    });
    render(<Drafting story={publishedStory()} />);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'One' } });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1), { timeout: 4000 }); // in flight
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'Two' } }); // pending behind it

    fireEvent.click(screen.getByTestId('revert'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual(['PUT /api/stories/s1/draft']); // revert waits for the save in flight

    finish[0]?.(json({ ...publishedStory(), updated_at: '2026-11-09T10:07:00Z' }));
    await waitFor(() => expect(finish).toHaveLength(2)); // the pending edit is sent, not dropped
    expect(JSON.parse((spy.mock.calls[1]?.[1] as RequestInit).body as string).title).toBe('Two');
    expect(order).toHaveLength(2); // and revert still waits for it
    finish[1]?.(json({ ...publishedStory(), updated_at: '2026-11-09T10:08:00Z' }));
    await waitFor(() => expect(order).toHaveLength(3));
    expect(order[2]).toBe('POST /api/stories/s1/revert');
    await waitFor(() => expect((screen.getByTestId('field-title') as HTMLInputElement).value).toBe('Live title'));
  });

  it('a refused Revert has already saved the typing made inside the pause, and shows the reasons', async () => {
    const spy = stubFetch((_url, init) =>
      init?.method === 'PUT'
        ? json({ ...publishedStory({ draft: { title: 'Typed' } }), updated_at: '2026-11-09T10:01:00Z' })
        : json({ detail: { message: 'action not allowed', reasons: ['the draft already matches the published text'] } }, 422),
    );
    const confirmRevert = vi.fn().mockResolvedValue(true);
    render(<Drafting story={publishedStory({ draft: { title: 'Older' } })} confirmRevert={confirmRevert} />);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'Typed' } });
    fireEvent.click(screen.getByTestId('revert')); // confirmed at once, inside the 800 ms pause
    await waitFor(() => expect(screen.getByTestId('publish-message').textContent).toContain('already matches'));
    expect(action(spy)).toEqual(['PUT /api/stories/s1/draft', 'POST /api/stories/s1/revert']);
    expect(JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string).title).toBe('Typed');
    expect((screen.getByTestId('field-title') as HTMLInputElement).value).toBe('Typed');
  });

  it('Revert does not copy when the in-flight save hits a conflict', async () => {
    let finishSave: (r: Response) => void = () => {};
    const order: string[] = [];
    const spy = stubFetch((url, init) => {
      order.push(`${init?.method} ${url}`);
      return new Promise<Response>((resolve) => {
        finishSave = (r) => resolve(r);
      }) as unknown as Response;
    });
    render(<Drafting story={publishedStory()} />);
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'One' } });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1), { timeout: 4000 });
    fireEvent.click(screen.getByTestId('revert'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    finishSave(json({ detail: 'changed' }, 409));
    await waitFor(() => expect(screen.getByTestId('publish-message').textContent).toContain('Changed elsewhere'));
    expect(order).toEqual(['PUT /api/stories/s1/draft']);
  });
});

describe('the story list', () => {
  const stories = [
    { id: 'a', live: false, title: '', description: '', first_published_at: null, updated_at: '2026-11-02T09:30:00Z' },
    { id: 'b', live: true, title: 'Harbour', description: 'd', first_published_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-05T14:45:00Z' },
  ];

  it('shows every story in the API order with its live flag, and filters by live', async () => {
    stubFetch(() => json(stories));
    render(<StoryList />);
    await waitFor(() => expect(screen.getAllByTestId('story-row')).toHaveLength(2));
    const rows = () => screen.getAllByTestId('story-row').map((r) => r.querySelector('a')!.textContent);
    expect(rows()).toEqual(['Untitled', 'Harbour']);
    expect(screen.getAllByTestId('live-flag').map((r) => r.textContent)).toEqual(['Not live', 'Live']);
    fireEvent.click(screen.getByTestId('filter-live'));
    expect(rows()).toEqual(['Harbour']);
  });

  it('links each title to its story, colours the status and shows the last-saved date', async () => {
    stubFetch(() => json(stories));
    render(<StoryList />);
    await waitFor(() => expect(screen.getAllByTestId('story-row')).toHaveLength(2));
    expect(screen.getByText('Harbour').getAttribute('href')).toBe('/editor/b');
    expect(screen.getByText('Untitled').getAttribute('href')).toBe('/editor/a');
    const [off, on] = screen.getAllByTestId('live-flag');
    expect(on!.className).toContain('is-live');
    expect(off!.className).toContain('is-off');
    expect(screen.getAllByTestId('last-saved')[1]!.textContent).toContain('2026');
    expect(screen.getAllByTestId('last-saved')[1]!.textContent).toContain('5');
    expect(screen.getByRole('heading', { name: 'Stories' })).toBeTruthy();
  });

  it('says "No stories to show." when none exist, and when Live only hides them all', async () => {
    stubFetch(() => json([stories[0]]));
    render(<StoryList />);
    await waitFor(() => expect(screen.getAllByTestId('story-row')).toHaveLength(1));
    expect(screen.queryByText('No stories to show.')).toBeNull();
    fireEvent.click(screen.getByTestId('filter-live'));
    expect(screen.getByText('No stories to show.')).toBeTruthy();
    cleanup();
    stubFetch(() => json([]));
    render(<StoryList />);
    await waitFor(() => expect(screen.getByText('No stories to show.')).toBeTruthy());
  });

  it('creates a story and opens it', async () => {
    const fetchSpy = stubFetch((_url, init) => (init?.method === 'POST' ? json({ ...story(), id: 'new1' }, 201) : json([])));
    const navigate = vi.fn();
    render(<StoryList navigate={navigate} />);
    fireEvent.click(screen.getByTestId('new-story'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/editor/new1'));
    expect(fetchSpy).toHaveBeenCalledWith('/api/stories', { method: 'POST' });
  });

  it('says so when the list cannot be loaded', async () => {
    stubFetch(() => new Response('x', { status: 500 }));
    render(<StoryList />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be loaded'));
  });
});

describe('the drafting screen panel', () => {
  const PRIVATE = 'Only you can see this story. Publish to put it on the public site.';
  const LIVE = 'Readers see the published text. Draft changes stay private until you publish again.';

  it('a story that is not live says so, with its help line and a Publish button', () => {
    render(<Drafting story={story()} />);
    expect(screen.getByTestId('status-text').textContent).toBe('Not live');
    expect(screen.getByTestId('status-text').className).toContain('is-off');
    expect(screen.getByTestId('status-help').textContent).toBe(PRIVATE);
    expect(screen.getByTestId('publish').textContent).toBe('Publish');
    expect(screen.getByTestId('preview-button').textContent).toBe('Preview');
  });

  it('a live story says so, with its help line and a Publish changes button', () => {
    render(<Drafting story={{ ...story(), live: true, published: story().draft }} />);
    expect(screen.getByTestId('status-text').textContent).toBe('Live');
    expect(screen.getByTestId('status-text').className).toContain('is-live');
    expect(screen.getByTestId('status-help').textContent).toBe(LIVE);
    expect(screen.getByTestId('publish').textContent).toBe('Publish changes');
    expect(screen.getByTestId('unpublish')).toBeTruthy();
  });

  it('shows the back link to /editor and the save status', () => {
    render(<Drafting story={story()} />);
    expect(screen.getByTestId('all-stories').textContent).toBe('← Stories');
    expect(screen.getByTestId('all-stories').getAttribute('href')).toBe('/editor');
    expect(screen.getByTestId('save-indicator')).toBeTruthy();
  });
});
