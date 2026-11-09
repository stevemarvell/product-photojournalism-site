import { useEffect, useState, type ReactNode } from 'react';

import { ApiNotConfiguredError } from './api';
import { resolveUrl } from './images-api';
import { fetchPiece, fetchPieces, PublicApiError, type Piece, type PieceSummary, type PublicPhoto } from './public-api';
import { parseBody, type Block } from './render';

/** The public page URL is `/<uuid>` (spec section 8). */
const PIECE_PATH = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** Which public page a path is: home, one piece, or nothing the site has. */
export function routeOf(path: string): { page: 'home' } | { page: 'piece'; id: string } | { page: 'not-found' } {
  if (path === '/' || path === '') return { page: 'home' };
  const m = PIECE_PATH.exec(path);
  return m?.[1] ? { page: 'piece', id: m[1].toLowerCase() } : { page: 'not-found' };
}

/** The document's title and description, for the lifetime of the page that set them. */
function useDocumentMeta(title: string, description?: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    let meta: HTMLMetaElement | null = null;
    if (description) {
      meta = document.createElement('meta');
      meta.name = 'description';
      meta.content = description;
      document.head.appendChild(meta);
    }
    return () => {
      document.title = previous;
      meta?.remove();
    };
  }, [title, description]);
}

const UTC_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** A date as a reader writes it; `iso` is a date or a timestamp, read in UTC so it never slips a day. */
function formatDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? '' : UTC_DATE.format(d);
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="public" data-testid="public">
      <header className="public-masthead">
        <a href="/">{__APP_NAME__}</a>
      </header>
      <main className="public-column">{children}</main>
    </div>
  );
}

function srcSet(photo: PublicPhoto): { src: string; srcSet: string } | null {
  const versions = [...photo.versions].sort((a, b) => a.width - b.width);
  const largest = versions[versions.length - 1];
  if (!largest) return null;
  return {
    src: resolveUrl(largest.url),
    srcSet: versions.map((v) => `${resolveUrl(v.url)} ${v.width}w`).join(', '),
  };
}

function Photo({ photo, alt, caption, credit, first }: { photo: PublicPhoto; alt: string; caption: string; credit: string; first: boolean }) {
  const sources = srcSet(photo);
  if (!sources) return null;
  return (
    <figure className="public-photo" data-testid="photo">
      <img
        {...sources}
        sizes="100vw"
        alt={alt}
        width={photo.width || undefined}
        height={photo.height || undefined}
        loading={first ? 'eager' : 'lazy'}
      />
      {caption && <figcaption>{caption}</figcaption>}
      {credit && <small className="public-credit">{credit}</small>}
    </figure>
  );
}

function Body({ blocks, photos }: { blocks: Block[]; photos: Record<string, PublicPhoto> }) {
  let seen = 0;
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === 'paragraph') {
          return (
            <p key={i}>
              {block.inlines.map((run, j) => {
                // Text nodes only: React prints a string as text, whatever characters it holds.
                let node: ReactNode = run.text;
                if (run.italic) node = <em>{node}</em>;
                if (run.bold) node = <strong>{node}</strong>;
                return <span key={j}>{node}</span>;
              })}
            </p>
          );
        }
        if (!Object.hasOwn(photos, block.photo.image)) return null;
        const resolved = photos[block.photo.image];
        if (!resolved) return null;
        return <Photo key={i} photo={resolved} alt={block.photo.alt} caption={block.photo.caption} credit={block.photo.credit} first={seen++ === 0} />;
      })}
    </>
  );
}

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'missing' } | { state: 'error'; status: number | null };

function failure(e: unknown): Load<never> {
  if (e instanceof PublicApiError) return { state: 'error', status: e.status };
  return { state: 'error', status: e instanceof ApiNotConfiguredError ? 0 : null };
}

