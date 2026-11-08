// The deployed web app reports the commit it was built from at /version.json,
// the deploy.commitEndpoint smoke's freshness gate reads. A static bundle has
// no /health, so the build writes the file; Vercel sets VERCEL_GIT_COMMIT_SHA
// at build time. Absent locally, where null is right.

/** The JSON body of /version.json for a build run with `env`. */
export function commitJson(env) {
  return JSON.stringify({ commit: env.VERCEL_GIT_COMMIT_SHA || null });
}

/** A Vite plugin emitting version.json into the bundle. */
export function commitFile(env = process.env) {
  return {
    name: 'commit-file',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: commitJson(env) });
    },
  };
}
