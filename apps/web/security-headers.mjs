// The security headers every web page carries. One constant: vercel.json sends
// it in production, vite.config.ts sends it from `vite preview` so the e2e suite
// runs under the same policy, and src/vercel-config.test.ts asserts the two agree.

const BLOB = 'https://*.public.blob.vercel-storage.com';
// Where the browser PUTs an original (the upload target's upload_url, see api adapters/blob.py).
const BLOB_UPLOAD = 'https://vercel.com/api/blob/';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Ionic injects styles at run time; styles only, never scripts.
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${BLOB}`,
  "font-src 'self' data:",
  `connect-src 'self' ${BLOB} ${BLOB_UPLOAD}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// `vite preview` only, for the e2e suite: its bundle is built against this
// unreachable fake API origin (playwright.config.ts), which the policy would
// otherwise block. Production reaches the API same-origin through /api.
export const E2E_API_ORIGIN = 'http://api.e2e.invalid';

export function previewHeaders() {
  return {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': CONTENT_SECURITY_POLICY.replace(
      /(img-src|connect-src) /g,
      `$1 ${E2E_API_ORIGIN} `,
    ),
  };
}
