import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG,
  READ_SCOPES,
  validateScopes,
  validateConfig,
  buildReadRequest,
  assertReadRequest,
  createClient,
  findReads,
  operationInfo,
  redact,
} from './core.mjs';
const config = {
  environment: 'production',
  userAccessToken: 'test-only-user-token',
  appAccessToken: 'test-only-app-token',
};
const response = (value = { ok: true }, init = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
function sample(op) {
  return {
    path: Object.fromEntries(op.pathParameters.map((k) => [k, '123'])),
    query: Object.fromEntries(op.requiredQuery.map((k) => [k, 'test'])),
  };
}

test('catalogue is nonempty, immutable, unique and GET-only', () => {
  assert(CATALOG.length > 150);
  assert.equal(new Set(CATALOG.map((v) => v.id)).size, CATALOG.length);
  assert(CATALOG.every((v) => v.method === 'GET'));
  assert.throws(() => CATALOG.push({}));
  assert.throws(() => {
    CATALOG[0].path = '/write';
  });
});
for (const op of CATALOG)
  test(`allowed read builds and reaches only fixed eBay origin: ${op.id}`, async () => {
    const args = sample(op);
    const req = buildReadRequest(op.id, args);
    assertReadRequest(req, 'production');
    assert.equal(req.method, 'GET');
    const calls = [];
    const client = createClient(config, {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return response();
      },
    });
    await client.read(op.id, args);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.redirect, 'error');
    assert.match(calls[0].url, /^https:\/\/(api|apiz|apim)\.ebay\.com\//);
  });
