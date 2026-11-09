# Install AC eBay Read-Only in Claude Desktop

This is an **unofficial, local, read-only** eBay connector. It is not affiliated with eBay or Anthropic. The `.mcpb` bundle contains the restricted server and its installed JavaScript dependencies. It does not include the original project's write-capable server.

## What you need

- Claude Desktop for macOS or Windows with Desktop Extensions enabled and a compatible bundled Node runtime (Node 24 or newer). If your organization blocks custom extensions, ask its administrator.
- Your own existing [eBay developer account](https://developer.ebay.com/), application, and OAuth user access token for the selected environment.
- Optionally, an existing application access token for public API lookups.

Use the read scopes and limitations in the repository's main README. An ordinary eBay sign-in is not an API access token. This installer does not create an application, issue credentials, log in to eBay, or refresh expired tokens. It does not implement a localhost OAuth callback.

## Install a prepared bundle

1. Open the `.mcpb` file with Claude Desktop. Alternatively, drag it into Claude Desktop's Settings window.
2. Review the extension and click **Install**. The local build is unsigned; install it only if you trust and have reviewed its source.
3. Enter the user access token in **eBay user access token**. Enter the optional application token only if you have one.
4. Keep **eBay environment** as `production` for your real account, or enter `sandbox` for test-account tokens. Tokens must match the environment.
5. Enable the extension, then ask Claude to check `ac_status` and read one page of your active listings. Status checks show configured credential presence, not proof that eBay accepts the token. An authenticated read is needed to verify access.

Never paste tokens into a chat. The manifest marks token fields `sensitive: true`; Claude Desktop documents secure storage for these fields. It supplies tokens to the local server through its process environment, not command-line arguments or the manifest. Do not share environment dumps or token-bearing screenshots.

When a token expires, replace it in the extension's settings. If Claude reports an unresolved extension setting, reopen those settings; do not work around it by posting credentials into chat. Read responses may include private account or buyer data. Ask only for information you intend to share with your AI client.

The default marketplace and language are `EBAY_US` and `en-US`. This bundle uses the seven restricted `ac_*` tools, including the audited Trading reads needed for listings created on eBay's website. Available data still depends on eBay permissions, supported APIs, and pagination; read-only does not mean complete account coverage.

## Build the bundle locally

From the repository root, after installing the project's locked dependencies through its normal workflow:

```sh
node --test readonly/*.test.mjs
node readonly/build-mcpb.mjs
```

The builder requires Node 24+ and the system `zip` command. It performs no installs, downloads, package scripts, or publication. It copies only the read-only source allowlist, license, documentation, and the actual installed production/required-peer dependency closure of the MCP SDK, Zod and XML parser. Package directory links are resolved; symlinks and special files inside copied packages are refused. Different dependency versions retain the required nested resolution.

The output defaults to `readonly/dist/ac-ebay-readonly-0.2.0.mcpb`. To choose another new output file:

```sh
node readonly/build-mcpb.mjs /absolute/path/ac-ebay-readonly.mcpb
```

Existing output files are never overwritten. The build refuses more than 64 MiB of copied input or 15,000 files. A successful archive build and stdio smoke test do not prove a Claude Desktop installation or live eBay login works; verify those on the intended computer. No automatic update source is configured.

The manifest was checked against the official MCPB v0.3 schema when added. Revalidate changes using the official tooling before distribution. Do not run a general `mcpb pack` from this repository root: it may include the original server and unrelated files instead of the restricted bundle.

## Browser sign-in alternative

For an existing developer app with an OAuth RuName, the separate [Connect eBay helper](OAUTH_SETUP.md) opens consent in your browser and saves refresh access after explicit confirmation. It can configure Claude as a normal local MCP server. That flow uses a private plaintext credential file and is not integrated into these extension settings. Choose one installation path; disable the token-only extension if switching to the refresh-enabled local server.

## Terminal fallback

If you prefer a manually configured local MCP server:

```sh
node readonly/setup.mjs
```

That separate helper prompts for tokens without echo, asks before saving `~/.config/ac-ebay/config.json`, and separately asks before merging a Claude Desktop server entry. It writes a private token file (0600) in a private folder (0700); on Windows, ensure the folder's ACL also restricts access to your account. It preserves other Claude settings and backs up an existing Claude config. It does not need to run when using the extension's token fields.

## Verified format references

- [Anthropic's Desktop Extensions guide](https://www.anthropic.com/research/desktop-extensions)
- [Official MCPB manifest specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)
- [Official MCPB v0.3 JSON schema](https://github.com/modelcontextprotocol/mcpb/blob/main/schemas/mcpb-manifest-v0.3.schema.json)

The extension uses `server.type: node`, `command: node`, `${__dirname}/index.mjs`, and `${user_config.*}` environment substitution as documented. A fixed `AC_EBAY_CONFIG_SOURCE=desktop-extension` marker enables this narrowly scoped environment configuration; an explicit `--config` file takes precedence.
