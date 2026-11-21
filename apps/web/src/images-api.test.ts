import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getImage, resolveUrl, uploadImage, UploadRefusedError } from './images-api';

beforeEach(() => vi.stubEnv('VITE_API_URL', '/api'));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const file = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: 'image/jpeg' });

/** A stand-in XMLHttpRequest that records what is sent and reports progress as asked. */
class FakeXhr {
  static instances: FakeXhr[] = [];
  static answer = 204;
  method = '';
  url = '';
  sent: unknown = undefined;
  headers: Record<string, string> = {};
  status = 0;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.sent = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 4 });
    this.status = FakeXhr.answer;
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  FakeXhr.instances = [];
  FakeXhr.answer = 204;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

const TARGET = { upload_url: '/images/uploads/tok', original_url: 'local:orig-tok', method: 'PUT', max_bytes: 100 };
const INFO = { id: 'img-1', status: 'processing', web_versions: [], width: null, height: null, byte_size: 10 };

describe('uploadImage', () => {
  it('asks for a target, sends the file there with progress, then registers the stored URL', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve(url.endsWith('/upload-target') ? json(TARGET) : json(INFO, 201));
    });
    const f = file('a.jpg', 4);
    const progress: number[] = [];
    const info = await uploadImage(f, (p) => progress.push(p));

    expect(info.id).toBe('img-1');
    expect(calls.map(([u, i]) => `${i?.method} ${u}`)).toEqual(['POST /api/images/upload-target', 'POST /api/images']);
    expect(JSON.parse(calls[0]?.[1]?.body as string)).toEqual({ size: 4 });
    // The file went to the target by PUT, not to the API's register call.
    expect(FakeXhr.instances).toHaveLength(1);
    expect(FakeXhr.instances[0]).toMatchObject({ method: 'PUT', url: '/api/images/uploads/tok', sent: f });
    expect(progress).toEqual([25, 100]);
    // The register call carries the URL, never the bytes.
    expect(JSON.parse(calls[1]?.[1]?.body as string)).toEqual({ original_url: 'local:orig-tok' });
  });

  it('sends a Blob target the headers it names, straight to its absolute URL, and registers only the stored URL', async () => {
    const blob = {
      upload_url: 'https://vercel.com/api/blob/?pathname=originals/tok',
      original_url: 'https://store.public.blob.vercel-storage.com/originals/tok',
      method: 'PUT',
      headers: { authorization: 'Bearer client-token', 'x-vercel-blob-access': 'public' },
      max_bytes: 100,
    };
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve(url.endsWith('/upload-target') ? json(blob) : json(INFO, 201));
    });
    await uploadImage(file('a.jpg', 4), () => {});
    expect(FakeXhr.instances[0]).toMatchObject({
      method: 'PUT',
      url: blob.upload_url,
      headers: { ...blob.headers, 'x-content-type': 'image/jpeg' },
    });
    // The API receives the stored URL and nothing else (no token, no bytes).
    expect(JSON.parse(calls[1]?.[1]?.body as string)).toEqual({ original_url: blob.original_url });
  });

  it('refuses a file over the limit before sending a single byte, naming the limit', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(json({ detail: { message: 'too big', limit: 25 * 1024 * 1024 } }, 413)),
    );
    const big = file('huge.jpg', 30 * 1024 * 1024);
    const error = await uploadImage(big, () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadRefusedError);
    expect((error as Error).message).toBe('huge.jpg is 30 MB; the limit is 25 MB per photo.');
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('reports a failed upload and does not register', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(json(TARGET)));
    vi.stubGlobal('fetch', fetchSpy);
    FakeXhr.answer = 500;
    await expect(uploadImage(file('a.jpg'), () => {})).rejects.toThrow('the upload failed (500)');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the target request only
  });

  it('says so when uploads are not configured on the server', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json({ detail: 'x' }, 503)));
    await expect(uploadImage(file('a.jpg'), () => {})).rejects.toThrow('not set up');
  });
});

describe('getImage and resolveUrl', () => {
  it('distinguishes no such image (404) from an answer that cannot be used', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json({}, 404)));
    expect(await getImage('x')).toEqual({ status: 'missing' });
    vi.stubGlobal('fetch', () => Promise.resolve(json({}, 500)));
    expect(await getImage('x')).toBeNull();
    vi.stubGlobal('fetch', () => Promise.resolve(json({ status: 'weird' })));
    expect(await getImage('x')).toBeNull();
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    expect(await getImage('x')).toBeNull();
  });

  it('puts local paths on the API and leaves absolute URLs alone', () => {
    expect(resolveUrl('/public/images/a-480.jpg')).toBe('/api/public/images/a-480.jpg');
    expect(resolveUrl('https://blob.example/a.jpg')).toBe('https://blob.example/a.jpg');
  });
});
