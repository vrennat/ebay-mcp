#!/usr/bin/env node
/** Interactive OAuth only. This module is never registered as an MCP tool. */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { READ_SCOPES, validateConfig } from './core.mjs';
import { DEFAULT_CONNECT_SCOPES } from './oauth-connect.mjs';
import {
  SetupError,
  claudeServerEntry,
  createPrompter,
  defaultClaudeConfigPath,
  parseSetupArgs,
  prepareClaudeConfig,
  writeClaudeConfig,
  writeSecureConfig,
} from './setup.mjs';

const BASE_SCOPE = 'https://api.ebay.com/oauth/api_scope';
const ENTRY_PATH = fileURLToPath(new URL('./index.mjs', import.meta.url));
export { DEFAULT_CONNECT_SCOPES };
const USER_CONNECT_SCOPES = READ_SCOPES.filter(
  (scope) => !scope.endsWith('/commerce.feedback.readonly'),
);
export class ConnectError extends Error {}

export function parseConnectScopes(value = '') {
  if (typeof value !== 'string') {
    throw new ConnectError('Enter comma-separated scope suffixes.');
  }
  if (!value.trim()) {
    return [...DEFAULT_CONNECT_SCOPES];
  }
  const requested = value.split(',').map((part) => part.trim());
  if (requested.some((part) => !part)) {
    throw new ConnectError('A scope is missing between commas.');
  }
  const scopes = requested.map((part) =>
    part === 'base' ? BASE_SCOPE : part.startsWith('https://') ? part : `${BASE_SCOPE}/${part}`,
  );
  if (scopes.some((scope) => !USER_CONNECT_SCOPES.includes(scope))) {
    throw new ConnectError(
      'Only the documented, explicitly allowed read scopes can be requested. No write or unknown scopes are accepted.',
    );
  }
  return [...new Set([BASE_SCOPE, ...scopes])];
}

export function browserCommand(authorizationUrl, platform = process.platform) {
  let url;
  try {
    url = new URL(authorizationUrl);
  } catch {
    throw new ConnectError('Invalid eBay authorization URL.');
  }
  if (
    url.protocol !== 'https:' ||
    !['auth.ebay.com', 'auth.sandbox.ebay.com'].includes(url.hostname) ||
    url.pathname !== '/oauth2/authorize' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    [...url.searchParams.keys()].some((key) =>
      /^(code|access_token|refresh_token|client_secret)$/iu.test(key),
    )
  ) {
    throw new ConnectError('Refusing to open an unexpected authorization destination.');
  }
  if (platform === 'darwin') {
    return { command: '/usr/bin/open', args: [url.href] };
  }
  if (platform === 'win32') {
    return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url.href] };
  }
  if (platform === 'linux') {
    return { command: 'xdg-open', args: [url.href] };
  }
  return null;
}

