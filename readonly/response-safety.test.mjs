import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, parseTradingResponse, redact, READ_SCOPES } from './core.mjs';
import { createServer } from './index.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const USER = 'TEST-USER-TOKEN<&^';
const APP = 'TEST-APP-TOKEN';
const SECRET = 'TEST-CLIENT-SECRET';
const REFRESH = 'TEST-REFRESH-TOKEN';
const config = {
  environment: 'sandbox',
  userAccessToken: USER,
  appAccessToken: APP,
  clientId: 'TEST-CLIENT-ID',
  clientSecret: SECRET,
  refreshToken: REFRESH,
};
const xml = (name, ack, body = '') =>
  `<?xml version="1.0"?><${name}Response xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>${ack}</Ack>${body}</${name}Response>`;
const escapeXml = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
for (const name of ['GetItem', 'GetMyeBaySelling']) {
  for (const ack of ['Failure', 'PartialFailure', 'Unknown'])
    test(`${name} rejects HTTP-200 ${ack}`, async () => {
      const client = createClient(config, {
        fetchImpl: async () =>
          new Response(
            xml(name, ack, '<Errors><LongMessage>Do not trust this</LongMessage></Errors>'),
            { status: 200, headers: { 'content-type': 'text/xml' } },
          ),
      });
      await assert.rejects(
        () => (name === 'GetItem' ? client.listing('123') : client.activeListings()),
        /did not succeed/,
      );
    });
  test(`${name} retains explicit warnings, fields and ceiling notice`, async () => {
    const client = createClient(config, {
      fetchImpl: async () =>
        new Response(
          xml(
            name,
            'Warning',
            '<Errors><ErrorCode>219</ErrorCode></Errors><Item><ItemID>001234</ItemID></Item>',
          ),
          { headers: { 'content-type': 'text/xml' } },
        ),
    });
    const result = await (name === 'GetItem' ? client.listing('123') : client.activeListings());
    assert.equal(result.ack, 'Warning');
    assert(result.warning);
    assert.equal(result.data.Item.ItemID, '001234');
    if (name === 'GetMyeBaySelling') assert.match(result.notice, /25,000/);
  });
}
test('Trading XML rejects malformed, missing, duplicate, mismatched, comment-spoofed Ack and DTD', () => {
  const malformed = [
    '<GetItemResponse><Ack>Success',
    '<GetItemResponse/>',
    '<GetItemResponse><Ack>Success</Ack><Ack>Failure</Ack></GetItemResponse>',
    xml('GetMyeBaySelling', 'Success'),
    '<GetItemResponse><!-- <Ack>Success</Ack> --><Ack>Failure</Ack></GetItemResponse>',
    '<!DOCTYPE x [<!ENTITY y "Success">]><GetItemResponse><Ack>&y;</Ack></GetItemResponse>',
    '<GetItemResponse><Nested><Ack>Success</Ack></Nested></GetItemResponse>',
    '<GetItemResponse><Ack>Success</Ack></GetItemResponse><Other/>',
  ];
  for (const raw of malformed) assert.throws(() => parseTradingResponse(raw, 'GetItem'));
});
test('namespaced Trading success parses without losing fields', () => {
  const result = parseTradingResponse(
    '<e:GetItemResponse xmlns:e="urn:ebay:apis:eBLBaseComponents"><e:Ack>Success</e:Ack><e:Item><e:Title>Book &amp; Map</e:Title></e:Item></e:GetItemResponse>',
    'GetItem',
  );
  assert.equal(result.ack, 'Success');
  assert.equal(result.data.Item.Title, 'Book & Map');
});
test('known secrets are removed from arbitrary JSON strings, arrays and field names', async () => {
  const payload = {
    message: `${USER} ${APP} ${SECRET} ${REFRESH}`,
    list: [USER, { [APP]: SECRET }],
    safe: 4,
  };
  const client = createClient(config, {
    fetchImpl: async () =>
      new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }),
  });
  const result = await client.read('inventory.getInventoryItems');
  const serialized = JSON.stringify(result);
  for (const secret of [USER, APP, SECRET, REFRESH]) assert(!serialized.includes(secret));
  assert.equal(result.data.safe, 4);
});
test('XML secrets, arbitrary echoed token values and unknown verification tokens are redacted', async () => {
  const payload = xml(
    'GetItem',
    'Success',
    `<Echo>${escapeXml(USER)}</Echo><verificationToken>UNCONFIGURED-VERIFY</verificationToken><Credentials secret="safe"><accessToken>${APP}</accessToken></Credentials>`,
  );
  const client = createClient(config, {
    fetchImpl: async () => new Response(payload, { headers: { 'content-type': 'text/xml' } }),
  });
  const result = await client.listing('123');
  const serialized = JSON.stringify(result);
  for (const secret of [USER, APP, 'UNCONFIGURED-VERIFY']) assert(!serialized.includes(secret));
  assert.equal(result.data.Echo, '[redacted]');
  assert.equal(result.data.verificationToken, '[redacted]');
});
test('text responses redact known tokens and recognized credential labels', async () => {
  const text = `diagnostic says ${USER}\nverificationToken=UNCONFIGURED-VERIFY\nAuthorization: Bearer UNCONFIGURED-AUTH\nnormal report`;
  const client = createClient(config, {
    fetchImpl: async () => new Response(text, { headers: { 'content-type': 'text/plain' } }),
  });
  const result = await client.read('inventory.getInventoryItems');
  const serialized = JSON.stringify(result);
  for (const secret of [USER, 'UNCONFIGURED-VERIFY', 'UNCONFIGURED-AUTH'])
    assert(!serialized.includes(secret));
  assert(serialized.includes('normal report'));
});
test('common escaped and encoded known token representations are redacted', () => {
  const variants = [
    USER,
    escapeXml(USER),
    encodeURIComponent(USER),
    Buffer.from(USER).toString('base64'),
    JSON.stringify(USER).slice(1, -1),
  ];
  for (const variant of variants) assert.equal(redact(variant, [USER]), '[redacted]');
});
test('newly refreshed token is redacted even under a different field', async () => {
  const FRESH = 'NEW-REFRESHED-TOKEN';
  let count = 0;
  const client = createClient(
    { ...config, userAccessToken: undefined, scopes: [READ_SCOPES[1]] },
    {
      fetchImpl: async (url) => {
        count++;
        return new Response(
          JSON.stringify(
            url.endsWith('/token')
              ? { access_token: FRESH, expires_in: 7200, scope: READ_SCOPES[1] }
              : { message: FRESH },
          ),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    },
  );
  const result = await client.read('inventory.getInventoryItems');
  assert.equal(count, 2);
  assert(!JSON.stringify(result).includes(FRESH));
  assert.equal(result.data.message, '[redacted]');
});
test('malformed JSON is not returned as raw text', async () => {
  const client = createClient(config, {
    fetchImpl: async () =>
      new Response(`invalid ${USER}`, { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    () => client.read('inventory.getInventoryItems'),
    (e) => /malformed JSON/.test(e.message) && !e.message.includes(USER),
  );
});
test('response stream errors are sanitized at public client boundary', async () => {
  const client = createClient(config, {
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(`stream failure ${SECRET}`));
          },
        }),
      ),
  });
  await assert.rejects(
    () => client.read('inventory.getInventoryItems'),
    (e) => !e.message.includes(SECRET),
  );
});
test('real MCP returns isError for HTTP-200 Trading failure, with no secret leakage', async () => {
  const [s, c] = InMemoryTransport.createLinkedPair();
  const server = createServer(config, {
    fetchImpl: async () =>
      new Response(
        xml('GetItem', 'Failure', `<Errors><LongMessage>${escapeXml(USER)}</LongMessage></Errors>`),
        { headers: { 'content-type': 'text/xml' } },
      ),
  });
  const client = new Client({ name: 'response-safety', version: '1.0.0' });
  try {
    await Promise.all([server.connect(s), client.connect(c)]);
    const result = await client.callTool({ name: 'ac_listing', arguments: { itemId: '123' } });
    assert.equal(result.isError, true);
    assert(!JSON.stringify(result).includes(USER));
    assert.match(JSON.stringify(result), /did not succeed/);
  } finally {
    await client.close();
    await server.close();
  }
});
