#!/usr/bin/env node
/** Local, token-only setup. Never run this during installation or server startup. */
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const SERVER_NAME = 'ac-ebay-readonly';
const ENTRY_PATH = fileURLToPath(new URL('./index.mjs', import.meta.url));
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export class SetupError extends Error {}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function buildTokenConfig({ environment = 'production', userAccessToken, appAccessToken }) {
  if (!['production', 'sandbox'].includes(environment)) {
    throw new SetupError('Choose production or sandbox.');
  }
  const cleanToken = (value, required) => {
    if (typeof value !== 'string' && value !== undefined) {
      throw new SetupError('An access token must be text.');
    }
    const token = value?.trim() ?? '';
    if ((!token && required) || token.length > 20_000 || /\s|[\x00-\x1f\x7f]/u.test(token)) {
      throw new SetupError('Paste one access token with no spaces or line breaks.');
    }
    return token;
  };
  const config = {
    environment,
    userAccessToken: cleanToken(userAccessToken, true),
    marketplaceId: 'EBAY_US',
    contentLanguage: 'en-US',
  };
  const appToken = cleanToken(appAccessToken, false);
  if (appToken) {
    config.appAccessToken = appToken;
  }
  return config;
}

export function claudeServerEntry(
  configPath,
  { nodePath = process.execPath, entryPath = ENTRY_PATH } = {},
) {
  if (
    ![configPath, nodePath, entryPath].every(
      (value) => typeof value === 'string' && path.isAbsolute(value),
    )
  ) {
    throw new SetupError('The Node executable, server, and configuration paths must be absolute.');
  }
  return { command: nodePath, args: [entryPath, '--config', configPath] };
}

export function mergeClaudeConfig(existing, entry) {
  if (
    !isObject(existing) ||
    (existing.mcpServers !== undefined && !isObject(existing.mcpServers))
  ) {
    throw new SetupError(
      'Claude configuration must be a JSON object with an optional mcpServers object.',
    );
  }
  return { ...existing, mcpServers: { ...existing.mcpServers, [SERVER_NAME]: entry } };
}

export function defaultClaudeConfigPath({
  platform = process.platform,
  homeDir = os.homedir(),
  appData = process.env.APPDATA,
} = {}) {
  if (platform === 'darwin') {
    return path.join(
      homeDir,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }
  if (platform === 'win32') {
    return path.join(
      appData || path.join(homeDir, 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json',
    );
  }
  // No guessed Linux location: use the explicitly supplied --claude-config path.
  return null;
}

export function parseSetupArgs(args) {
  const options = { help: false, skipClaude: false, claudeConfigPath: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--skip-claude') {
      options.skipClaude = true;
    } else if (arg === '--claude-config') {
      const value = args[++index];
      if (!value || value.startsWith('--')) {
        throw new SetupError('--claude-config needs a file path.');
      }
      options.claudeConfigPath = path.resolve(value);
    } else {
      throw new SetupError(
        'Unknown option. Use --help. Never put tokens in command-line arguments.',
      );
    }
  }
  if (options.skipClaude && options.claudeConfigPath) {
    throw new SetupError('Use either --skip-claude or --claude-config, not both.');
  }
  return options;
}

/** Refuse symlinks in the target or any existing ancestor, including dangling links. */
async function assertNoSymlinks(target) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw new SetupError('Could not inspect a configuration path. Check directory access.');
    }
    if (stat.isSymbolicLink()) {
      throw new SetupError(
        'Refusing a symbolic link in a configuration path. Choose a real file and directory.',
      );
    }
    if (current !== absolute && !stat.isDirectory()) {
      throw new SetupError('A configuration parent path is not a directory.');
    }
  }
}

async function ensureDirectory(directory, privateLeaf) {
  await assertNoSymlinks(directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymlinks(directory);
  if (!(await fs.lstat(directory)).isDirectory()) {
    throw new SetupError('The configuration folder is not a directory.');
  }
  if (privateLeaf) {
    await fs.chmod(directory, 0o700);
  }
}

async function readSnapshot(target) {
  await assertNoSymlinks(target);
  let handle;
  try {
    if (!(await fs.lstat(target)).isFile()) {
      throw new SetupError('Refusing to replace a non-regular configuration file.');
    }
    // Nonblocking mode also avoids hanging if a FIFO replaces the file during inspection.
    handle = await fs.open(target, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    if (error instanceof SetupError) {
      throw error;
    }
    throw new SetupError('Could not safely open the configuration file.');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new SetupError('Refusing to replace a non-regular configuration file.');
    }
    if (stat.size > 8 * 1024 * 1024) {
      throw new SetupError('The configuration file is unexpectedly large.');
    }
    return { data: await handle.readFile('utf8'), stat };
  } finally {
    await handle.close();
  }
}

function sameSnapshot(left, right) {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.data === right.data &&
    left.stat.ino === right.stat.ino &&
    left.stat.dev === right.stat.dev &&
    left.stat.mtimeMs === right.stat.mtimeMs &&
    left.stat.ctimeMs === right.stat.ctimeMs
  );
}

