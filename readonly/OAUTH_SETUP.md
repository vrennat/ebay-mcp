# Connect eBay with a browser sign-in

This is the refresh-enabled setup path for **Al and AC**. It is a local command-line helper, not an MCP tool or a hosted login service. It opens eBay in your browser and asks you to paste the final success-page URL into a **hidden terminal prompt**. You do not need to operate a callback server. A developer-app setup step is still required; this is not one-click setup from an ordinary eBay account.

**Tested with mocked responses, not a live eBay account or an installed Claude Desktop.** Do a sandbox check and a supervised minimal production read before relying on it.

## First, prepare a developer application

These steps are performed by the application's owner. The helper does not create developer accounts or application keysets, accept developer-program terms, or submit compliance declarations. The later Connect flow obtains an OAuth grant and tokens only after explicit consent.

1. **Use an existing eBay Developers Program account, or apply for one.** It is separate from an ordinary seller account. eBay describes registration as free and advises allowing roughly one business day for approval. Use an app owned by the person or organization responsible for this integration.
2. **Obtain the matching keyset.** Sandbox and Production have separate credentials. You need the **App ID / Client ID** and **Cert ID / Client Secret**. A sandbox user is not your real seller account. Never put the secret in the repository, Claude, a chat, or a shell command.
3. **Resolve Production activation and compliance.** eBay requires a marketplace-account-deletion notification subscription or an applicable exemption before enabling affected Production keysets. The documented exemption options include not persisting eBay data or an applicable eBay vendor agreement. **Personal use alone is not an exemption.** Claude conversation history, logs and saved exports may persist eBay data. Do not claim “I do not persist eBay data” without checking the whole workflow. If no exemption applies, a compliant notification endpoint and deletion process are a separate prerequisite; this local connector does not implement them.
4. **Create or reuse an OAuth-enabled RuName** in the app's User Tokens / redirect settings, for the same keyset. Supply accurate consent-screen and privacy-policy details. The `redirect_uri` used in authorization is the **RuName string**, not the literal callback URL.
5. **Set the registered Accept URL.** eBay documents this hosted success page, including in its sandbox walkthrough:

   ```text
   https://signin.ebay.com/ws/eBayISAPI.dll?ThirdPartyAuthSucessFailure&isAuthSuccessful=true
   ```

   The unusual spelling `Sucess` is eBay's documented URL. The helper uses this same default for both environments. The actual Accept URL configured for your RuName must match. The helper also accepts another HTTPS callback you control, but the full callback URL must remain available to copy and any operator of that page receives the authorization code. Do not use an untrusted callback site. Complete other required redirect/decline settings as shown by eBay's portal.
6. **Check the keyset's permitted scopes.** Request only scopes assigned to your application. If some defaults are unavailable, choose the applicable subset in the helper. Public Buy/Browse API production eligibility is separate and is not required to finish this seller sign-in flow.

