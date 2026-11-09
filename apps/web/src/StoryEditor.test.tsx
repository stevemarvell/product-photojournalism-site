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
  vi.stubGlobal('fetch', spy);
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
    const server = { updatedAt: '2026-11-09T10:00:00Z', by: '', prev: '', title: '', n: 0 };
    const fetchSpy = stubFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      const own = body.client_id === server.by && body.updated_at === server.prev;
      if (body.updated_at !== server.updatedAt && !own) return json({ detail: 'changed' }, 409);
      server.n += 1;
      Object.assign(server, { prev: body.updated_at, by: body.client_id, title: body.title });
      server.updatedAt = `2026-11-09T10:00:0${server.n}Z`;
      return json({ ...story(), updated_at: server.updatedAt });
    });
    fetchSpy.mockImplementationOnce((_url, init) => {
      const body = JSON.parse(init?.body as string);
      Object.assign(server, { n: 1, prev: body.updated_at, by: body.client_id, title: body.title });
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

describe('the story list', () => {
  const stories = [
    { id: 'a', live: false, title: '', description: '', first_published_at: null },
    { id: 'b', live: true, title: 'Harbour', description: 'd', first_published_at: '2026-11-01T00:00:00Z' },
  ];

  it('shows every story in the API order with its live flag, and filters by live', async () => {
    stubFetch(() => json(stories));
    render(<StoryList />);
    await waitFor(() => expect(screen.getAllByTestId('story-row')).toHaveLength(2));
    expect(screen.getAllByTestId('story-row').map((r) => r.textContent)).toEqual(['Untitled Not live', 'Harbour Live']);
    fireEvent.click(screen.getByTestId('filter-live'));
    expect(screen.getAllByTestId('story-row').map((r) => r.textContent)).toEqual(['Harbour Live']);
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