async function exclusiveWrite(target, data) {
  const handle = await fs.open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Write only after the caller has obtained explicit consent for this target. */
async function replaceJson(
  target,
  value,
  { privateDirectory = false, backup = false, expectedSnapshot } = {},
) {
  target = path.resolve(target);
  await assertNoSymlinks(target);
  const snapshot = expectedSnapshot === undefined ? await readSnapshot(target) : expectedSnapshot;
  await ensureDirectory(path.dirname(target), privateDirectory);
  if (!sameSnapshot(snapshot, await readSnapshot(target))) {
    throw new SetupError(
      'The configuration changed during setup. Nothing was overwritten; run setup again.',
    );
  }
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  let backupPath = null;
  try {
    await exclusiveWrite(temporary, `${JSON.stringify(value, null, 2)}\n`);
    if (backup && snapshot) {
      backupPath = `${target}.backup-${randomUUID()}`;
      await exclusiveWrite(backupPath, snapshot.data);
    }
    await assertNoSymlinks(target);
    if (!sameSnapshot(snapshot, await readSnapshot(target))) {
      throw new SetupError(
        'The configuration changed during setup. Nothing was overwritten; run setup again.',
      );
    }
    await fs.rename(temporary, target);
    return { path: target, backupPath };
  } finally {
    // Only our uniquely named temporary file is removed; backups are retained.
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

export async function writeTokenConfig(configPath, config) {
  return replaceJson(configPath, buildTokenConfig(config), { privateDirectory: true });
}

export async function prepareClaudeConfig(claudeConfigPath, entry) {
  const snapshot = await readSnapshot(claudeConfigPath);
  let existing = {};
  if (snapshot) {
    try {
      existing = JSON.parse(snapshot.data);
    } catch {
      throw new SetupError('Claude configuration is not valid JSON. It was not changed.');
    }
  }
  return {
    snapshot,
    merged: mergeClaudeConfig(existing, entry),
    replacingExisting: Object.hasOwn(existing.mcpServers ?? {}, SERVER_NAME),
  };
}

export async function writeClaudeConfig(claudeConfigPath, prepared) {
  return replaceJson(claudeConfigPath, prepared.merged, {
    backup: true,
    expectedSnapshot: prepared.snapshot,
  });
}

/** Raw mode disables terminal echo. Non-TTY input is rejected instead of risking exposure. */
export function readHidden(prompt, { input = process.stdin, output = process.stdout } = {}) {
  if (!(input.isTTY && output.isTTY) || typeof input.setRawMode !== 'function') {
    return Promise.reject(
      new SetupError('Run setup in an interactive terminal. Piped secret input is not supported.'),
    );
  }
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw);
    let value = '';
    let finished = false;
    const finish = (error) => {
      if (finished) {
        return;
      }
      finished = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
      value = '';
    };
    const onEnd = () => finish(new SetupError('Input ended. Setup was cancelled.'));
    const onError = () => finish(new SetupError('Could not read the token. Setup was cancelled.'));
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\x03' || char === '\x04') {
          return finish(new SetupError('Setup was cancelled.'));
        }
        if (char === '\r' || char === '\n') {
          return finish();
        }
        if (char === '\x7f' || char === '\b') {
          value = value.slice(0, -1);
        } else if (char === '\x15') {
          value = '';
        } else if (char === '\x1b') {
          return finish(new SetupError('Paste only the token, without terminal escape sequences.'));
        } else if (char >= ' ' && char !== '\x7f') {
          value += char;
        }
        if (value.length > 20_000) {
          return finish(new SetupError('The pasted token is too long.'));
        }
      }
    };
    input.setRawMode(true);
    output.write(prompt);
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    input.resume();
  });
}

export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  return {
    async ask(prompt) {
      if (!(input.isTTY && output.isTTY)) {
        throw new SetupError('Run setup in an interactive terminal.');
      }
      const reader = createInterface({ input, output, terminal: true });
      try {
        return await reader.question(prompt);
      } finally {
        reader.close();
      }
    },
    secret: (prompt) => readHidden(prompt, { input, output }),
    async confirm(prompt) {
      const answer = await this.ask(`${prompt} [y/N] `);
      return /^(y|yes)$/iu.test(answer.trim());
    },
  };
}

