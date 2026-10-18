# Organizer

A private web app for four areas, one project place and one book place per area, Google Calendar booking, book discovery, and daily reviews. A remote MCP server exposes the same supported workflows to authorized agents.

## Run locally

Use Node 24 LTS (24.11 or newer) and npm:

```sh
npm ci
npm run build
npm run dev
```

Open **http://127.0.0.1:5173** for the Vite UI. The complete built app and API also run at **http://127.0.0.1:8787**. Data persists in `.wrangler/state`; only the four fixed areas are seeded. Stop with Ctrl+C.

Loopback development uses a local owner identity, so the core app and all 47 MCP tools work without credentials. Keep it on your computer. Deployed requests always require owner authentication. Open Library search and automatic covers need no API key; missing covers use title cards.

The supplied Figma designs are implemented with the original dark palette and self-hosted Inter. Browser and agent commands share the persisted domain rules.

## Checks

```sh
npm run check
npm run deploy:check
```

`check` runs TypeScript, domain/auth/provider/MCP tests, and the production web build. `deploy:check` bundles the Worker without deploying.

For the full HTTP smoke test, start a **fresh isolated** runtime in another terminal:

```sh
npm exec wrangler dev -- --ip 127.0.0.1 --port 8788 --var ENVIRONMENT:development --persist-to /private/tmp/organizer-http-smoke-fresh
```

Then run `node scripts/smoke.mjs`. It requires empty storage, creates test data, verifies 25 API/MCP behaviors, and refuses port 8787. Use a new persistence directory for another run. Override the URL with `ORGANIZER_SMOKE_URL` when needed. The smoke never connects Google or writes provider events.

## Google setup

1. Create a Google Cloud project, enable the Google Calendar API, and configure Google Auth Platform. Add your owner and separate Work account as test users while testing.
2. Create a **Web application** OAuth client. Register `http://127.0.0.1:8787/auth/callback` for local testing. Use a separate production client/project with `https://YOUR_HOST/auth/callback` for deployment.
3. Copy [.dev.vars.example](.dev.vars.example) to `.dev.vars`. Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `OWNER_EMAIL`. `OWNER_GOOGLE_SUB` can initially be unset; the first verified matching owner's Google subject is pinned automatically.
4. Generate `TOKEN_ENCRYPTION_KEY` with `openssl rand -base64 32` and keep it stable and private. Changing it makes stored Calendar credentials unreadable. Set `CONTACT_EMAIL` to identify Open Library requests. Never commit `.dev.vars`.
5. In Settings, connect Personal and Work separately. Personal uses `calendar.events.owned`; Work uses `calendar.events.readonly`. Both currently use that account's primary calendar. Only Organizer ticket events are changed, and Work is never written.

Owner login asks only for identity. Calendar authorization is separate. [Google documents seven-day refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration) for external apps left in Testing with Calendar scopes. Configure publishing appropriately before relying on ongoing use.

Local sign-in bypass remains active in development. Test real owner login in a separate production-mode local runtime, without the development variable override.

For local Google flows, use the built app on port 8787. If you use the Vite UI on 5173, register `http://127.0.0.1:5173/auth/callback` on the development Google client too.

## Agent connection

Point your client at `https://YOUR_HOST/mcp`, choose OAuth, sign in as the owner, and select the grant's capabilities. The consent page supports a full-control or narrower grant. Settings lists and revokes clients separately. Agents receive no Google token or database access.

On this computer only, use `http://127.0.0.1:8787/mcp` with the local owner and all application scopes. Modern SDK v2 requests and legacy `2025-11-25` initialization are supported through the normal MCP transport.

There are 47 tools, scoped resources, and five workflow prompts. Agents can inspect context, manage places/projects/books/tickets, search books, capture learnings, book time, and save final reviews. Mutations require idempotency keys and relevant expected versions. See [MCP.md](docs/MCP.md) for schemas, examples, scopes, and recovery.

## Cloudflare deployment

Production is hosted at **https://organizer.property-scraper.workers.dev**. The owner's current local database was transferred on 19 October 2026; all 19 domain tables matched the frozen backup and passed reference checks. Production Google credentials are installed as Cloudflare secrets, with the verified owner identity pinned and the original encryption key preserved. The owner must sign in and reconnect both calendars with the new Google client.

`wrangler.jsonc` identifies the production Worker, existing SQLite Durable Object namespace binding, OAuth KV namespace, and canonical HTTPS origin. Keep these identities stable across releases. Local development continues to use separate storage in `.wrangler/state`.

Set production credentials through Cloudflare secrets, independently of `.dev.vars`. Preserve the encryption key used for the imported Calendar credentials, pin `OWNER_GOOGLE_SUB` to the verified owner identity, and configure the production Google client callback as `https://organizer.property-scraper.workers.dev/auth/callback`. A different Google client requires reconnecting each Calendar account.

The [GitHub Actions workflow](.github/workflows/deploy.yml) checks pull requests and pushes to `main`. After checks pass, `main` deploys to the existing production resources and runs `npm run deploy:verify`. Deployments are serialized. The owner confirmed saving `CLOUDFLARE_API_TOKEN` in the GitHub production environment. Google credentials and the encryption key stay in Cloudflare; the pipeline never imports or resets the database. The first hosted run is pending the owner's push. Publishing remains owner-managed; no additional GitHub access is authorized for the agent.

For a manual release, run `npm run check`, `npm run deploy:check`, `npm run deploy`, and `npm run deploy:verify`. The deployment verification checks the app shell, anonymous API/MCP rejection, and OAuth discovery; it does not perform a Google login or write Calendar events.

Live owner login, actual Google event writes/reconciliation, an external MCP OAuth client, and production recovery require configured accounts and release verification. Controlled adapter/OAuth tests do not replace live-account checks. See [OPERATIONS.md](docs/OPERATIONS.md).

## Specifications

The tech lead approved the detailed baseline and implementation on 18 October 2026. User decisions take precedence over attached-document instructions.

- [Technical specification](docs/TECH_SPEC.md): architecture, integrations, interface requirements, verification, and implementation slices.
- [Decision log](docs/DECISIONS.md): approved direction, proposed product defaults, and outstanding questions.
- [Data model](docs/DATA_MODEL.md): storage entities, invariants, and transaction semantics.
- [MCP contract](docs/MCP.md): tools, scopes, schemas, resources, prompts, and agent error/retry behavior.
- [Verification record](docs/VERIFICATION.md): completed checks and remaining live release checks.
- [Original handoff](docs/reference/HANDOFF.md) and [Figma designs](https://www.figma.com/design/wdiJhqAirUq7VuQsSWdqsu).

The approved foundation is React and TypeScript on Cloudflare Workers, owner-scoped SQLite Durable Object storage, Google Calendar integration, and Open Library search with automatic covers. There is no cover upload requirement.
