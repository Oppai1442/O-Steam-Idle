import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  verifyAccessRequest, normalizeAccessSettings, allowsBrowserMutation
} from './.compiled/access-auth.js';

const issuer = 'https://owner-test.cloudflareaccess.com';
const audience = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const allowedEmail = 'only-me@example.com';
const settings = { teamDomain: issuer, audience, allowedEmail };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'active-key', alg: 'RS256', use: 'sig' };
let fetches = 0;
const getKeys = async (url) => {
  fetches += 1;
  assert.equal(url, issuer + '/cdn-cgi/access/certs');
  return new Response(JSON.stringify({ keys: [jwk] }), {status: 200});
};
const base64url = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
function token(overrides = {}, header = { alg: 'RS256', typ: 'JWT', kid: jwk.kid }) {
  const now = Math.floor(Date.now()/1000);
  const payload = { iss: issuer, aud: [audience], email: allowedEmail, iat: now, exp: now+900, ...overrides };
  const input = base64url(header) + '.' + base64url(payload);
  return input + '.' + sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
}
function request(jwt, opts = {}) {
  return new Request('https://idle.example.com/api/status', {
    ...opts,
    headers: {...opts.headers, ...(jwt ? {'Cf-Access-Jwt-Assertion':jwt} : {})}
  });
}

test('fails closed with missing/malformed settings, missing JWT', async () => {
  assert.equal(normalizeAccessSettings({teamDomain:'https://evil.example/cdn-cgi/access/certs', audience,allowedEmail}),null);
  assert.deepEqual(normalizeAccessSettings({teamDomain:issuer,audience,allowedEmail}),{issuer,audience,allowedEmail});
  assert.equal(await verifyAccessRequest(request(token()),{...settings,teamDomain:''},getKeys),false);
  assert.equal(await verifyAccessRequest(request(token()),{...settings,audience:''},getKeys),false);
});
test('accepts a correctly signed Cloudflare Access assertion for exact owner', async () => {
  assert.equal(await verifyAccessRequest(request(token()),settings,getKeys),true);
  assert.ok(fetches >= 1);
});
test('rejects missing, wrong identity, audience, issuer, expiry and altered signatures', async () => {
  assert.equal(await verifyAccessRequest(request(null),settings,getKeys),false);
  assert.equal(await verifyAccessRequest(request(token({email:'anyone@example.com'})),settings,getKeys),false);
  assert.equal(await verifyAccessRequest(request(token({aud:'incorrect-app'})),settings,getKeys),false);
  assert.equal(await verifyAccessRequest(request(token({iss:'https://wrong.cloudflareaccess.com'})),settings,getKeys),false);
  assert.equal(await verifyAccessRequest(request(token({exp:Math.floor(Date.now()/1000)-1})),settings,getKeys),false);
  assert.equal(await verifyAccessRequest(request(token({nbf:Math.floor(Date.now()/1000)+600})),settings,getKeys),false);
  assert.equal(await verifyAccessRequest(request(token({iat:Math.floor(Date.now()/1000)+600})),settings,getKeys),false);
  const good = token();
  assert.equal(await verifyAccessRequest(request(good.slice(0,-5)+'aaaaa'),settings,getKeys),false);
  assert.equal(await verifyAccessRequest(request(token({}, {alg:'none',kid:jwk.kid})),settings,getKeys),false);
  assert.equal(await verifyAccessRequest(request(token()),{...settings,allowedEmail:'other@example.com'},getKeys),false);
  assert.equal(await verifyAccessRequest(request(token()),{...settings,audience:'f'.repeat(64)},getKeys),false);
});
test('CSRF guard allows only same-origin mutations and safe reads', () => {
  assert.equal(allowsBrowserMutation(request(null,{method:'GET'})),true);
  assert.equal(allowsBrowserMutation(request(null,{method:'POST',headers:{Origin:'https://idle.example.com'}})),true);
  assert.equal(allowsBrowserMutation(request(null,{method:'POST',headers:{Origin:'https://evil.example'}})),false);
  assert.equal(allowsBrowserMutation(request(null,{method:'POST',headers:{'Sec-Fetch-Site':'cross-site'}})),false);
  assert.equal(allowsBrowserMutation(request(null,{method:'POST',headers:{'Sec-Fetch-Site':'same-origin'}})),true);
  assert.equal(allowsBrowserMutation(request(null,{method:'POST'})),false);
  assert.equal(allowsBrowserMutation(request(null,{method:'DELETE'})),false);
});
