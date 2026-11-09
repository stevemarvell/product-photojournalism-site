import { base } from './api';

export type ImageStatus = 'processing' | 'ready' | 'failed';

export interface WebVersion {
  width: number;
  url: string;
}

/** What the owner endpoints say about an image. Never the original's URL: the API does not send it. */
export interface ImageInfo {
  id: string;
  status: ImageStatus;
  web_versions: WebVersion[];
  width: number | null;
  height: number | null;
  byte_size: number;
}

/** What the editor knows of an image: the API's answer, or why there is none yet. */
export type ImageState = ImageInfo | { status: 'loading' } | { status: 'missing' };

interface UploadTarget {
  upload_url: string;
  original_url: string;
  method: string;
  max_bytes: number;
}

/** A file the owner chose that cannot be uploaded; `message` is fit to show as it is. */
export class UploadRefusedError extends Error {}

/** Web version URLs are absolute (Blob) or paths on the API (the local store). */
export function resolveUrl(url: string): string {
  return /^https?:\/\//.test(url) ? url : `${base()}${url}`;
}

const mb = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

async function limitOf(response: Response): Promise<number | null> {
  try {
    const body = (await response.json()) as { detail?: { limit?: unknown } };
    return typeof body.detail?.limit === 'number' ? body.detail.limit : null;
  } catch {
    return null;
  }
}

/** Step 1: ask where to put the file. A file over the limit is refused here, before any byte is sent. */
async function requestTarget(file: File): Promise<UploadTarget> {
  let response: Response;
  try {
    response = await fetch(`${base()}/images/upload-target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: file.size }),
    });
  } catch {
    throw new UploadRefusedError(`${file.name}: could not reach the server.`);
  }
  if (response.status === 413) {
    const limit = await limitOf(response);
    throw new UploadRefusedError(
      `${file.name} is ${mb(file.size)}; the limit is ${limit ? mb(limit) : 'lower'} per photo.`,
    );
  }
  if (response.status === 503) throw new UploadRefusedError('Photo uploads are not set up on this server yet.');
  if (!response.ok) throw new UploadRefusedError(`${file.name}: could not start the upload (${response.status}).`);
  return (await response.json()) as UploadTarget;
}

/** Step 2: send the file to the target, reporting progress (fetch cannot, so XHR). */
function sendFile(target: UploadTarget, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, resolveUrl(target.upload_url));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else if (xhr.status === 413) reject(new UploadRefusedError(`${file.name} is over the size limit.`));
      else reject(new UploadRefusedError(`${file.name}: the upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new UploadRefusedError(`${file.name}: the upload failed.`));
    xhr.send(file);
  });
}

/** Step 3: tell the API the stored URL; it creates the row and starts processing. */
async function register(target: UploadTarget, file: File): Promise<ImageInfo> {
  let response: Response;
  try {
    response = await fetch(`${base()}/images`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ original_url: target.original_url }),
    });
  } catch {
    throw new UploadRefusedError(`${file.name}: could not reach the server.`);
  }
  if (response.status === 413) throw new UploadRefusedError(`${file.name} is over the size limit.`);
  if (!response.ok) throw new UploadRefusedError(`${file.name}: could not register the photo (${response.status}).`);
  return (await response.json()) as ImageInfo;
}

/**
 * One photo, the Blob client-upload shape: ask for a target, send the file straight
 * there, register it. Resolves with the new image row (status processing).
 */
export async function uploadImage(file: File, onProgress: (percent: number) => void): Promise<ImageInfo> {
  const target = await requestTarget(file);
  await sendFile(target, file, onProgress);
  return register(target, file);
}

/** The image's state: 'missing' for a 404 (no such image), null when the answer was not usable (try again). */
export async function getImage(id: string): Promise<ImageInfo | { status: 'missing' } | null> {
  try {
    const response = await fetch(`${base()}/images/${encodeURIComponent(id)}`);
    if (response.status === 404) return { status: 'missing' };
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<ImageInfo>;
    if (body.status !== 'processing' && body.status !== 'ready' && body.status !== 'failed') return null;
    return { web_versions: [], width: null, height: null, byte_size: 0, id, ...body, status: body.status };
  } catch {
    return null;
  }
}
