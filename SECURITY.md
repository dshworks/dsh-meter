# Security

## What this plugin touches

`dsh-meter` reads the durable session log and prices it. That half makes
no network call and needs no credential.

The optional balance reader is the only part that leaves the process:

- **One request**, `GET {baseUrl}/user/balance`, sent from the dsh host —
  never from the browser.
- **The API key is resolved per read** through the harness credential seam
  (`ctx.credentials`, falling back to the launching environment), the same
  path the LLM adapter uses. It is sent as a bearer token to `baseUrl` and
  to nowhere else.
- **The browser never receives the key.** `GET /dsh-meter/balance` returns
  parsed numbers and a currency, or an error tag.
- **Turn it off** with `balance: false` in the plugin's config; everything
  else keeps working.

Anyone who can reach the dsh Web UI can read that route, and can already
drive the agent with your key — the route exposes no capability the UI did
not already have. If you expose dsh beyond localhost, that is the decision
that matters, not this plugin.

## Reporting

Open a [private security advisory](https://github.com/dshworks/dsh-meter/security/advisories/new),
or a normal issue if the problem is not sensitive. Expect a reply within a
few days; this is a small volunteer-maintained plugin, not a product with
an on-call rotation.

Please do not include an API key, a session log, or a `.env` file in a
report — a redacted description of the behavior is enough.
