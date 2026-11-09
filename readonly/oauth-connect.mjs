import { randomBytes, timingSafeEqual } from 'node:crypto';
import { READ_SCOPES, validateConfig, validateScopes } from './core.mjs';

const BASE = 'https://api.ebay.com/oauth/api_scope';
const USER_SCOPES = READ_SCOPES.filter((scope) => !scope.endsWith('/commerce.feedback.readonly'));
export const DEFAULT_CONNECT_SCOPES = Object.freeze(
  USER_SCOPES.filter((scope) => !scope.endsWith('/sell.finances.earnings.read')),
);
export const DEFAULT_REDIRECT_URLS = Object.freeze({
  production:
    'https://signin.ebay.com/ws/eBayISAPI.dll?ThirdPartyAuthSucessFailure&isAuthSuccessful=true',
  // eBay's documented Sandbox example uses the same hosted success page.
  sandbox:
    'https://signin.ebay.com/ws/eBayISAPI.dll?ThirdPartyAuthSucessFailure&isAuthSuccessful=true',
});
const RESERVED = new Set(['code', 'state', 'expires_in', 'error', 'error_description']);
const MAX_RESPONSE_BYTES = 64 * 1024;
const SESSION_MS = 10 * 60 * 1000;
export class OAuthConnectError extends Error {}
const fail = (message) => {
  throw new OAuthConnectError(message);
};
function credential(value, label) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 20000 ||
    /\s|[\x00-\x1f\x7f]/u.test(value)
  )
    fail(`Invalid ${label}. Enter it only in the local setup prompt.`);
  return value;
}
function validateRedirect(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('The registered callback must be a complete HTTPS URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    /^(localhost|127\.|\[::1\])/.test(url.hostname) ||
    url.hostname.endsWith('.localhost')
  )
    fail(
      'Use the registered HTTPS callback, without credentials, fragments, nonstandard ports or localhost.',
    );
  if (
    [...url.searchParams.keys()].some(
      (key) => RESERVED.has(key) || url.searchParams.getAll(key).length !== 1,
    )
  )
    fail(
      'The registered callback cannot contain OAuth response parameters or duplicate query fields.',
    );
  return url;
}
function parseCallback(value, expected, state) {
  if (typeof value !== 'string' || value.length > 30000)
    fail('Paste the complete callback URL into the hidden local prompt.');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    fail('The callback is not a complete URL.');
  }
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.username ||
    url.password ||
    url.hash
  )
    fail(
      'The callback does not match this session’s registered HTTPS destination. Start again if the app uses a different callback.',
    );
  const names = [...url.searchParams.keys()];
  const allowed = new Set([...expected.searchParams.keys(), ...RESERVED]);
  if (names.some((key) => !allowed.has(key) || url.searchParams.getAll(key).length !== 1))
    fail('The callback contains duplicate or unsupported response fields.');
  const received = url.searchParams.get('state');
  if (
    typeof received !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(received) ||
    !timingSafeEqual(Buffer.from(received), Buffer.from(state))
  )
    fail('The sign-in state does not match this session. Do not use this response.');
  if (url.searchParams.has('error') || url.searchParams.get('isAuthSuccessful') === 'false')
    return null;
  for (const [key, value] of expected.searchParams)
    if (url.searchParams.get(key) !== value)
      fail('The callback does not match the registered destination query.');
  if (url.searchParams.has('error_description')) return null;
  const code = url.searchParams.get('code');
  credential(code, 'authorization code');
  if (url.searchParams.has('expires_in')) {
    const lifetime = Number(url.searchParams.get('expires_in'));
    if (!Number.isSafeInteger(lifetime) || lifetime <= 0)
      fail(
        'The authorization response has expired or contains an invalid lifetime. Start a fresh sign-in.',
      );
  }
  return code; // URLSearchParams decodes once. Never decode it a second time.
}
async function readTokenResponse(response) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    fail(
      `eBay could not exchange this code (${response.status}). Start a fresh sign-in; do not reuse this response.`,
    );
  }
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    fail('The eBay token response was unexpectedly large. No credentials were saved.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES)
      fail('The eBay token response was unexpectedly large. No credentials were saved.');
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('eBay returned an invalid token response. No credentials were saved.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('eBay returned an invalid token response.');
  return value;
}
function expiry(seconds, now, label) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 315360000)
    fail(`The eBay response has an invalid ${label} lifetime. No credentials were saved.`);
  return new Date(now + seconds * 1000).toISOString();
}

/**
 * Local-only authorization-code flow. Creating a session makes no network request.
 * Initial consent/exchange is deliberately not exposed as an MCP tool.
 * The returned exchange function is single-use, including after uncertain failures.
 */