export function Home() {
  const [pieces, setPieces] = useState<Load<PieceSummary[]>>({ state: 'loading' });
  useDocumentMeta(__APP_NAME__);

  useEffect(() => {
    let live = true;
    fetchPieces()
      .then((value) => live && setPieces({ state: 'ready', value }))
      .catch((e: unknown) => live && setPieces(failure(e)));
    return () => {
      live = false;
    };
  }, []);

  const refused = new URLSearchParams(window.location.search).get('signin') === 'refused';

  return (
    <Page>
      {refused && (
        <p data-testid="signin-refused" role="alert">
          Sign-in was refused.
        </p>
      )}
      {pieces.state === 'loading' && <p data-testid="loading">Loading…</p>}
      {pieces.state === 'error' && pieces.status === 501 && <p data-testid="empty">No application here yet.</p>}
      {pieces.state === 'error' && pieces.status !== 501 && <ErrorNote what="The pieces" />}
      {pieces.state === 'ready' && pieces.value.length === 0 && <p data-testid="empty">Nothing has been published yet.</p>}
      {pieces.state === 'ready' && pieces.value.length > 0 && (
        <ul className="public-list" data-testid="piece-list">
          {pieces.value.map((p) => (
            <li key={p.id}>
              <a href={`/${p.id}`} data-testid="piece-link">
                {p.hero && <HeroImage hero={p.hero} />}
                <h2>{p.title}</h2>
              </a>
              <p>{p.description}</p>
              <time dateTime={p.first_published_at}>{formatDate(p.first_published_at)}</time>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function HeroImage({ hero }: { hero: NonNullable<PieceSummary['hero']> }) {
  const sources = srcSet(hero);
  if (!sources) return null;
  return <img {...sources} sizes="(min-width: 40rem) 40rem, 100vw" alt={hero.alt} width={hero.width || undefined} height={hero.height || undefined} />;
}

/** A plain failure to load. Only the home page treats 501 (storage not built yet) specially. */
function ErrorNote({ what }: { what: string }) {
  return (
    <p data-testid="load-error" role="alert">
      {what} could not be loaded.
    </p>
  );
}

export function NotFound() {
  useDocumentMeta('Page not found');
  return (
    <Page>
      <h1 data-testid="not-found">Page not found</h1>
      <p>There is nothing at this address.</p>
      <p>
        <a href="/">Back to the front page</a>
      </p>
    </Page>
  );
}

export function PiecePage({ id }: { id: string }) {
  const [piece, setPiece] = useState<Load<Piece>>({ state: 'loading' });

  useEffect(() => {
    let live = true;
    fetchPiece(id)
      .then((value) => live && setPiece(value ? { state: 'ready', value } : { state: 'missing' }))
      .catch((e: unknown) => live && setPiece(failure(e)));
    return () => {
      live = false;
    };
  }, [id]);

  const loaded = piece.state === 'ready' ? piece.value : null;
  useDocumentMeta(loaded ? loaded.title : piece.state === 'missing' ? 'Page not found' : __APP_NAME__, loaded?.description);

  if (piece.state === 'missing') return <NotFound />;
  if (!loaded) {
    return (
      <Page>
        {piece.state === 'loading' && <p data-testid="loading">Loading…</p>}
        {piece.state === 'error' && (
          <p data-testid="load-error" role="alert">
            This page can&rsquo;t be shown right now.
          </p>
        )}
      </Page>
    );
  }
  const line = [loaded.date ? formatDate(loaded.date) : '', loaded.location].filter(Boolean).join(' · ');
  return (
    <Page>
      <article data-testid="piece">
        <h1>{loaded.title}</h1>
        {line && <p className="public-line">{line}</p>}
        <Body blocks={parseBody(loaded.content)} photos={loaded.photos} />
      </article>
    </Page>
  );
}

/** The public site: the home page, one page per piece, and a not-found page. */
export function PublicSite({ path }: { path: string }) {
  const route = routeOf(path);
  if (route.page === 'home') return <Home />;
  if (route.page === 'piece') return <PiecePage id={route.id} />;
  return <NotFound />;
}
