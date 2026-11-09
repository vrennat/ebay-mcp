import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  mkdir,
  symlink,
  readdir,
  rm,
  chmod,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import {
  buildTokenConfig,
  claudeServerEntry,
  defaultClaudeConfigPath,
  mergeClaudeConfig,
  parseSetupArgs,
  prepareClaudeConfig,
  readHidden,
  runSetup,
  writeClaudeConfig,
  writeTokenConfig,
} from './setup.mjs';
import process from 'node:process';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ebay-readonly-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function captureOutput() {
  let text = '';
  return {
    output: {
      write: (value) => {
        text += value;
      },
    },
    get text() {
      return text;
    },
  };
}

function fakePrompts(consents) {
  return {
    ask: async () => 'sandbox',
    secret: async (prompt) => (prompt.startsWith('User') ? 'fake-user-token' : 'fake-app-token'),
    confirm: async () => consents.shift() ?? false,
  };
}

test('token config permits only supported environments and does not retain extra fields', () => {
  assert.deepEqual(
    buildTokenConfig({ userAccessToken: ' fake-token ', clientSecret: 'excluded' }),
    {
      environment: 'production',
      userAccessToken: 'fake-token',
      marketplaceId: 'EBAY_US',
      contentLanguage: 'en-US',
    },
  );
  assert.equal(
    buildTokenConfig({ environment: 'sandbox', userAccessToken: 'u', appAccessToken: 'a' })
      .appAccessToken,
    'a',
  );
  for (const value of ['', 'one two', 'one\ntwo', 'one\x00two']) {
    assert.throws(() => buildTokenConfig({ userAccessToken: value }), /access token/);
  }
  assert.throws(
    () => buildTokenConfig({ userAccessToken: 'secret-value', environment: 'other' }),
    /production or sandbox/,
  );
  assert.throws(
    () => buildTokenConfig({ userAccessToken: 'u', appAccessToken: 'a'.repeat(20_001) }),
    /access token/,
  );
});

test('Claude entry uses an executable and argument array, never a shell', () => {
  const entry = claudeServerEntry('/home/a path/$(inert)/config.json', {
    nodePath: '/node path/node',
    entryPath: '/repo path/index.mjs',
  });
  assert.deepEqual(entry, {
    command: '/node path/node',
    args: ['/repo path/index.mjs', '--config', '/home/a path/$(inert)/config.json'],
  });
  assert.throws(() => claudeServerEntry('relative.json'), /absolute/);
});

test('Claude merge preserves other servers and settings without mutating input', () => {
  const original = {
    theme: 'dark',
    mcpServers: { other: { command: '/other' }, 'ac-ebay-readonly': { command: '/old' } },
  };
  const copy = JSON.parse(JSON.stringify(original));
  const entry = { command: '/node', args: ['/server', '--config', '/config'] };
  const result = mergeClaudeConfig(original, entry);
  assert.deepEqual(original, copy);
  assert.deepEqual(result, {
    theme: 'dark',
    mcpServers: { other: { command: '/other' }, 'ac-ebay-readonly': entry },
  });
  for (const value of [null, [], 'text', { mcpServers: [] }, { mcpServers: null }]) {
    assert.throws(() => mergeClaudeConfig(value, entry));
  }
});

test('setup flags accept only nonsecret settings and do not echo rejected input', () => {
  assert.equal(parseSetupArgs(['--skip-claude']).skipClaude, true);
  assert.equal(
    parseSetupArgs(['--claude-config', './claude.json']).claudeConfigPath,
    path.resolve('claude.json'),
  );
  assert.throws(
    () => parseSetupArgs(['secret-not-to-echo']),
    (error) => !error.message.includes('secret-not-to-echo'),
  );
  assert.throws(() => parseSetupArgs(['--claude-config']), /needs a file path/);
  assert.throws(
    () => parseSetupArgs(['--skip-claude', '--claude-config', '/somewhere']),
    /not both/,
  );
  assert.equal(defaultClaudeConfigPath({ platform: 'linux' }), null);
  assert.equal(
    defaultClaudeConfigPath({ platform: 'darwin', homeDir: '/home/test' }),
    '/home/test/Library/Application Support/Claude/claude_desktop_config.json',
  );
});

test('token config is private and existing config is replaced without a token backup', async (t) => {
  const home = await fixture(t);
  const target = path.join(home, '.config', 'ac-ebay', 'config.json');
  await writeTokenConfig(target, { userAccessToken: 'first' });
  if (process.platform !== 'win32') {
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
    await chmod(target, 0o644);
    await chmod(path.dirname(target), 0o755);
  }
  await writeTokenConfig(target, { environment: 'sandbox', userAccessToken: 'second' });
  assert.equal(JSON.parse(await readFile(target, 'utf8')).userAccessToken, 'second');
  assert.deepEqual(await readdir(path.dirname(target)), ['config.json']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
  }
});

test('Claude merge writes a private exact backup and preserves existing data', async (t) => {
  const home = await fixture(t);
  const target = path.join(home, 'Claude', 'config.json');
  await mkdir(path.dirname(target));
  const source = '{"theme":"dark", "mcpServers":{"other":{"command":"other-server"}}}\n';
  await writeFile(target, source);
  const prepared = await prepareClaudeConfig(target, claudeServerEntry('/private/config.json'));
  const result = await writeClaudeConfig(target, prepared);
  assert.equal(await readFile(result.backupPath, 'utf8'), source);
  const saved = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(saved.theme, 'dark');
  assert.deepEqual(saved.mcpServers.other, { command: 'other-server' });
  assert.deepEqual(saved.mcpServers['ac-ebay-readonly'], claudeServerEntry('/private/config.json'));
  if (process.platform !== 'win32') {
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
  }
});

