#!/usr/bin/env node
// SessionStart hook: install both toolchains in cloud sessions only.
//
// Cloud environments clone the repository after the environment's setup
// script has already run, so a setup script cannot reach scripts/bootstrap.mjs
// yet — https://code.claude.com/docs/en/cloud-environments documents the fix
// as a SessionStart hook instead, gated on CLAUDE_CODE_REMOTE so it is a
// no-op locally. It runs on every cloud session, including resumed ones, so
// it is not the place for anything slow that a setup script's environment
// cache would otherwise skip.
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function main() {
  if (process.env['CLAUDE_CODE_REMOTE'] !== 'true') return 0;

  execSync('npm run bootstrap', { cwd: ROOT, stdio: 'inherit' });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
