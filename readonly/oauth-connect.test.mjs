import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOAuthSession,
  DEFAULT_CONNECT_SCOPES,
  DEFAULT_REDIRECT_URLS,
  OAuthConnectError,
} from './oauth-connect.mjs';
const APP = {
  environment: 'sandbox',
  clientId: 'sample-app-id',
  clientSecret: 'sample-app-secret',
  ruName: 'Sample-App-RuName',
};
const TOKENS = {
  access_token: 'mock-user-access',
  refresh_token: 'mock-user-refresh',
  token_type: 'User Access Token',
  expires_in: 7200,
  refresh_token_expires_in: 47304000,
};
function callback(session, { code = 'v^1.1#test%encoded', ...extra } = {}) {
  const url = new URL(DEFAULT_REDIRECT_URLS[APP.environment]);
  url.searchParams.set('state', new URL(session.authorizationUrl).searchParams.get('state'));
  url.searchParams.set('code', code);
  url.searchParams.set('expires_in', '299');
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return url;
}
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fixture(input = APP, extra = {}) {
  const calls = [];
  let tick = Date.now();
  const session = createOAuthSession(
    { ...input },
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return json(TOKENS);
      },
      now: () => tick,
      ...extra,
    },
  );
  return {
    session,
    calls,
    advance: (ms) => {
      tick += ms;
    },
  };
}

test('creating consent session is offline, secure and uses RuName not callback URL', () => {
  const { session, calls } = fixture();
  const url = new URL(session.authorizationUrl);
  assert.equal(calls.length, 0);
  assert.equal(url.origin, 'https://auth.sandbox.ebay.com');
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), APP.ruName);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert(!url.href.includes(APP.clientSecret));
  assert.deepEqual(url.searchParams.get('scope').split(' '), DEFAULT_CONNECT_SCOPES);
  assert.throws(() => session.scopes.push('write'));
});
test('states are fresh for each session', () => {
  assert.notEqual(
    new URL(fixture().session.authorizationUrl).searchParams.get('state'),
    new URL(fixture().session.authorizationUrl).searchParams.get('state'),
  );
});
test('valid callback exchanged once with exact eBay destination and form encoding', async () => {
  const { session, calls } = fixture();
  const result = await session.exchangeCallback(callback(session).href);
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, 'https://api.sandbox.ebay.com/identity/v1/oauth2/token');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
  const form = new URLSearchParams(options.body);
  assert.equal(form.get('code'), 'v^1.1#test%encoded');
  assert.equal(form.get('redirect_uri'), APP.ruName);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.size, 3);
  assert.equal(
    options.headers.Authorization,
    `Basic ${Buffer.from(APP.clientId + ':' + APP.clientSecret).toString('base64')}`,
  );
  assert.equal(result.config.refreshToken, TOKENS.refresh_token);
  assert.equal(result.config.userAccessToken, undefined);
  assert.equal(result.config.environment, 'sandbox');
  assert.equal(result.config.refreshTokenExpiresAt, result.refreshTokenExpiresAt);
  assert.deepEqual(result.config.scopes, DEFAULT_CONNECT_SCOPES);
  await assert.rejects(() => session.exchangeCallback(callback(session).href), /already been used/);
  assert.equal(calls.length, 1);
});
test('production grant and credentials are bound before mutable caller input changes', async () => {
  const input = { ...APP, environment: 'production' };
  const calls = [];
  const session = createOAuthSession(input, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return json(TOKENS);
    },
  });
  input.environment = 'sandbox';
  input.clientSecret = 'different';
  const url = callback(session);
  const result = await session.exchangeCallback(url.href);
  assert.equal(calls[0].url, 'https://api.ebay.com/identity/v1/oauth2/token');
  assert.equal(result.config.environment, 'production');
  assert.equal(result.config.clientSecret, APP.clientSecret);
});
for (const modification of [
  (url) => {
    url.hostname = 'attacker.example';
  },
  (url) => {
    url.protocol = 'http:';
  },
  (url) => {
    url.pathname = '/different';
  },
  (url) => {
    url.username = 'attacker';
  },
  (url) => {
    url.hash = '#secret';
  },
  (url) => {
    url.searchParams.delete('state');
  },
  (url) => {
    url.searchParams.set('state', 'A'.repeat(43));
  },
  (url) => {
    url.searchParams.set('state', 'é'.repeat(43));
  },
  (url) => {
    url.searchParams.delete('code');
  },
  (url) => {
    url.searchParams.append('code', 'duplicate');
  },
  (url) => {
    url.searchParams.append('state', 'duplicate');
  },
  (url) => {
    url.searchParams.set('expires_in', '0');
  },
  (url) => {
    url.searchParams.set('unexpected', 'field');
  },
  (url) => {
    url.searchParams.delete('isAuthSuccessful');
  },
])
  test('invalid callback is rejected locally: ' + modification.toString(), async () => {
    const { session, calls } = fixture();
    const url = callback(session);
    modification(url);
    await assert.rejects(() => session.exchangeCallback(url.href), OAuthConnectError);
    assert.equal(calls.length, 0);
  });