export async function runSetup({
  args = process.argv.slice(2),
  homeDir = os.homedir(),
  platform = process.platform,
  appData = process.env.APPDATA,
  output = process.stdout,
  prompts,
  nodePath = process.execPath,
  entryPath = ENTRY_PATH,
} = {}) {
  const options = parseSetupArgs(args);
  const say = (message = '') => output.write(`${message}\n`);
  if (options.help) {
    say('Usage: node readonly/setup.mjs [--skip-claude | --claude-config PATH]');
    say(
      'Stores tokens in ~/.config/ac-ebay/config.json after confirmation. Never pass tokens as arguments.',
    );
    say('Requires an existing eBay developer account, application, and OAuth access token.');
    say('Token-only setup: no OAuth login, new credentials, or automatic token refresh.');
    return { status: 'help' };
  }
  const ui = prompts ?? createPrompter({ output });
  const configPath = path.join(homeDir, '.config', 'ac-ebay', 'config.json');
  const claudeConfigPath =
    options.claudeConfigPath ?? defaultClaudeConfigPath({ platform, homeDir, appData });
  say('eBay read-only MCP setup');
  say(
    'Prerequisite: an existing eBay developer account and application at https://developer.ebay.com/',
  );
  say(
    'Obtain a user OAuth access token with the documented read scopes. This helper does not issue credentials, validate scopes, or refresh tokens.',
  );
  say(
    'Paste tokens only into the hidden prompts below, never into chat or command-line arguments. Setup makes no network requests.',
  );
  const environment =
    (await ui.ask('Environment [production/sandbox] (production): ')).trim() || 'production';
  if (!['production', 'sandbox'].includes(environment)) {
    throw new SetupError('Choose production or sandbox.');
  }
  const userAccessToken = await ui.secret('User access token (hidden): ');
  const appAccessToken = await ui.secret(
    'Optional application access token for public lookups (hidden; Enter to skip): ',
  );
  const config = buildTokenConfig({ environment, userAccessToken, appAccessToken });
  say(`Token file: ${configPath}`);
  say(
    'Tokens will be stored as local plaintext with file mode 0600 and folder mode 0700. An existing token file will be replaced.',
  );
  if (platform === 'win32') {
    say(
      'Windows: POSIX modes do not replace Windows ACLs. Restrict this folder to your user account.',
    );
  }
  if (
    !(await ui.confirm(
      'Save these tokens and set owner-only permissions on the token folder and file?',
    ))
  ) {
    say('Cancelled. No configuration files were written.');
    return { status: 'cancelled' };
  }
  await writeTokenConfig(configPath, config);
  say('Token configuration saved. No token values are included in Claude settings.');
  const entry = claudeServerEntry(configPath, { nodePath, entryPath });
  if (options.skipClaude || !claudeConfigPath) {
    say('Claude Desktop configuration was not changed. Add this entry to its mcpServers object:');
    say(JSON.stringify({ [SERVER_NAME]: entry }, null, 2));
    if (!(claudeConfigPath || options.skipClaude)) {
      say(
        'No supported Claude Desktop config location was detected. You may rerun with --claude-config PATH.',
      );
    }
    say('When a token expires, rerun setup with a replacement token.');
    return { status: 'saved', configPath, claudeConfigured: false };
  }
  const prepared = await prepareClaudeConfig(claudeConfigPath, entry);
  say(`Claude Desktop configuration: ${claudeConfigPath}`);
  say(
    `This will ${prepared.replacingExisting ? 'replace' : 'add'} only the ${SERVER_NAME} entry and preserve other settings and servers.`,
  );
  say('An existing Claude configuration will be backed up first with file mode 0600.');
  say(JSON.stringify({ [SERVER_NAME]: entry }, null, 2));
  if (!(await ui.confirm('Merge this entry into Claude Desktop configuration?'))) {
    say('Token configuration is saved. Claude Desktop configuration was not changed.');
    return { status: 'saved', configPath, claudeConfigured: false };
  }
  const result = await writeClaudeConfig(claudeConfigPath, prepared);
  if (result.backupPath) {
    say(`Backup saved: ${result.backupPath}`);
  }
  say('Setup complete. Restart Claude Desktop to load ac-ebay-readonly.');
  say('When a token expires, rerun setup with a replacement token.');
  return { status: 'saved', configPath, claudeConfigured: true, backupPath: result.backupPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSetup().catch((error) => {
    // Untrusted error strings can include file contents. Never print unexpected errors or token data.
    process.stderr.write(
      `${error instanceof SetupError ? error.message : 'Setup could not finish. Check file access and retry; existing backups are retained.'}\n`,
    );
    process.exitCode = 1;
  });
}
