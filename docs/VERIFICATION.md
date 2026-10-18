# Build and deployment verification

Local implementation verified 18 October 2026; deployment and database transfer verified 19 October 2026.

- TypeScript passes. All **86 automated tests** pass across domain, alarm runner, authentication, providers, MCP, browser date helpers, and database transfer.
- Production Vite build and Cloudflare Worker deployment dry run pass. Local startup profiling completed successfully.
- **25 real HTTP checks** pass on isolated SQLite Durable Object storage: CSRF, persistence, place conflicts/swap preview/commit, lifecycle guards, pages, direct learning, staged/final reviews, exact retry, final-review rejection, missing Calendar connection, MCP initialization, 47-tool discovery, and shared agent writes.
- Production-mode runtime rejects anonymous API and MCP access and publishes OAuth discovery with the required read scope and optional authorization capabilities.
- Live Open Library search, edition resolution, authors, page count, book import, and automatic cover image succeeded. No API key or cover upload was needed.
- A stopped local database copy restarted successfully and matched the original domain snapshot, including final review and entity versions.
- Separate headless Brave rendered Today, Board, Calendar, Bookshelf, Review, Settings, and Setup at **1440 px and 390 px** with no page overflow or unhandled browser exception. Rendered interaction checks passed dialog focus/Escape/return, queueing a project with its initial ticket, starting/opening it, and persisting a ticket status through its keyboard alternative.

All fixtures remained in isolated temporary stores. The normal database contains the owner's real data, separate from demonstration fixtures. Browser checks used the actual API and persisted storage; they did not fake application data in localStorage.

The production Worker and static assets deployed successfully at https://organizer.property-scraper.workers.dev. Its SQLite Durable Object and OAuth KV namespace were provisioned. The owner's local app was stopped before the final private SQLite backup. All 19 imported domain tables matched the backup SHA-256 checksum, including versions, receipts, audit history and encrypted Calendar credentials; remote foreign-key checks returned no failures. The deployed app rejects anonymous API and MCP access, reports development bypass disabled, and publishes the correct OAuth/PKCE discovery metadata.

Production Google credentials were installed privately from the downloaded client JSON. Checks confirm Google login is configured, uses the new client, redirects to the exact HTTPS callback, and requests identity-only scopes for owner login. The pinned owner subject and encryption key were preserved. Live sign-in and both calendar reconnects still require owner interaction.

The GitHub Actions workflow is prepared for checks and main-branch deployment with production concurrency and a deployed HTTP check. The owner confirmed saving the CI token and will push commits personally. The first hosted run remains pending that push; local checks do not establish a successful GitHub deployment.

Review captures with isolated test data: [desktop Board](preview/board-desktop.png) and [mobile Today](preview/today-mobile.png).

Live Google authentication, separate Personal/Work grants, real Google event changes, external MCP OAuth-client connection, physical-device touch behavior, and production recovery remain service/device checks. See [OPERATIONS.md](OPERATIONS.md) before production release. Local adapter and protocol coverage does not substitute for those live checks.
