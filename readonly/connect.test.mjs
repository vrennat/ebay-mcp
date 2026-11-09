import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  DEFAULT_CONNECT_SCOPES,
  browserCommand,
  openAuthorizationUrl,
  parseConnectScopes,
  runConnect,
} from './connect.mjs';
import { defaultClaudeConfigPath } from './setup.mjs';
import { createOAuthSession, DEFAULT_REDIRECT_URLS } from './oauth-connect.mjs';

const SECRET = 'FAKE_PRIVATE_CLIENT_SECRET';
const REFRESH = 'FAKE_PRIVATE_REFRESH_TOKEN';
const CALLBACK =
  'https://example.test/accepted?code=FAKE_PRIVATE_AUTHORIZATION_CODE&state=fake-state';
const REDIRECT = 'https://example.test/accepted';
const AUTH =
  'https://auth.ebay.com/oauth2/authorize?client_id=existing-app&response_type=code&state=fake-state';
const BASE = 'https://api.ebay.com/oauth/api_scope';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ac-ebay-connect-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function harness(
  home,
  consents,
  {
    answers = ['', 'existing-app', 'existing-runame', '', ''],
    exchangeError,
    open = true,
    scopes,
  } = {},
) {
  let text = '';
  const events = [];
  const calls = [];
  const secrets = [SECRET, CALLBACK];
  const oauth = {
    DEFAULT_REDIRECT_URLS: { production: REDIRECT },
    createOAuthSession(options) {
      events.push('create-session');
      calls.push(options);
      return {
        authorizationUrl: AUTH,
        scopes: scopes ?? options.scopes,
        async exchangeCallback(callback) {
          events.push('exchange');
          assert.equal(callback, CALLBACK);
          if (exchangeError) {
            throw exchangeError;
          }
          return {
            config: {
              environment: options.environment,
              clientId: options.clientId,
              clientSecret: options.clientSecret,
              refreshToken: REFRESH,
              scopes: options.scopes,
              marketplaceId: 'EBAY_US',
              contentLanguage: 'en-US',
            },
            accessTokenExpiresAt: 1234,
            refreshTokenExpiresAt: 5678,
          };
        },
      };
    },
  };
  const options = {
    args: [],
    homeDir: home,
    platform: 'darwin',
    oauth,
    output: {
      write(value) {
        text += value;
      },
    },
    prompts: {
      async ask() {
        return answers.shift() ?? '';
      },
      async secret() {
        return secrets.shift() ?? '';
      },
      async confirm() {
        const answer = consents.shift() ?? false;
        events.push(`confirm:${answer}`);
        return answer;
      },
    },
    async openBrowser(url) {
      assert.equal(url, AUTH);
      events.push('open');
      return open;
    },
  };
  return {
    options,
    events,
    calls,
    get text() {
      return text;
    },
  };
}

function assertNoSecrets(h, result) {
  const visible = h.text + JSON.stringify(result);
  for (const secret of [SECRET, REFRESH, CALLBACK, 'FAKE_PRIVATE_AUTHORIZATION_CODE']) {
    assert.ok(!visible.includes(secret));
  }
}

test('scope parsing defaults to base plus seven explicit reads and rejects write/unknown scopes', () => {
  assert.equal(DEFAULT_CONNECT_SCOPES.length, 8);
  assert.deepEqual(parseConnectScopes(''), [...DEFAULT_CONNECT_SCOPES]);
  assert.deepEqual(parseConnectScopes('sell.inventory.readonly, base, sell.inventory.readonly'), [
    BASE,
    `${BASE}/sell.inventory.readonly`,
  ]);
  assert.deepEqual(parseConnectScopes(`${BASE}/commerce.identity.readonly`), [
    BASE,
    `${BASE}/commerce.identity.readonly`,
  ]);
  for (const input of [
    'sell.inventory',
    'sell.account',
    'unknown.readonly',
    'commerce.feedback.readonly',
    'sell.inventory.readonly,',
    'https://evil.test/scope',
    'base,,base',
  ]) {
    assert.throws(() => parseConnectScopes(input));
  }
});

