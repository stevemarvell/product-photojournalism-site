// Derive e2e ports from the worktree so parallel checkouts do not collide.
//
// The caller names the servers it needs (the AI layer does not know which
// apps there are); each gets its own 400-port band, 8200 + 400 × its
// position, plus one per-worktree offset. So ports(['api', 'web']) is
// api 8200–8399 and web 8600–8999 — the values this returned before it took
// names — leaving 8400–8599 for a caller that offsets past the first band.
// An explicit E2E_<NAME>_PORT always wins.
//
// The offset comes from this file's own location, not process.cwd(): Playwright
// resolves its config with cwd = apps/web, which is the same string in every
// worktree, so a cwd-based hash gave every checkout identical ports.
import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKTREE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const BASE_PORT = 8200;
export const BAND = 400;

/** 0-199: small enough that a caller can offset 200 past a band and stay in it. */
export function portOffset(root = WORKTREE_ROOT) {
  return parseInt(createHash('sha1').update(basename(root)).digest('hex').slice(0, 8), 16) % 200;
}

/** { name: port } for each name, in its own band, offset for this worktree. */
export function ports(names, root = WORKTREE_ROOT) {
  if (!Array.isArray(names) || names.length === 0) throw new Error('ports() needs the names of the servers to place');
  const offset = portOffset(root);
  return Object.fromEntries(
    names.map((name, index) => {
      const override = Number(process.env[`E2E_${name.toUpperCase()}_PORT`]);
      return [name, override || BASE_PORT + BAND * index + offset];
    }),
  );
}