test('Claude merge refuses invalid JSON, invalid structure, and concurrent changes', async (t) => {
  const home = await fixture(t);
  const target = path.join(home, 'claude.json');
  const entry = claudeServerEntry('/private/config.json');
  await writeFile(target, 'not-json-secret');
  await assert.rejects(
    prepareClaudeConfig(target, entry),
    (error) => !error.message.includes('not-json-secret') && /not valid JSON/.test(error.message),
  );
  await writeFile(target, '{"mcpServers":[]}');
  await assert.rejects(prepareClaudeConfig(target, entry), /JSON object/);
  await writeFile(target, '{}');
  const prepared = await prepareClaudeConfig(target, entry);
  await writeFile(target, '{"someone":"changed this"}');
  await assert.rejects(writeClaudeConfig(target, prepared), /changed during setup/);
  assert.equal(await readFile(target, 'utf8'), '{"someone":"changed this"}');
});

test('config writes refuse symlink targets and parent directories', async (t) => {
  if (process.platform === 'win32') {
    return t.skip('Symlink creation can require administrator privileges on Windows.');
  }
  const home = await fixture(t);
  const real = path.join(home, 'real.json');
  const link = path.join(home, 'link.json');
  await writeFile(real, 'untouched');
  await symlink(real, link);
  await assert.rejects(writeTokenConfig(link, { userAccessToken: 'fake' }), /symbolic link/);
  await assert.rejects(
    prepareClaudeConfig(link, claudeServerEntry('/config.json')),
    /symbolic link/,
  );
  await symlink(path.join(home, 'missing'), path.join(home, 'dangling'));
  await assert.rejects(
    writeTokenConfig(path.join(home, 'dangling', 'config.json'), { userAccessToken: 'fake' }),
    /symbolic link/,
  );
  assert.equal(await readFile(real, 'utf8'), 'untouched');
});

test('config writes refuse non-regular files and symlinks introduced after preview', async (t) => {
  const home = await fixture(t);
  const directory = path.join(home, 'directory.json');
  await mkdir(directory);
  await assert.rejects(writeTokenConfig(directory, { userAccessToken: 'fake' }), /non-regular/);
  if (process.platform !== 'win32') {
    const target = path.join(home, 'claude.json');
    const prepared = await prepareClaudeConfig(target, claudeServerEntry('/private/config.json'));
    const untouched = path.join(home, 'untouched.json');
    await writeFile(untouched, '{}');
    await symlink(untouched, target);
    await assert.rejects(writeClaudeConfig(target, prepared), /symbolic link/);
    assert.equal(await readFile(untouched, 'utf8'), '{}');
  }
});

test('declining setup writes nothing and never logs a token', async (t) => {
  const home = await fixture(t);
  const capture = captureOutput();
  const result = await runSetup({
    args: [],
    homeDir: home,
    platform: 'darwin',
    output: capture.output,
    prompts: fakePrompts([false]),
  });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(await readdir(home), []);
  assert.ok(!capture.text.includes('fake-user-token'));
  assert.ok(!capture.text.includes('fake-app-token'));
});

test('token consent does not imply Claude consent', async (t) => {
  const home = await fixture(t);
  const capture = captureOutput();
  const result = await runSetup({
    args: [],
    homeDir: home,
    platform: 'darwin',
    output: capture.output,
    prompts: fakePrompts([true, false]),
  });
  assert.equal(result.claudeConfigured, false);
  assert.equal(JSON.parse(await readFile(result.configPath, 'utf8')).environment, 'sandbox');
  assert.deepEqual(await readdir(home), ['.config']);
  assert.ok(!capture.text.includes('fake-user-token'));
  assert.ok(!capture.text.includes('fake-app-token'));
});

test('guided setup only adds Claude after explicit separate consent', async (t) => {
  const home = await fixture(t);
  const capture = captureOutput();
  const result = await runSetup({
    args: [],
    homeDir: home,
    platform: 'darwin',
    output: capture.output,
    prompts: fakePrompts([true, true]),
  });
  assert.equal(result.claudeConfigured, true);
  const claude = JSON.parse(
    await readFile(defaultClaudeConfigPath({ platform: 'darwin', homeDir: home }), 'utf8'),
  );
  assert.deepEqual(claude.mcpServers['ac-ebay-readonly'], claudeServerEntry(result.configPath));
  assert.ok(!JSON.stringify(claude).includes('fake-user-token'));
  assert.ok(!capture.text.includes('fake-user-token'));
  assert.ok(!capture.text.includes('fake-app-token'));
});

test('hidden prompt never echoes input and restores terminal state', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  output.isTTY = true;
  const pending = readHidden('Token: ', { input, output });
  assert.equal(input.isRaw, true);
  input.write('fake-secretX\x7f\r');
  assert.equal(await pending, 'fake-secret');
  assert.equal(text, 'Token: \n');
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount('data'), 0);
});

test('hidden prompt handles cancellation and rejects nonterminal input', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  const output = { isTTY: true, write() {} };
  const pending = readHidden('Token: ', { input, output });
  input.write('fake-secret\x03');
  await assert.rejects(pending, /cancelled/);
  assert.equal(input.isRaw, false);
  await assert.rejects(
    readHidden('Token: ', { input: new PassThrough(), output }),
    /interactive terminal/,
  );
});