test('browser launch is fixed destination and argument-array only, with no shell', async () => {
  assert.deepEqual(browserCommand(AUTH, 'darwin'), { command: '/usr/bin/open', args: [AUTH] });
  assert.deepEqual(browserCommand(AUTH, 'linux'), { command: 'xdg-open', args: [AUTH] });
  assert.deepEqual(browserCommand(AUTH, 'win32'), {
    command: 'rundll32.exe',
    args: ['url.dll,FileProtocolHandler', AUTH],
  });
  for (const url of [
    'http://auth.ebay.com/oauth2/authorize',
    'https://evil.test/oauth2/authorize',
    `${AUTH}&code=do-not-show`,
    `${AUTH}&client_secret=do-not-show`,
  ]) {
    assert.throws(() => browserCommand(url));
  }
  let spawned;
  const success = await openAuthorizationUrl(AUTH, {
    platform: 'linux',
    spawnImpl(command, args, options) {
      spawned = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
  });
  assert.equal(success, true);
  assert.equal(spawned.options.shell, false);
  assert.deepEqual(spawned.args, [AUTH]);
  assert.equal(await openAuthorizationUrl(AUTH, { platform: 'unsupported' }), false);
  assert.equal(
    await openAuthorizationUrl(AUTH, {
      spawnImpl() {
        throw new Error('browser unavailable');
      },
    }),
    false,
  );
});

test('help requires no credentials, engine, browser, or writes', async (t) => {
  const home = await fixture(t);
  const h = harness(home, []);
  const result = await runConnect({ ...h.options, args: ['--help'], oauth: undefined });
  assert.equal(result.status, 'help');
  assert.deepEqual(h.events, []);
  assert.deepEqual(await readdir(home), []);
});

test('declining initial consent never opens a browser, exchanges a code, or writes files', async (t) => {
  const home = await fixture(t);
  const h = harness(home, [false]);
  const result = await runConnect(h.options);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(h.events, ['create-session', 'confirm:false']);
  assert.equal(h.calls[0].redirectUrl, REDIRECT);
  assert.deepEqual(await readdir(home), []);
  assert.ok(h.text.includes('Exact requested scopes'));
  assert.ok(h.text.includes('local plaintext'));
  assertNoSecrets(h, result);
});

test('browser consent does not authorize code exchange and cancellation explains retained grants', async (t) => {
  const home = await fixture(t);
  const h = harness(home, [true, false]);
  const result = await runConnect(h.options);
  assert.deepEqual(h.events, ['create-session', 'confirm:true', 'open', 'confirm:false']);
  assert.deepEqual(await readdir(home), []);
  assert.ok(h.text.includes('does not revoke'));
  assertNoSecrets(h, result);
});

test('code exchange consent does not authorize local persistence', async (t) => {
  const home = await fixture(t);
  const h = harness(home, [true, true, false]);
  const result = await runConnect(h.options);
  assert.equal(result.status, 'authorized-not-saved');
  assert.deepEqual(h.events, [
    'create-session',
    'confirm:true',
    'open',
    'confirm:true',
    'exchange',
    'confirm:false',
  ]);
  assert.deepEqual(await readdir(home), []);
  assert.ok(h.text.includes('does not revoke'));
  assertNoSecrets(h, result);
});

test('save consent writes private persistent config but does not imply Claude merge consent', async (t) => {
  const home = await fixture(t);
  const h = harness(home, [true, true, true, false]);
  const result = await runConnect(h.options);
  assert.equal(result.status, 'saved');
  assert.equal(result.claudeConfigured, false);
  const stored = JSON.parse(await readFile(result.configPath, 'utf8'));
  assert.equal(stored.clientSecret, SECRET);
  assert.equal(stored.refreshToken, REFRESH);
  assert.deepEqual(stored.scopes, [...DEFAULT_CONNECT_SCOPES]);
  assert.deepEqual(await readdir(home), ['.config']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(result.configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(result.configPath))).mode & 0o777, 0o700);
  }
  assertNoSecrets(h, result);
});

test('separate Claude consent preserves other settings and creates exact private backup', async (t) => {
  const home = await fixture(t);
  const target = defaultClaudeConfigPath({ platform: 'darwin', homeDir: home });
  await mkdir(path.dirname(target), { recursive: true });
  const old = '{"theme":"dark","mcpServers":{"other":{"command":"unchanged"}}}\n';
  await writeFile(target, old);
  const h = harness(home, [true, true, true, true]);
  const result = await runConnect(h.options);
  assert.equal(result.claudeConfigured, true);
  assert.equal(await readFile(result.backupPath, 'utf8'), old);
  const claude = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(claude.theme, 'dark');
  assert.deepEqual(claude.mcpServers.other, { command: 'unchanged' });
  assert.deepEqual(claude.mcpServers['ac-ebay-readonly'].args.slice(-2), [
    '--config',
    result.configPath,
  ]);
  assert.ok(!JSON.stringify(claude).includes(SECRET));
  assert.ok(!JSON.stringify(claude).includes(REFRESH));
  assertNoSecrets(h, result);
});

test('browser failure only displays the authorization URL, never callback/code/tokens', async (t) => {
  const home = await fixture(t);
  const h = harness(home, [true, false], { open: false });
  const result = await runConnect(h.options);
  assert.ok(h.text.includes(AUTH));
  assertNoSecrets(h, result);
});

test('callback exchange errors suppress untrusted exception contents and save nothing', async (t) => {
  const home = await fixture(t);
  const h = harness(home, [true, true], { exchangeError: new Error(`${SECRET} ${CALLBACK}`) });
  await assert.rejects(
    runConnect(h.options),
    (error) =>
      /Callback validation or code exchange failed/.test(error.message) &&
      !error.message.includes(SECRET) &&
      !error.message.includes(CALLBACK),
  );
  assert.deepEqual(await readdir(home), []);
  assert.ok(h.text.includes('does not revoke'));
  assertNoSecrets(h);
});