test('denied consent is a safe local error, never reflected description or token exchange', async () => {
  const { session, calls } = fixture();
  const url = callback(session);
  url.searchParams.delete('code');
  url.searchParams.set('error', 'access_denied');
  url.searchParams.set('error_description', 'secret malicious text');
  await assert.rejects(
    () => session.exchangeCallback(url.href),
    (error) =>
      /cancelled or denied/.test(error.message) && !error.message.includes('secret malicious'),
  );
  assert.equal(calls.length, 0);
});
test('expired and cancelled sessions do not exchange', async () => {
  const expired = fixture();
  expired.advance(600001);
  await assert.rejects(
    () => expired.session.exchangeCallback(callback(expired.session).href),
    /expired/,
  );
  assert.equal(expired.calls.length, 0);
  const cancelled = fixture();
  cancelled.session.cancel();
  await assert.rejects(
    () => cancelled.session.exchangeCallback(callback(cancelled.session).href),
    /cancelled/,
  );
  assert.equal(cancelled.calls.length, 0);
});
test('parallel/replayed callbacks can cause only one network request', async () => {
  const { session, calls } = fixture();
  const results = await Promise.allSettled([
    session.exchangeCallback(callback(session).href),
    session.exchangeCallback(callback(session).href),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});
test('network errors are sanitized, redirect blocked, uncertain code cannot be retried', async () => {
  const calls = [];
  const session = createOAuthSession(APP, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      throw Error(`${APP.clientSecret} ${TOKENS.access_token}`);
    },
  });
  await assert.rejects(
    () => session.exchangeCallback(callback(session).href),
    (error) =>
      !error.message.includes(APP.clientSecret) && !error.message.includes(TOKENS.access_token),
  );
  await assert.rejects(() => session.exchangeCallback(callback(session).href), /already been used/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'error');
});
test('HTTP error body and malformed token body never escape', async () => {
  for (const response of [
    json({ error_description: 'secret response' }, 400),
    new Response('secret malformed-json', { status: 200 }),
  ]) {
    const session = createOAuthSession(APP, { fetchImpl: async () => response });
    await assert.rejects(
      () => session.exchangeCallback(callback(session).href),
      (error) => !error.message.includes('secret'),
    );
  }
});
for (const change of [
  { refresh_token: undefined },
  { refresh_token: 'N/A' },
  { access_token: '' },
  { access_token: 'bad\nheader' },
  { expires_in: 0 },
  { expires_in: '7200' },
  { refresh_token_expires_in: -1 },
  { token_type: 'Application Access Token' },
  { scope: 'https://api.ebay.com/oauth/api_scope/sell.inventory' },
  { scope: 'https://api.ebay.com/oauth/api_scope/sell.finances.earnings.read' },
  { scope: [] },
])
  test('invalid/wider token response is rejected: ' + JSON.stringify(change), async () => {
    const { session } = fixture(APP, { fetchImpl: async () => json({ ...TOKENS, ...change }) });
    await assert.rejects(() => session.exchangeCallback(callback(session).href), OAuthConnectError);
  });
