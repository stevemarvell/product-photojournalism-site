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

/** The page chrome: the masthead (with the tagline on the home page only) and the content. */
function Page({ children, home = false }: { children: ReactNode; home?: boolean }) {
  return (
    <div className={home ? 'public public-home' : 'public'} data-testid="public">
      <header className="public-masthead">
        <div className="public-masthead-inner">
          <a href="/" className="public-name">
            {__APP_NAME__}
          </a>
          {home && <span className="public-tagline">Photojournalism</span>}
        </div>
      </header>
      <main className="public-main">{children}</main>
    </div>
  );
}

/** "Location · date": the piece's own date when set, else when it was first published; either part may be absent,
 * and nothing is rendered when both are. The date is a machine-readable `<time>`. */
function PlaceLine({ piece }: { piece: { location: string; date: string | null; first_published_at: string } }) {
  const iso = piece.date || piece.first_published_at;
  const when = formatDate(iso);
  if (!piece.location && !when) return null;
  return (
    <span className="public-line">
      {piece.location}
      {piece.location && when && ' \u00b7 '}
      {when && <time dateTime={iso}>{when}</time>}
    </span>
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
      {(caption || credit) && (
        <figcaption>
          <span>{caption}</span>
          {credit && <small className="public-credit">{credit}</small>}
        </figcaption>
      )}
    </figure>
  );
}

function Body({ blocks, photos }: { blocks: Block[]; photos: Record<string, PublicPhoto> }) {
  let seen = 0;
  // Consecutive paragraphs share one reading column; a photo breaks out between columns.
  const out: ReactNode[] = [];
  let run: ReactNode[] = [];
  const flush = (key: number) => {
    if (run.length > 0) out.push(<div className="public-text" key={`t${key}`}>{run}</div>);
    run = [];
  };
  blocks.forEach((block, i) => {
    if (block.kind === 'paragraph') {
      run.push(
        <p key={i}>
          {block.inlines.map((r, j) => {
            // Text nodes only: React prints a string as text, whatever characters it holds.
            let node: ReactNode = r.text;
            if (r.italic) node = <em>{node}</em>;
            if (r.bold) node = <strong>{node}</strong>;
            return <span key={j}>{node}</span>;
          })}
        </p>,
      );
      return;
    }
    if (!Object.hasOwn(photos, block.photo.image)) return;
    const resolved = photos[block.photo.image];
    if (!resolved) return;
    flush(i);
    out.push(<Photo key={i} photo={resolved} alt={block.photo.alt} caption={block.photo.caption} credit={block.photo.credit} first={seen++ === 0} />);
  });
  flush(blocks.length);
  return <>{out}</>;
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

  const [lead, ...more] = pieces.state === 'ready' ? pieces.value : [];

  return (
    <Page home>
      {refused && (
        <p data-testid="signin-refused" role="alert" className="public-note">
          Sign-in was refused.
        </p>
      )}
      {pieces.state === 'loading' && <p data-testid="loading" className="public-note">Loading…</p>}
      {pieces.state === 'error' && pieces.status === 501 && <p data-testid="empty" className="public-note">No application here yet.</p>}
      {pieces.state === 'error' && pieces.status !== 501 && <ErrorNote what="The pieces" />}
      {pieces.state === 'ready' && !lead && <p data-testid="empty" className="public-note">Nothing has been published yet.</p>}
      {lead && (
        <div data-testid="piece-list" className="public-home-body">
          <a href={`/${lead.id}`} data-testid="piece-link" className="public-lead">
            <Hero hero={lead.hero} sizes="(min-width: 60rem) 50vw, 100vw" />
            <div className="public-lead-text">
              <PlaceLine piece={lead} />
              <h2>{lead.title}</h2>
              <p>{lead.description}</p>
            </div>
          </a>
          {more.length > 0 && (
            <section className="public-more" data-testid="more">
              <h2 className="public-more-heading">More</h2>
              <div className="public-grid">
                {more.map((p) => (
                  <a key={p.id} href={`/${p.id}`} data-testid="piece-link" className="public-card">
                    <Hero hero={p.hero} sizes="(min-width: 40rem) 33vw, 100vw" />
                    <PlaceLine piece={p} />
                    <h3>{p.title}</h3>
                    <p>{p.description}</p>
                  </a>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Page>
  );
}

/** The photo slot of a home block: the hero at its own aspect ratio, or a neutral box where there is none. */
function Hero({ hero, sizes }: { hero: PieceSummary['hero']; sizes: string }) {
  const sources = hero ? srcSet(hero) : null;
  if (!hero || !sources) return <div className="public-placeholder" data-testid="placeholder" aria-hidden="true" />;
  return <img {...sources} sizes={sizes} alt={hero.alt} width={hero.width || undefined} height={hero.height || undefined} />;
}

/** A plain failure to load. Only the home page treats 501 (storage not built yet) specially. */
function ErrorNote({ what }: { what: string }) {
  return (
    <p data-testid="load-error" role="alert" className="public-note">
      {what} could not be loaded.
    </p>
  );
}

export function NotFound() {
  useDocumentMeta('Page not found');
  return (
    <Page>
      <div className="public-text public-notfound">
        <h1 data-testid="not-found">Page not found</h1>
        <p>There is nothing at this address.</p>
        <p>
          <a href="/" className="public-back">Back to the front page</a>
        </p>
      </div>
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
        {piece.state === 'loading' && <p data-testid="loading" className="public-note">Loading…</p>}
        {piece.state === 'error' && (
          <p data-testid="load-error" role="alert" className="public-note">
            This page can&rsquo;t be shown right now.
          </p>
        )}
      </Page>
    );
  }
  return (
    <Page>
      <article data-testid="piece" className="public-piece">
        <div className="public-head">
          <PlaceLine piece={loaded} />
          <h1>{loaded.title}</h1>
          {loaded.description && <p className="public-standfirst">{loaded.description}</p>}
        </div>
        <Body blocks={parseBody(loaded.content)} photos={loaded.photos} />
        <div className="public-foot">
          <a href="/" className="public-back">
            ← All pieces
          </a>
        </div>
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
