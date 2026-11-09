# AC eBay Read-Only

A small, read-only eBay MCP for **Al and AC (Amazing Claude)**.

Forked from [YosefHayim/ebay-mcp](https://github.com/YosefHayim/ebay-mcp), based on upstream commit `3c12ea5441961d5d0ce728d8585d2c1acbd0079d`. This fork replaces the installed runtime, rather than enabling upstream's optional read-only flag.

**Status: tested prototype, not yet tested with Al's eBay account or Claude Desktop.** No eBay credentials are included, and no account has been connected. Not affiliated with eBay or Anthropic.

## What AC can do

Seven MCP tools keep the assistant's tool list small:

- `ac_find_reads`: find read operations by subject, with complete catalogue pagination.
- `ac_describe_read`: inspect required identifiers, supported query fields and scope limits.
- `ac_read`: execute an explicitly listed GET operation, one page at a time.
- `ac_active_listings`: read active listings, including ones created on the eBay website or with the legacy Trading API.
- `ac_listing`: read full details for a legacy or current listing by item ID.
- `ac_bulk_inventory`: read up to 25 inventory records in one call.
- `ac_status`: show connection presence and known limits, never credentials.

The reviewed catalogue contains **185 GET routes** across inventory, account, orders, analytics, marketing, messages, feedback, stores, notifications, finances, metadata, taxonomy, public listings and other eBay APIs. A route being catalogued does **not** mean your token/account is entitled to call it. Binary downloads are not yet returned. The three special listing/inventory tools use fixed, audited read-only POST requests because eBay's legacy Trading and bulk-read APIs require POST.

Try: “AC, show my active listings”, “Which orders are still waiting to ship?”, or “Find the read operations for traffic reports.” AC must retrieve further pages before claiming a complete list.

## Safety comes first

- There is no write tool, generic HTTP/XML tool, write-mode switch, or unrestricted URL input.
- Every request is reconstructed and checked against a fixed catalogue immediately before authentication/network access.
- API hosts are fixed to eBay production/sandbox. Redirects, proxies, custom headers and method overrides are not accepted.
- Unknown operations, path traversal and unsupported query fields fail locally.
- Automatic authentication requests only an explicit set of least-privilege scopes. It never escalates to a management scope after a failed read.
- Known configured/refreshed credentials are scrubbed throughout JSON, XML and text responses, including alternate field names. Recognized credential fields are also redacted. Arbitrary unknown secrets in seller content cannot be reliably detected.
- Trading XML acknowledgements are checked: HTTP 200 with Failure or PartialFailure is an error, not a successful result. Warnings are explicit; malformed or mismatched XML fails closed.
- Upstream publishing and automatic API-sync workflows are archived. New operations require review, not automatic inclusion.

A GET-only rule is insufficient: eBay's `getRateTables` can assign missing rate-table IDs. It is deliberately excluded. Notification destination reads expose verification tokens and are also excluded.

**Read-only software is not a universally read-only token.** eBay uses mixed read/write permissions for several read APIs. The base `api_scope` is also not a global read-only guarantee. If someone steals a broad token, they could use it outside this program. Never paste tokens into Claude, chat, GitHub, or screenshots. Read [SECURITY.md](SECURITY.md).

## Connect eBay to Claude Desktop

**Browser sign-in with automatic refresh:** use the separate local `npm run connect` helper. It opens eBay consent, then accepts the complete success-page URL in a hidden terminal prompt. It checks the session and exchanges the one-time code, asks before saving credentials, and can add the restricted server to Claude Desktop.

**There is still a developer-app prerequisite.** An activated user-owned eBay developer application, Client ID, Client Secret and OAuth RuName must already exist. This is not one-click setup for an ordinary eBay account. Start with the [OAuth setup guide](readonly/OAUTH_SETUP.md), including production activation and data-deletion compliance. No shared app secret is bundled. The helper does not create developer accounts or application keysets; it obtains OAuth tokens only after explicit consent.

Install Node.js 24 or later, then:

```sh
git clone https://github.com/vrennat/ebay-mcp.git
cd ebay-mcp
npm ci --ignore-scripts
npm run verify
npm run connect
```

The wizard shows the requested scopes and separately asks before opening consent, exchanging the code for persistent access, saving credentials, and changing Claude configuration. Passwords stay on eBay. Secrets and the callback URL are entered only in hidden local prompts, never chat or command-line arguments. The helper stores a private plaintext file (0600, directory 0700), not an encrypted vault. On Windows, also restrict the folder ACL to the account holder.

Restart Claude Desktop after setup and make a minimal authenticated read. Setup completion is not proof that the account is eligible for every route. The runtime refreshes access in memory; a revoked or expired grant requires reconnecting. Claude's config contains only an absolute Node path, this fork's absolute entry point and the private config path, never secrets. Existing settings are preserved and backed up.

**Click-to-install, existing-token alternative:** the [Desktop Extension guide](readonly/DESKTOP_EXTENSION.md) explains the `.mcpb` bundle. It uses sensitive token fields in Claude settings but does not perform browser sign-in or refresh tokens. An existing-token terminal wizard is also available as `npm run setup`. Choose one path to avoid duplicate connectors. Do not use the upstream `npx ebay-mcp` command; it launches a different, write-capable server.

## OAuth and scope coverage

Where available, use dedicated read scopes:

- `sell.inventory.readonly`
- `sell.account.readonly`
- `sell.fulfillment.readonly`
- `sell.marketing.readonly`
- `sell.analytics.readonly`
- `commerce.identity.readonly`
- `commerce.notification.subscription.readonly`

Each suffix has prefix `https://api.ebay.com/oauth/api_scope/`. Request only scopes shown for the app's keyset. The base scope is `https://api.ebay.com/oauth/api_scope`.

Optional `commerce.feedback.readonly` belongs to an **application token**, not the user token. Eligible order-earnings access uses `sell.finances.earnings.read`. These are not silently added to a default user grant.

Some read operations require mixed scopes, including general finances, disputes, messages, stores, media and logistics. Several marketing suggestions and payout settings do too. They may work with an independently authorized existing token, but this program will never request those scopes automatically. The discovery tool identifies mixed-scope operations. Pasted opaque tokens cannot be scope-verified.

The Connect helper requests base + the seven standard user read scopes above by default. You can select a smaller app-supported subset. Advanced users can add the specifically allowed `sell.finances.earnings.read` if eligible; other mixed management scopes are rejected. Runtime refresh uses exactly the configured read subset. A readonly scope is not necessarily a subset of an older management-scope grant, so fresh consent may be needed. Public application-token requests are separate and only happen when those reads are used. No Buy API eligibility is assumed. Do not enter app secrets into Claude.

[eBay authorization guide](https://developer.ebay.com/develop/guides/sell/authorization) · [Current eBay API specifications](https://developer.ebay.com/develop/apis) · [Claude local MCP setup](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

## What is not covered yet

This is broad **read coverage**, not “every eBay screen”:

- App approval, seller eligibility, marketplace rules and API retention limits still apply.
- No new asynchronous report generation, notification tests, shipping quotes or labels, messages, offers, refunds, purchases, uploads or listing changes.
- Existing binary reports/documents/labels are not returned. Responses above 8 MiB must be narrowed.
- No EU/UK Finances digital-signature support. That may prevent finance reads even with a suitable token.
- Legacy Trading wrappers currently use US site ID 0 and cover active listings and item detail only, not all historical orders, watch lists, bids or Trading message APIs. **GetMyeBaySelling has a 25,000-active-item ceiling; pagination cannot prove completeness above that ceiling.**
- Inventory reads alone do not include every website-created listing. The dedicated Trading tools fill part of that gap without migrating listings.
- Some read-only POST computations, such as compatibility searches and fee previews, are not yet implemented.
- No live-account, production OAuth, Claude Desktop installation, macOS/Windows, or full cross-marketplace verification has been performed.

## Development and provenance

```sh
npm run verify
```

Tests exercise every catalogue route with mocked transport, blocked write paths, independent wire checks, token routing/redaction (including echoed values and XML/text), scope downscoping, Trading error acknowledgements, response limits, local configuration permissions, and an in-memory real MCP client/server exchange. They do not make live eBay calls.

Only `readonly/` is the supported runtime and is included in the package allowlist. Original `src/`, `tests/`, generated schemas and archived upstream documentation remain for provenance and comparison; they are **not loaded or built by this fork**. `UPSTREAM_README.md` is historical and its setup instructions must not be used. `UPSTREAM_PACKAGE.json` and the old pnpm lockfile describe the predecessor, not this package.

The browser connection flow is tested with mocked eBay responses, not a live account. A fully hosted one-click product would need a reviewed confidential backend, secure credential storage and eBay compliance; embedding a shared client secret in a public desktop bundle is not safe.

MIT license; original attribution retained in [LICENSE](LICENSE).