export async function openAuthorizationUrl(
  authorizationUrl,
  { platform = process.platform, spawnImpl = spawn } = {},
) {
  const launch = browserCommand(authorizationUrl, platform);
  if (!launch) {
    return false;
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(launch.command, launch.args, {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

function validateRegisteredRedirect(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConnectError('Enter the exact registered HTTPS Accept URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    [...parsed.searchParams.keys()].some((key) =>
      /^(code|state|access_token|refresh_token|client_secret)$/iu.test(key),
    )
  ) {
    throw new ConnectError(
      'Enter the registered HTTPS Accept URL, not a completed OAuth callback or a URL containing credentials.',
    );
  }
  return value;
}

export async function runConnect({
  args = process.argv.slice(2),
  homeDir = os.homedir(),
  platform = process.platform,
  appData = process.env.APPDATA,
  output = process.stdout,
  prompts,
  oauth,
  openBrowser = openAuthorizationUrl,
  nodePath = process.execPath,
  entryPath = ENTRY_PATH,
} = {}) {
  const options = parseSetupArgs(args);
  const say = (message = '') => output.write(`${message}\n`);
  if (options.help) {
    say('Usage: node readonly/connect.mjs [--skip-claude | --claude-config PATH]');
    say('Connect your own existing eBay developer application through explicit browser consent.');
    say(
      'Client secret and full callback URL are entered only in hidden terminal prompts. Never use chat or command-line arguments for secrets.',
    );
    say(
      'Persistent refresh access and local credential storage each require confirmation. No application or shared credentials are created.',
    );
    return { status: 'help' };
  }
  const engine = oauth ?? (await import('./oauth-connect.mjs'));
  const ui = prompts ?? createPrompter({ output });
  const configPath = path.join(homeDir, '.config', 'ac-ebay', 'config.json');
  const claudeConfigPath =
    options.claudeConfigPath ?? defaultClaudeConfigPath({ platform, homeDir, appData });
  let grantMayExist = false;
  let saved = false;
  let session;
  try {
    say('Connect your own eBay developer application');
    say(
      'Prerequisite: your existing eBay developer account, application, Client ID, Client Secret, and RuName. This helper does not create credentials.',
    );
    const environment =
      (await ui.ask('Environment [production/sandbox] (production): ')).trim() || 'production';
    if (!['production', 'sandbox'].includes(environment)) {
      throw new ConnectError('Choose production or sandbox.');
    }
    const clientId = (await ui.ask('Existing Client ID (App ID): ')).trim();
    const clientSecret = await ui.secret('Existing Client Secret (hidden): ');
    const ruName = (await ui.ask('Existing RuName (eBay Redirect URL name): ')).trim();
    const defaultRedirect = engine.DEFAULT_REDIRECT_URLS?.[environment];
    say(
      'The HTTPS Accept URL must match the URL registered for this RuName exactly. A suggested URL is not proof your app is configured for it.',
    );
    const redirectAnswer = (
      await ui.ask(`Registered HTTPS Accept URL${defaultRedirect ? ` (${defaultRedirect})` : ''}: `)
    ).trim();
    const redirectUrl = validateRegisteredRedirect(redirectAnswer || defaultRedirect || '');
    say(
      `Allowed user-consent scope suffixes: base, ${USER_CONNECT_SCOPES.filter(
        (scope) => scope !== BASE_SCOPE,
      )
        .map((scope) => scope.slice(BASE_SCOPE.length + 1))
        .join(', ')}`,
    );
    const scopes = parseConnectScopes(
      await ui.ask(
        'Scopes, comma-separated suffixes (Enter for base + seven standard read scopes): ',
      ),
    );
    try {
      session = engine.createOAuthSession({
        environment,
        clientId,
        clientSecret,
        ruName,
        redirectUrl,
        scopes,
      });
    } catch {
      throw new ConnectError(
        'Could not prepare authorization. Check the existing app details, RuName, registered HTTPS Accept URL, and scopes.',
      );
    }
    // Independently guard browser launch; only the engine's fixed eBay authorization origin is accepted.
    browserCommand(session.authorizationUrl, platform);
    if (
      !Array.isArray(session.scopes) ||
      session.scopes.length !== scopes.length ||
      session.scopes.some((scope) => !scopes.includes(scope))
    ) {
      throw new ConnectError('The prepared authorization scopes do not match your selection.');
    }
    say(`Environment: ${environment}`);
    say(`Registered Accept URL: ${redirectUrl}`);
    say('Exact requested scopes:');
    for (const scope of session.scopes) {
      say(`  ${scope}`);
    }
    say(
      'eBay authorization grants ongoing access until expiry or revocation. The base scope is not a guarantee that a token can only perform reads outside this restricted server.',
    );
    say(
      'If you later save, your existing Client Secret and new refresh token will be stored as local plaintext (0600 file, 0700 folder). Anyone who obtains them may misuse that access.',
    );
    if (
      !(await ui.confirm(
        'Does this exactly match the RuName Accept URL, and may I open eBay authorization for these scopes?',
      ))
    ) {
      say('Cancelled before opening authorization. No configuration was written.');
      return { status: 'cancelled' };
    }
    grantMayExist = true;
    let opened = false;
    try {
      opened = await openBrowser(session.authorizationUrl, { platform });
    } catch {
      /* Manual authorization remains possible. */
    }
    if (!opened) {
      say('The browser could not be opened. Open this authorization URL in your own browser:');
      say(session.authorizationUrl);
    }
    say(
      'In your browser, review eBay permissions and approve only if they match your intent. Then copy the complete final redirect URL.',
    );
    say(
      'Paste that URL only into the hidden prompt below. It contains a one-time authorization code; never send it in chat.',
    );
    const callbackUrl = await ui.secret('Full final callback URL (hidden): ');
    say(
      `Code exchange sends your app credentials and authorization code to https://${environment === 'sandbox' ? 'api.sandbox.ebay.com' : 'api.ebay.com'}/identity/v1/oauth2/token.`,
    );
    if (
      !(await ui.confirm(
        'Exchange the code with eBay to obtain persistent refresh access for this app?',
      ))
    ) {
      say('Code exchange cancelled. No configuration was written.');
      return { status: 'cancelled' };
    }
    let exchanged;
    try {
      exchanged = await session.exchangeCallback(callbackUrl);
    } catch {
      throw new ConnectError(
        'Callback validation or code exchange failed. Check the full callback URL, app settings and session expiry, then start again. No tokens were saved.',
      );
    }
    let config;
    try {
      config = validateConfig(exchanged.config);
    } catch {
      throw new ConnectError('eBay returned an unusable configuration. Nothing was saved.');
    }
    if (
      config.environment !== environment ||
      config.clientId !== clientId ||
      config.clientSecret !== clientSecret ||
      !config.refreshToken
    ) {
      throw new ConnectError(
        'The returned configuration did not match this app and persistent grant. Nothing was saved.',
      );
    }
    say('eBay authorization completed. No credential values will be displayed.');
    say(
      exchanged.scopeSource === 'eBay token response'
        ? 'Scope confirmation: eBay returned the following allowed scope subset.'
        : 'Scope confirmation: eBay did not echo granted scopes; retaining the requested scopes, not claiming token introspection.',
    );
    for (const scope of config.scopes) say(`  ${scope}`);
    if (config.refreshTokenExpiresAt)
      say(`Refresh access expires: ${config.refreshTokenExpiresAt}`);
    say(`Local token file: ${configPath}`);
    say(
      'Saving stores the Client ID, Client Secret, refresh token and scope settings locally, replacing any existing token configuration. File mode is 0600; folder mode is 0700.',
    );
    if (platform === 'win32') {
      say(
        'On Windows, also restrict the token folder ACL to your own user account; POSIX modes do not enforce Windows ACLs.',
      );
    }
    if (
      !(await ui.confirm(
        'Save this persistent grant and app credentials to the private local configuration file?',
      ))
    ) {
      say('Authorization was not saved. No local configuration files were written.');
      return { status: 'authorized-not-saved' };
    }
    await writeSecureConfig(configPath, config);
    saved = true;
    say(
      'Private configuration saved. The local server can refresh access until the grant expires or is revoked.',
    );
    const entry = claudeServerEntry(configPath, { nodePath, entryPath });
    if (options.skipClaude || !claudeConfigPath) {
      say(
        'Claude Desktop configuration was not changed. Add this entry to its mcpServers object if needed:',
      );
      say(JSON.stringify({ 'ac-ebay-readonly': entry }, null, 2));
      return { status: 'saved', configPath, claudeConfigured: false };
    }
    const prepared = await prepareClaudeConfig(claudeConfigPath, entry);
    say(`Claude Desktop configuration: ${claudeConfigPath}`);
    say(
      `This will ${prepared.replacingExisting ? 'replace' : 'add'} only ac-ebay-readonly, preserving other settings and backing up an existing Claude configuration. No secrets are included in this entry.`,
    );
    say(JSON.stringify({ 'ac-ebay-readonly': entry }, null, 2));
    if (!(await ui.confirm('Merge this server entry into Claude Desktop configuration?'))) {
      say('Private credentials are saved. Claude Desktop configuration was not changed.');
      return { status: 'saved', configPath, claudeConfigured: false };
    }
    const result = await writeClaudeConfig(claudeConfigPath, prepared);
    if (result.backupPath) {
      say(`Claude configuration backup: ${result.backupPath}`);
    }
    say('Connection setup complete. Restart Claude Desktop to load ac-ebay-readonly.');
    return { status: 'saved', configPath, claudeConfigured: true, backupPath: result.backupPath };
  } finally {
    session?.cancel?.();
    if (grantMayExist && !saved) {
      say(
        'If you approved access on eBay, cancelling here or declining to save does not revoke that access. Revoke this app in your eBay account settings if you do not want to keep the grant.',
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runConnect().catch((error) => {
    process.stderr.write(
      `${error instanceof ConnectError || error instanceof SetupError ? error.message : 'Connection setup could not finish. Check local file access and try again. No callback or credential values were printed.'}\n`,
    );
    process.exitCode = 1;
  });
}