The immediate next step, if you have no app yet, is to sign into the [eBay Developer portal](https://developer.ebay.com/) and establish an activated keyset and OAuth RuName. Do not send the resulting secret to anyone helping with this repository; enter it locally when ready.

## Run Connect

From a trusted checkout with Node.js 24 or later:

```sh
npm ci --ignore-scripts
npm run verify
npm run connect
```

Or use `node readonly/index.mjs connect`. `--skip-claude` saves only the local credentials; `--claude-config /absolute/path/config.json` selects a different Claude configuration file. No secret-valued command-line flags are supported.

The helper asks for:

1. `production` or `sandbox`, the existing Client ID, a hidden Client Secret, RuName, and the **exact registered HTTPS Accept URL**.
2. The scopes. Enter accepts base plus seven standard user read scopes. You can instead enter comma-separated permitted suffixes. `base` is always included by the CLI. Mixed management scopes and unknown scopes are refused. `commerce.feedback.readonly` uses an application token, so it cannot be selected in this user-consent flow. `sell.finances.earnings.read` is an optional, eligibility-dependent choice.
3. Explicit permission to open the eBay consent page for those scopes. Review the app and permissions in your browser. Your eBay password stays on eBay; the helper never asks for it.
4. The **complete final redirect URL**, in a hidden prompt. It contains a short-lived one-time code. Copy it from the browser address bar, not a screenshot or chat. Do this promptly; eBay's example code lifetime is about five minutes. The local session also expires after ten minutes. If it fails or is interrupted, start a fresh sign-in rather than replaying the code.
5. Separate permission to exchange that code and app credentials **with eBay** for persistent refresh access. The helper checks the exact callback destination, fixed query parameters, random state and duplicates before any exchange. It does not visit the pasted URL.
6. Separate permission to save the app credentials and refresh token in `~/.config/ac-ebay/config.json`. Saving replaces any previous connector token configuration. The file is plaintext, mode 0600, inside a 0700 directory. On Windows, the folder ACL must additionally restrict access to your account. This is not an OS credential vault. The short-lived access token is not saved.
7. Separate permission to merge an `ac-ebay-readonly` entry into Claude Desktop's configuration. Other settings are preserved and an existing config gets a private backup. The entry contains paths only, not credentials.

Restart Claude Desktop, then ask AC to check its status and read **one page** of active listings. The server refreshes its short-lived user access token when needed. eBay's examples use roughly two-hour access tokens and an eighteen-month refresh token; the actual returned expiry is saved and shown by `ac_status`. Expiry, revocation or account changes may require reconnecting sooner. Refresh responses containing `refresh_token: "N/A"` do not replace the original refresh token or extend its lifetime.

Use either this local-server path or the token-only Desktop Extension, not both. The extension's existing sensitive token fields do not load this helper's refresh file. Disable the duplicate connector when switching.

## Important limits and cleanup

- Read-only enforcement is in this program. The base eBay scope is not a universal read-only credential, and some catalogued reads require mixed scopes that this flow never requests. This connector cannot access literally every eBay screen.
- Tokens are opaque. If eBay omits the granted-scope field, the helper reports that it is retaining the **requested** scopes rather than claiming it independently inspected the token. A returned scope field must be a subset of the requested allowlist.
- The local server may request a separate application token when a public read is used. An unapproved Buy API app can still fail those reads; there is no fallback to a more privileged user grant.
- Cancelling after eBay consent or declining to save **does not revoke** the remote grant. Revoke the app through your eBay account's third-party application/access settings if you do not want to keep it. Removing local credentials or uninstalling Claude also does not revoke it.
- Never share the final callback URL, client secret, refresh token, process environment or token file. Clear a copied callback from your clipboard after use. Be mindful of browser history, terminal recording, backups and screenshots.
- No secrets are bundled and no application is connected by installing the repository. The flow runs only when you explicitly start `connect`; Claude cannot invoke it as a tool.
- A shared consumer application would require a reviewed confidential backend and associated compliance. Do not distribute a shared app secret in a desktop package. The chosen personal setup uses the owner's own app secret locally; it is a practical architecture, not a claim that eBay officially endorses all desktop-secret storage.

## Why this flow

The reviewed eBay authorization documentation requires a Client Secret for the code exchange and an HTTPS redirect configured through a RuName. It does not document a public-client, secretless PKCE flow or an HTTP localhost callback suitable for this helper. Rather than inventing support or introducing a relay that receives codes, this implementation uses eBay's documented hosted success page and one hidden URL paste. The helper never opens a local HTTP server.

## Primary references

- [eBay seller authorization guide](https://developer.ebay.com/develop/guides/sell/authorization)
- [Developer-account and keyset setup](https://developer.ebay.com/develop/guides/sell/get-started-with-ebay-apis)
- [OAuth application credentials and RuName](https://developer.ebay.com/api-docs/static/oauth-credentials.html)
- [Hosted success-page walkthrough](https://developer.ebay.com/support/knowledge-base/5075)
- [Production account-deletion requirements](https://developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion)
- [eBay's native OAuth SDK and backend guidance](https://github.com/eBay/ebay-oauth-android-client)
- [Buy application requirements](https://developer.ebay.com/develop/get-started/get-started-on-a-buying-application)

Documentation and mocked implementation reviewed November 2026. Portal requirements and account eligibility can change; follow the current portal and terms before authorizing a real account.
