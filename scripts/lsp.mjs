// The language servers behind the pyright-lsp and typescript-lsp plugins
// enabled in .claude/settings.json.
//
// Those plugins only find a server on PATH -- there is no setting that points
// them at node_modules/.bin -- and a plugin whose binary is missing fails
// silently: an "Executable not found in $PATH" line in /plugin's Errors tab,
// nothing in any build. So bootstrap installs whichever is missing, globally,
// rather than leaving an enabled plugin inert on a fresh machine.
import { execSync } from 'node:child_process';

// Executable the plugin looks for -> npm package(s) that provide it.
export const LANGUAGE_SERVERS = {
  'pyright-langserver': ['pyright'],
  'typescript-language-server': ['typescript-language-server', 'typescript'],
};

/** Whether `command` resolves on PATH, on Windows and POSIX alike. */
export function onPath(command, exec = execSync) {
  const probe = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
  try {
    exec(probe, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The npm packages to install so every language server is on PATH. */
export function missingPackages(isOnPath = onPath) {
  return Object.entries(LANGUAGE_SERVERS)
    .filter(([command]) => !isOnPath(command))
    .flatMap(([, packages]) => packages);
}
