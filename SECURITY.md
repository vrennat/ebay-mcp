# Security boundary

The supported server is `readonly/index.mjs`. Its seven tools have no account-mutating operation. The old upstream source is reference material only; its write APIs and optional read-only switch are not loaded by the supported runtime.

## Enforcement

1. Reviewed, frozen route catalogue. No runtime generation from names, annotations or a remote spec.
2. Validated path/query inputs. No caller-supplied URL, verb, headers, XML or arbitrary JSON body.
3. Independently reconstructed canonical request at the network boundary. Unknown destinations, altered bodies, token-routing changes, encoded traversal and write verbs fail closed.
4. Fixed HTTPS eBay API origins, no redirects or proxy/base-URL setting.
5. Exactly three business-read POST shapes: Inventory bulk_get_inventory_item, Trading GetItem, Trading GetMyeBaySelling. Fixed XML call names and payload construction. OAuth POSTs are internal token lifecycle operations, not business actions or MCP tools.
6. Explicit scope allowlist on refresh/client-credential requests, and validation of scope strings returned by eBay when present. No retries with wider privileges.
7. 30-second deadlines, 8 MiB response cap, no automatic report downloads, no remote MCP listener.

## Residual risk and honest limits

- The base eBay scope and some existing tokens may allow writes outside this process. A process-level boundary does not protect a stolen credential or malicious edits to the installed code.
- eBay can change endpoint behavior. GET semantics were reviewed, including the exclusion of `getRateTables` because it may assign IDs. Re-review the allowlist when updating eBay specs.
- The user-token setup cannot introspect opaque eBay tokens or establish their granted scope. Existing broad tokens remain broad. Mixed-scope routes are catalogued for power-user visibility but not automatically authorized.
- Returned business data is sent to the selected MCP client/model when a tool is used. Listings/messages can contain prompt injection. The server labels results as untrusted data; that is not a guarantee of model behavior.
- Account data can include customer contact information and financial business information. Share results only when intended and consistent with eBay data handling requirements.
- Local JSON credentials are plaintext in a private file. Prefer Claude Desktop Extension sensitive settings where supported. A compromised user account/computer remains able to access credentials.
- Binary payloads are not yet supported, signature-required finance reads may fail, and not every eBay read endpoint is implemented. No live-account validation has been performed.

## Review before distribution

Run `npm ci --ignore-scripts` and `npm run verify`. Confirm `npm pack --dry-run` includes only the new runtime. Never publish tokens or `.env` files. Do not enable inherited upstream auto-sync/release workflows. Do not run the upstream setup command or install the upstream npm package as a substitute.

Before Al uses a production account, validate in sandbox and then perform a supervised minimal production read with credentials entered locally by the account holder. Inspect the actual consent screen, scopes, token expiry, legacy listing coverage, pagination and data privacy expectations. A test suite with mocked network calls does not replace this step.