test('read-only cannot be disabled by config or name hints', async () => {
  assert.throws(() => validateConfig({ ...config, readOnly: false }));
  assert.throws(() => validateConfig({ ...config, apiBaseUrl: 'https://evil.example' }));
  for (const id of [
    'ebay_create_offer',
    'inventory.deleteInventoryItem',
    'account.getRateTables',
    'notification.getDestination',
    'notification.getDestinations',
    'developer.getSigningKey',
    'getTotallySafe',
    '__proto__',
  ])
    assert.throws(() => buildReadRequest(id));
});
test('write verbs and forged requests are rejected', () => {
  const op = CATALOG[0],
    req = buildReadRequest(op.id, sample(op));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'get'])
    assert.throws(() => assertReadRequest({ ...req, method }, 'production'));
  for (const url of [
    'https://evil.example/read',
    'http://api.ebay.com/sell/inventory/v1/inventory_item',
    'https://api.ebay.com:444/read',
    'https://user@api.ebay.com/read',
    'https://api.ebay.com/read#x',
  ])
    assert.throws(() => assertReadRequest({ ...req, url }, 'production'));
  assert.throws(() => assertReadRequest({ ...req, body: '{}' }, 'production'));
  assert.throws(() =>
    assertReadRequest({ ...req, headers: { 'X-HTTP-Method-Override': 'DELETE' } }, 'production'),
  );
});
test('traversal, full URLs, query override and custom fields fail before network', async () => {
  let calls = 0;
  const client = createClient(config, {
    fetchImpl: async () => {
      calls++;
      return response();
    },
  });
  for (const sku of ['.', '..', '../rate_table', 'a/b', 'a\\b', '%2e%2e', '%252e', '\n'])
    await assert.rejects(async () => client.read('inventory.getInventoryItem', { path: { sku } }));
  for (const args of [
    { url: 'https://evil.example' },
    { method: 'DELETE' },
    { headers: {} },
    { query: { _method: 'DELETE' } },
    { query: { redirect_uri: 'https://evil.example' } },
    { path: { sku: '123', method: 'DELETE' } },
  ])
    await assert.rejects(async () => client.read('inventory.getInventoryItems', args));
  assert.equal(calls, 0);
});
test('query values encoded and required names checked', () => {
  const req = buildReadRequest('browse.search', {
    query: { q: 'one&redirect_uri=https://evil.example/?x=y' },
  });
  const url = new URL(req.url);
  assert.equal(url.searchParams.size, 1);
  assert.equal(url.searchParams.get('q'), 'one&redirect_uri=https://evil.example/?x=y');
  assert.throws(() => buildReadRequest('inventory.getInventoryItem', { path: {} }));
});
test('scope allowlist is explicit, immutable and rejects mixed/unknown scopes', () => {
  for (const s of ['sell.inventory', 'sell.finances', 'commerce.message', 'fake.readonly'])
    assert.throws(() => validateScopes([`https://api.ebay.com/oauth/api_scope/${s}`]));
  assert.throws(() => validateScopes([]));
  assert.throws(() => READ_SCOPES.push('write'));
  assert.equal(validateScopes([READ_SCOPES[0], READ_SCOPES[0]]).length, 1);
});
test('status and results do not expose credentials', async () => {
  const client = createClient(config, {
    fetchImpl: async () =>
      response({
        nested: { verificationToken: 'secret', access_token: 'secret', privateKey: 'secret' },
        value: 7,
      }),
  });
  assert(!JSON.stringify(client.status()).includes('test-only'));
  const result = await client.read('inventory.getInventoryItems');
  assert(!JSON.stringify(result).includes('secret'));
  assert.equal(result.data.value, 7);
  assert.equal(redact({ refreshToken: 'secret' }).refreshToken, '[redacted]');
});
test('bulk inventory is the exact allowed POST and rejects invalid input', async () => {
  const calls = [];
  const client = createClient(config, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response();
    },
  });
  await client.bulkInventory(['ABC', 'A&B']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(new URL(calls[0].url).pathname, '/sell/inventory/v1/bulk_get_inventory_item');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    requests: [{ sku: 'ABC' }, { sku: 'A&B' }],
  });
  await assert.rejects(async () => client.bulkInventory([]));
  await assert.rejects(async () => client.bulkInventory(Array(26).fill('a')));
});
test('Trading operations have fixed XML, headers and no arbitrary call/body', async () => {
  const calls = [];
  const client = createClient(config, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const name = options.headers['X-EBAY-API-CALL-NAME'];
      return new Response(`<${name}Response><Ack>Success</Ack></${name}Response>`, {
        headers: { 'content-type': 'text/xml' },
      });
    },
  });
  await client.listing('123456789');
  await client.activeListings({ page: 2, pageSize: 100 });
  assert.equal(calls[0].options.headers['X-EBAY-API-CALL-NAME'], 'GetItem');
  assert.equal(calls[1].options.headers['X-EBAY-API-CALL-NAME'], 'GetMyeBaySelling');
  assert(calls[1].options.body.includes('<PageNumber>2</PageNumber>'));
  await assert.rejects(async () => client.listing('123</ItemID><AddItem>'));
  await assert.rejects(async () => client.activeListings({ page: 1, callName: 'AddItem' }));
  assert.throws(() =>
    assertReadRequest(
      { method: 'POST', url: 'https://api.ebay.com/ws/api.dll', operation: 'AddItem' },
      'production',
    ),
  );
  assert.throws(() =>
    assertReadRequest(
      {
        method: 'POST',
        url: 'https://api.ebay.com/ws/api.dll',
        operation: 'GetItem',
        input: { itemId: '123' },
        body: '<AddItemRequest/>',
      },
      'production',
    ),
  );
});
test('errors never echo eBay body or tokens; no write fallback/retry', async () => {
  let count = 0;
  const client = createClient(config, {
    fetchImpl: async () => {
      count++;
      return response({ access_token: 'secret', message: 'secret' }, { status: 403 });
    },
  });
  await assert.rejects(
    () => client.read('inventory.getInventoryItems'),
    (e) => e.message.includes('403') && !e.message.includes('secret'),
  );
  assert.equal(count, 1);
});
test('redirects are forbidden and network errors do not echo data', async () => {
  const client = createClient(config, {
    fetchImpl: async (_, options) => {
      assert.equal(options.redirect, 'error');
      throw new Error('secret');
    },
  });
  await assert.rejects(
    () => client.read('inventory.getInventoryItems'),
    (e) => !e.message.includes('secret'),
  );
});
test('responses are capped and binary files explicitly unsupported', async () => {
  const oversized = createClient(config, {
    fetchImpl: async () => new Response('x', { headers: { 'content-length': '9000000' } }),
  });
  await assert.rejects(() => oversized.read('inventory.getInventoryItems'), /8 MiB/);
  const binary = createClient(config, {
    fetchImpl: async () => new Response('x', { headers: { 'content-type': 'application/pdf' } }),
  });
  await assert.rejects(() => binary.read('inventory.getInventoryItems'), /Binary/);
});
test('OAuth refresh explicitly down-scopes and never returns token', async () => {
  const calls = [];
  const client = createClient(
    {
      environment: 'production',
      clientId: 'test-client',
      clientSecret: 'test-secret',
      refreshToken: 'test-refresh',
      scopes: [READ_SCOPES[1]],
    },
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return url.endsWith('/token')
          ? response({ access_token: 'new-token', expires_in: 7200, scope: READ_SCOPES[1] })
          : response();
      },
    },
  );
  const result = await client.read('inventory.getInventoryItems');
  assert.equal(calls.length, 2);
  assert.equal(new URLSearchParams(calls[0].options.body).get('scope'), READ_SCOPES[1]);
  assert.equal(calls[0].options.redirect, 'error');
  assert(!JSON.stringify(result).includes('new-token'));
});
test('OAuth rejects returned broad scopes and malformed secret-bearing JSON', async () => {
  for (const body of [
    JSON.stringify({
      access_token: 'secret',
      scope: 'https://api.ebay.com/oauth/api_scope/sell.inventory',
    }),
    'secret invalid-json',
  ]) {
    let count = 0;
    const client = createClient(
      {
        environment: 'production',
        clientId: 'test-client',
        clientSecret: 'test-secret',
        refreshToken: 'test-refresh',
      },
      {
        fetchImpl: async () => {
          count++;
          return new Response(body);
        },
      },
    );
    await assert.rejects(
      () => client.read('inventory.getInventoryItems'),
      (e) => !e.message.includes('secret'),
    );
    assert.equal(count, 1);
  }
});
test('application/user tokens are routed separately; no fallback between them', async () => {
  const calls = [];
  const client = createClient(config, {
    fetchImpl: async (_, options) => {
      calls.push(options);
      return response();
    },
  });
  await client.read('browse.search', { query: { q: 'book' } });
  await client.read('inventory.getInventoryItems');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-only-app-token');
  assert.equal(calls[1].headers.Authorization, 'Bearer test-only-user-token');
  const onlyUser = createClient(
    { environment: 'production', userAccessToken: 'test' },
    {
      fetchImpl: async () => {
        throw Error('should not fetch');
      },
    },
  );
  await assert.rejects(() => onlyUser.read('browse.search'), /application token/);
});
test('discovery exposes honest mixed-scope limits and complete pagination', () => {
  assert.match(operationInfo('message.getConversation').scopeSafety, /mixed scope/);
  let seen = [];
  let offset = 0;
  do {
    const page = findReads('', undefined, offset, 60);
    seen.push(...page.operations);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(seen.length, CATALOG.length);
});

test('independent wire gate rejects forged GET token, path, input and fields', () => {
  const req = buildReadRequest('inventory.getInventoryItem', { path: { sku: '123' } });
  for (const changed of [
    { token: 'application' },
    { url: 'https://api.ebay.com/sell/inventory/v1/inventory_item/%2e%2e%2frate_table' },
    { input: { path: { sku: '../rate_table' } } },
    { extra: 'unexpected' },
  ])
    assert.throws(() => assertReadRequest({ ...req, ...changed }, 'production'));
});

test('reviewed exceptions use verified current API hosts and versions', () => {
  const expected = {
    'message.getConversation': ['api', '/commerce/message/v1/'],
    'feedback.getFeedback': ['api', '/commerce/feedback/v1/'],
    'logistics.getShipment': ['api', '/sell/logistics/v1_beta/'],
    'media.getDocument': ['api', '/commerce/media/v1_beta/'],
    'finances.getBillingActivities': ['api', '/sell/finances/v1/'],
    'fulfillment.getPaymentDispute': ['apiz', '/sell/fulfillment/v1/'],
    'fulfillment.getOrders': ['api', '/sell/fulfillment/v1/'],
  };
  for (const [id, [host, prefix]] of Object.entries(expected)) {
    const op = operationInfo(id);
    assert.equal(op.host, host);
    assert(op.path.startsWith(prefix));
  }
  assert.equal(operationInfo('developer_analytics.getUserRateLimits').token, 'user');
  assert.match(operationInfo('account_v2.getPayoutSettings').scopeSafety, /mixed scope/);
});
