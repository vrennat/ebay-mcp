import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './index.mjs';
test('runtime loads private config and refuses symlinks, public files and malformed data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-config-test-'));
  const file = join(dir, 'config.json');
  try {
    await writeFile(
      file,
      JSON.stringify({ environment: 'sandbox', userAccessToken: 'test-only' }),
      { mode: 0o600 },
    );
    assert.equal((await loadConfig(file)).environment, 'sandbox');
    await symlink(file, join(dir, 'link'));
    await assert.rejects(() => loadConfig(join(dir, 'link')), /symlink/);
    if (process.platform !== 'win32') {
      await chmod(file, 0o644);
      await assert.rejects(() => loadConfig(file), /private/);
      await chmod(file, 0o600);
    }
    await writeFile(file, 'token-secret invalid-json');
    await assert.rejects(
      () => loadConfig(file),
      (e) => !e.message.includes('token-secret'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