export function createOAuthSession(
  input,
  { fetchImpl = globalThis.fetch, now = Date.now, randomBytesImpl = randomBytes } = {},
) {
  const allowed = ['environment', 'clientId', 'clientSecret', 'ruName', 'redirectUrl', 'scopes'];
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    fail('Unsupported OAuth setup configuration.');
  if (!['production', 'sandbox'].includes(input.environment))
    fail('Choose production or sandbox; they have separate app credentials and RuNames.');
  const environment = input.environment;
  const clientId = credential(input.clientId, 'client ID');
  const clientSecret = credential(input.clientSecret, 'client secret');
  if (typeof input.ruName !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(input.ruName))
    fail('Enter the app’s OAuth RuName, not a redirect URL.');
  const ruName = input.ruName;
  const redirect = validateRedirect(input.redirectUrl ?? DEFAULT_REDIRECT_URLS[environment]);
  let scopes;
  try {
    scopes = validateScopes(input.scopes ?? DEFAULT_CONNECT_SCOPES);
  } catch {
    fail(
      'Choose only the documented user-token read scopes. Management scopes are never requested by this helper.',
    );
  }
  if (scopes.some((scope) => !USER_SCOPES.includes(scope)))
    fail(
      'That scope is not supported in a user consent flow. Public Feedback uses a separate application token.',
    );
  const bytes = randomBytesImpl(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32)
    fail('Could not create a secure sign-in state.');
  const state = bytes.toString('base64url');
  const issued = now();
  if (!Number.isSafeInteger(issued)) fail('Invalid local clock.');
  const expiresAt = issued + SESSION_MS;
  let consumed = false;
  let cancelled = false;
  let controller;
  const host = environment === 'production' ? 'auth.ebay.com' : 'auth.sandbox.ebay.com';
  const tokenHost = environment === 'production' ? 'api.ebay.com' : 'api.sandbox.ebay.com';
  const authorization = new URL(`https://${host}/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    client_id: clientId,
    redirect_uri: ruName,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
  }))
    authorization.searchParams.set(key, value);
  return Object.freeze({
    authorizationUrl: authorization.href,
    scopes: Object.freeze([...scopes]),
    expiresAt,
    cancel() {
      cancelled = true;
      consumed = true;
      controller?.abort();
    },
    async exchangeCallback(callbackUrl) {
      if (consumed)
        fail('This sign-in session has already been used or cancelled. Start a new one.');
      if (now() < issued || now() >= expiresAt) {
        consumed = true;
        fail('This local sign-in session expired. Start again.');
      }
      const code = parseCallback(callbackUrl, redirect, state);
      consumed = true; // Set before the request so concurrent calls/retries cannot replay the code.
      if (code === null) fail('eBay sign-in was cancelled or denied. No code was exchanged.');
      controller = new AbortController();
      const ensureActive = () => {
        if (cancelled) fail('This sign-in session was cancelled. No credentials were saved.');
      };
      try {
        const response = await fetchImpl(`https://${tokenHost}/identity/v1/oauth2/token`, {
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
          headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: ruName,
          }).toString(),
        });
        ensureActive();
        const data = await readTokenResponse(response);
        ensureActive();
        credential(data.access_token, 'returned access token');
        const refreshToken = credential(data.refresh_token, 'returned refresh token');
        if (refreshToken === 'N/A')
          fail('eBay did not return a usable refresh token. No credentials were saved.');
        if (
          typeof data.token_type !== 'string' ||
          !['user access token', 'bearer'].includes(data.token_type.toLowerCase())
        )
          fail('eBay returned an unexpected token type. No credentials were saved.');
        const current = now();
        const accessTokenExpiresAt = expiry(data.expires_in, current, 'access token');
        const refreshTokenExpiresAt = expiry(
          data.refresh_token_expires_in,
          current,
          'refresh token',
        );
        let granted = scopes;
        if (data.scope !== undefined) {
          if (typeof data.scope !== 'string' || !data.scope.trim())
            fail('eBay returned invalid granted scopes. No credentials were saved.');
          try {
            granted = validateScopes(data.scope.trim().split(/\s+/));
          } catch {
            fail(
              'eBay returned unexpected management or unknown scopes. Nothing was saved; review and revoke the grant in eBay account settings.',
            );
          }
          if (granted.some((scope) => !scopes.includes(scope)))
            fail(
              'eBay returned scopes outside the requested consent. Nothing was saved; review and revoke the grant in eBay account settings.',
            );
        }
        const config = validateConfig({
          environment,
          clientId,
          clientSecret,
          refreshToken,
          refreshTokenExpiresAt,
          scopes: [...granted],
          marketplaceId: 'EBAY_US',
          contentLanguage: 'en-US',
        });
        return Object.freeze({
          config,
          accessTokenExpiresAt,
          refreshTokenExpiresAt,
          scopeSource:
            data.scope === undefined
              ? 'requested scopes (eBay did not echo them)'
              : 'eBay token response',
        });
      } catch (error) {
        ensureActive();
        if (error instanceof OAuthConnectError) throw error;
        // Network/parser errors can contain input/response data. Never expose their messages.
        fail(
          'The code exchange could not be verified. No credentials were saved. Start a fresh sign-in rather than replaying the code.',
        );
      }
    },
  });
}
