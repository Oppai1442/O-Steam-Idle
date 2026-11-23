/**
 * Validate Cloudflare Access application JWTs independently of the HTTP Basic
 * Auth challenge. Never trust a claimed email or a CF-Access header without
 * verifying the signature, issuer, audience and expiry first.
 *
 * No user credentials, signed tokens, or cryptographic key material are logged.
 */
export interface AccessSettings {
  teamDomain?: string;
  audience?: string;
  allowedEmail?: string;
}

interface AccessClaims {
  iss?: unknown;
  aud?: unknown;
  email?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
}

interface SigningJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

interface KeyCache {
  expiresAt: number;
  keys: SigningJwk[];
}

const cachedKeys = new Map<string, KeyCache>();
const MAX_JWT_LENGTH = 16_384;
const KEY_CACHE_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

export function normalizeAccessSettings(input: AccessSettings): { issuer: string; audience: string; allowedEmail: string } | null {
  const issuer = String(input.teamDomain || '').trim().replace(/\/$/, '');
  const audience = String(input.audience || '').trim();
  const allowedEmail = String(input.allowedEmail || '').trim().toLowerCase();
  let url: URL;
  try { url = new URL(issuer); } catch { return null; }
  // Prevent accidentally fetching signing keys from an attacker-controlled URL.
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(url.hostname)
    || url.origin !== issuer || url.username || url.password) return null;
  if (!/^[a-z0-9_-]{16,128}$/i.test(audience)) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(allowedEmail) || allowedEmail.length > 254) return null;
  return { issuer, audience, allowedEmail };
}

function decodeUrlBase64(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new Error('Invalid base64url');
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

function parseJsonBase64(input: string): Record<string, unknown> {
  const result: unknown = JSON.parse(new TextDecoder().decode(decodeUrlBase64(input)));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid JSON payload');
  return result as Record<string, unknown>;
}

async function loadKeys(issuer: string, keyId: string, fetcher: typeof fetch): Promise<SigningJwk[]> {
  const existing = cachedKeys.get(issuer);
  if (existing && existing.expiresAt > Date.now() && existing.keys.some(key => key.kid === keyId)) return existing.keys;
  const response = await fetcher(issuer + '/cdn-cgi/access/certs', {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error('Unable to load signing keys');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !Array.isArray((body as {keys?: unknown}).keys)) throw new Error('Invalid keyset');
  const keys = ((body as {keys: unknown[]}).keys)
    .filter((key): key is SigningJwk => !!key && typeof key === 'object')
    .filter(key => key.kty === 'RSA' && key.alg === 'RS256' && key.use === 'sig'
      && typeof key.kid === 'string' && typeof key.n === 'string' && typeof key.e === 'string');
  if (!keys.length) throw new Error('No supported signing keys');
  cachedKeys.set(issuer, { keys, expiresAt: Date.now() + KEY_CACHE_MS });
  return keys;
}

/**
 * Fail closed: both Access and a single configured owner email must validate.
 * The verified JWT is intentionally not forwarded to the Node container.
 */
export async function verifyAccessRequest(
  request: Request,
  settings: AccessSettings,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  const configured = normalizeAccessSettings(settings);
  if (!configured) return false;
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt || jwt.length > MAX_JWT_LENGTH) return false;
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return false;
    const header = parseJsonBase64(parts[0]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 200) return false;
    const claims = parseJsonBase64(parts[1]) as AccessClaims;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== configured.issuer
      || !(claims.aud === configured.audience || Array.isArray(claims.aud) && claims.aud.includes(configured.audience))
      || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp)
      || claims.exp <= now
      || typeof claims.nbf === 'number' && claims.nbf > now + CLOCK_SKEW_SECONDS
      || typeof claims.iat === 'number' && claims.iat > now + CLOCK_SKEW_SECONDS
      || typeof claims.email !== 'string' || claims.email.trim().toLowerCase() !== configured.allowedEmail) return false;

    const keys = await loadKeys(configured.issuer, header.kid, fetcher);
    const key = keys.find(item => item.kid === header.kid);
    if (!key) return false;
    const verifyKey = await crypto.subtle.importKey(
      'jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    const signingInput = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    return crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' }, verifyKey, decodeUrlBase64(parts[2]), signingInput
    );
  } catch {
    return false;
  }
}

export function allowsBrowserMutation(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  if (request.method !== 'POST') return false;
  const origin = request.headers.get('Origin');
  if (origin) {
    try { return new URL(origin).origin === new URL(request.url).origin; }
    catch { return false; }
  }
  // Some same-origin browsers omit Origin. Reject cross-site / missing Fetch
  // Metadata for unsafe actions: no cross-origin forms can mutate the idler.
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  return fetchSite === 'same-origin' || fetchSite === 'none';
}