test('granted subset retained; missing scope disclosed rather than silently claimed verified', async () => {
  const grant = DEFAULT_CONNECT_SCOPES.slice(0, 2).join(' ');
  const { session } = fixture(APP, { fetchImpl: async () => json({ ...TOKENS, scope: grant }) });
  const result = await session.exchangeCallback(callback(session).href);
  assert.deepEqual(result.config.scopes, grant.split(' '));
  assert.equal(result.scopeSource, 'eBay token response');
  const second = fixture();
  assert.match(
    (await second.session.exchangeCallback(callback(second.session).href)).scopeSource,
    /did not echo/,
  );
});
test('unexpectedly large token response is rejected', async () => {
  const { session } = fixture(APP, {
    fetchImpl: async () => new Response('x', { headers: { 'content-length': '999999' } }),
  });
  await assert.rejects(() => session.exchangeCallback(callback(session).href), /large/);
});
test('custom registered HTTPS callback is compared, never fetched', async () => {
  const { session, calls } = fixture({
    ...APP,
    redirectUrl: 'https://owned.example/callback?fixed=yes',
  });
  const url = new URL('https://owned.example/callback?fixed=yes');
  url.searchParams.set('state', new URL(session.authorizationUrl).searchParams.get('state'));
  url.searchParams.set('code', 'example-code');
  await session.exchangeCallback(url.href);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, 'api.sandbox.ebay.com');
});
test('unsafe setup fields, callbacks and management/application-only scopes are refused', () => {
  for (const extra of [
    { environment: 'invalid' },
    { clientSecret: 'bad\nsecret' },
    { ruName: 'https://callback.example' },
    { tokenEndpoint: 'https://evil.example' },
    { redirectUrl: 'http://owned.example/cb' },
    { redirectUrl: 'https://localhost/cb' },
    { redirectUrl: 'https://owned.example/cb#x' },
    { redirectUrl: 'https://owned.example/cb?state=unsafe' },
    { redirectUrl: 'https://owned.example/cb?a=1&a=2' },
    { scopes: ['https://api.ebay.com/oauth/api_scope/sell.inventory'] },
    { scopes: ['https://api.ebay.com/oauth/api_scope/commerce.feedback.readonly'] },
  ])
    assert.throws(() => createOAuthSession({ ...APP, ...extra }), OAuthConnectError);
});

test('state-authenticated denial terminally consumes the session', async () => {
  const { session, calls } = fixture();
  await assert.rejects(
    () => session.exchangeCallback(callback(session, { error: 'access_denied' }).href),
    /cancelled or denied/,
  );
  await assert.rejects(() => session.exchangeCallback(callback(session).href), /already been used/);
  assert.equal(calls.length, 0);
});
test('cancelling during deferred exchange aborts transport and discards returned credentials', async () => {
  let resolve, signal;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const { session } = fixture(APP, {
    fetchImpl: async (_, options) => {
      signal = options.signal;
      return pending;
    },
  });
  const exchange = session.exchangeCallback(callback(session).href);
  assert.equal(signal.aborted, false);
  session.cancel();
  assert.equal(signal.aborted, true);
  resolve(json(TOKENS));
  await assert.rejects(() => exchange, /cancelled/);
});
test('cancelling while response is streamed discards credentials', async () => {
  let streamController;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
  });
  const { session } = fixture(APP, {
    fetchImpl: async () =>
      new Response(stream, { headers: { 'content-type': 'application/json' } }),
  });
  const exchange = session.exchangeCallback(callback(session).href);
  await new Promise((r) => setImmediate(r));
  session.cancel();
  streamController.enqueue(new TextEncoder().encode(JSON.stringify(TOKENS)));
  streamController.close();
  await assert.rejects(() => exchange, /cancelled/);
});
