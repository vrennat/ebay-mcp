import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.mjs';
test('real MCP protocol advertises only seven audited tools and rejects write calls', async () => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  let network = 0;
  const server = createServer(
    { environment: 'sandbox', userAccessToken: 'test-token' },
    {
      fetchImpl: async () => {
        network++;
        return new Response('{}');
      },
    },
  );
  const client = new Client({ name: 'read-only-test', version: '1.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 7);
    assert(listed.tools.every((t) => t.annotations.readOnlyHint === true));
    assert(!listed.tools.some((t) => /create|delete|update|token|credential|oauth/.test(t.name)));
    const denied = await client.callTool({ name: 'ebay_create_offer', arguments: {} });
    assert(denied.isError);
    assert.equal(network, 0);
    const rejected = await client.callTool({
      name: 'ac_read',
      arguments: { operation: 'inventory.createOffer' },
    });
    assert(rejected.isError);
    assert.equal(network, 0);
    const status = await client.callTool({ name: 'ac_status', arguments: {} });
    assert(!JSON.stringify(status).includes('test-token'));
    const read = await client.callTool({
      name: 'ac_read',
      arguments: { operation: 'inventory.getInventoryItems' },
    });
    assert(!read.isError);
    assert.equal(network, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test('desktop extension configuration requires marker and rejects unresolved secrets', async () => {
  const { configFromExtensionEnv } = await import('./index.mjs');
  assert.throws(() => configFromExtensionEnv({ AC_EBAY_USER_ACCESS_TOKEN: 'secret' }));
  for (const token of ['${user_config.user_access_token}', '__encrypted__:not-a-token'])
    assert.throws(() =>
      configFromExtensionEnv({
        AC_EBAY_CONFIG_SOURCE: 'desktop-extension',
        AC_EBAY_USER_ACCESS_TOKEN: token,
      }),
    );
  const result = configFromExtensionEnv({
    AC_EBAY_CONFIG_SOURCE: 'desktop-extension',
    AC_EBAY_USER_ACCESS_TOKEN: 'test-token',
    AC_EBAY_APP_ACCESS_TOKEN: '',
  });
  assert.equal(result.environment, 'production');
  assert.equal(result.appAccessToken, undefined);
  assert.equal(result.userAccessToken, 'test-token');
});