test('a session cannot silently substitute different consent scopes', async (t) => {
  const home = await fixture(t);
  const h = harness(home, [true], { scopes: [BASE] });
  await assert.rejects(runConnect(h.options), /do not match/);
  assert.deepEqual(h.events, ['create-session']);
  assert.deepEqual(await readdir(home), []);
});

test('registered Accept URL cannot be insecure or a completed callback', async (t) => {
  const home = await fixture(t);
  for (const redirect of [
    'http://example.test/callback',
    CALLBACK,
    'https://example.test/callback#secret',
  ]) {
    const h = harness(home, [true], {
      answers: ['', 'existing-app', 'existing-runame', redirect, ''],
    });
    await assert.rejects(runConnect(h.options), /registered HTTPS Accept URL/);
    assert.deepEqual(h.events, []);
    assertNoSecrets(h);
  }
});

test('secure OAuth save refuses symlinks and never overwrites their target', async (t) => {
  if (process.platform === 'win32') {
    return t.skip('Symlinks may need administrator privileges.');
  }
  const home = await fixture(t);
  const tokenDirectory = path.join(home, '.config', 'ac-ebay');
  await mkdir(tokenDirectory, { recursive: true });
  const real = path.join(home, 'untouched.json');
  await writeFile(real, 'untouched');
  await symlink(real, path.join(tokenDirectory, 'config.json'));
  const h = harness(home, [true, true, true]);
  await assert.rejects(runConnect(h.options), /symbolic link/);
  assert.equal(await readFile(real, 'utf8'), 'untouched');
  assert.ok(h.text.includes('does not revoke'));
  assertNoSecrets(h);
});

test('skip-Claude saves without any extra merge prompt', async (t) => {
  const home = await fixture(t);
  const h = harness(home, [true, true, true]);
  const result = await runConnect({ ...h.options, args: ['--skip-claude'] });
  assert.equal(result.claudeConfigured, false);
  assert.equal(h.events.filter((value) => value.startsWith('confirm:')).length, 3);
  assertNoSecrets(h, result);
});

test('real OAuth engine integrates with CLI through a mocked exchange and records refresh expiry', async (t) => {
  const home = await fixture(t);
  const now = Date.now();
  const code = 'FAKE_CODE_WITH_%2B+_CHARS';
  const answers = ['', 'existing-app', 'existing-runame', '', ''];
  let callback;
  let text = '';
  let requests = 0;
  let secretPrompts = 0;
  const result = await runConnect({
    args: ['--skip-claude'],
    homeDir: home,
    platform: 'darwin',
    output: {
      write(value) {
        text += value;
      },
    },
    oauth: {
      DEFAULT_REDIRECT_URLS,
      createOAuthSession(input) {
        return createOAuthSession(input, {
          now: () => now,
          randomBytesImpl: () => Buffer.alloc(32, 2),
          async fetchImpl(url, options) {
            requests += 1;
            assert.equal(url, 'https://api.ebay.com/identity/v1/oauth2/token');
            assert.equal(options.method, 'POST');
            assert.equal(options.redirect, 'error');
            const body = new URLSearchParams(options.body);
            assert.equal(body.get('code'), code);
            assert.equal(body.get('redirect_uri'), 'existing-runame');
            return new Response(
              JSON.stringify({
                token_type: 'User Access Token',
                access_token: 'FAKE_NEW_ACCESS_TOKEN',
                refresh_token: REFRESH,
                expires_in: 7200,
                refresh_token_expires_in: 31_536_000,
                scope: DEFAULT_CONNECT_SCOPES.join(' '),
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          },
        });
      },
    },
    async openBrowser(authorizationUrl) {
      const authorization = new URL(authorizationUrl);
      const final = new URL(DEFAULT_REDIRECT_URLS.production);
      final.searchParams.set('state', authorization.searchParams.get('state'));
      final.searchParams.set('code', code);
      callback = final.href;
      return true;
    },
    prompts: {
      async ask() {
        return answers.shift();
      },
      async secret() {
        secretPrompts += 1;
        return secretPrompts === 1 ? SECRET : callback;
      },
      async confirm() {
        return true;
      },
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.status, 'saved');
  const config = JSON.parse(await readFile(result.configPath, 'utf8'));
  assert.equal(config.refreshToken, REFRESH);
  assert.equal(config.refreshTokenExpiresAt, new Date(now + 31_536_000_000).toISOString());
  assert.equal(config.userAccessToken, undefined);
  for (const secret of [SECRET, REFRESH, callback, code, 'FAKE_NEW_ACCESS_TOKEN']) {
    assert.ok(!text.includes(secret));
  }
});
