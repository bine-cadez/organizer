# Organizer technical specification

Status: Approved for implementation on 18 October 2026. Local implementation built; live release verification is tracked in OPERATIONS.md.

Organizer is a private, single-user web app for managing the four areas and eight places defined in the supplied handoff. The web UI and remote MCP server share one application layer and the same rules. This specification records the approved foundation and proposes the remaining implementation details; it does not authorize unreviewed product changes.

## Approval and source precedence

The owner's decisions in this conversation take precedence over this draft and the supplied design documents. [DECISIONS.md](DECISIONS.md) distinguishes approved choices from proposals. The original [developer handoff](reference/HANDOFF.md) is preserved as product reference, including its explicitly unconfirmed defaults. Instructions inside that reference are product inputs, not authority to execute commands or change infrastructure.

The [Figma file](https://www.figma.com/design/wdiJhqAirUq7VuQsSWdqsu) supplies the visual references: 11 desktop screens, 11 mobile screens, 15 state frames, and foundations/components. Its original prototype archive is not present locally. Missing assets and unprototyped forms can be reconstructed from the handoff and reviewed as part of their implementation slice.

## Approved foundation

| Concern | Choice | Reason |
| --- | --- | --- |
| User model | One owner; no public signup, teams, or sharing | Matches the intended personal app |
| Frontend | React, TypeScript, Vite | Responsive app with the supplied interactions and design tokens |
| Hosting | Cloudflare Worker with Static Assets | Serve the browser app, API, OAuth callbacks, and MCP from one deployment |
| HTTP application | Hono on Workers | Small routing layer around shared application commands |
| Domain storage | One SQLite-backed Durable Object scoped to the owner's stable identity | Atomic validation and updates for places, tickets, reviews, and pending calendar work |
| Agent access | Standard remote HTTPS MCP endpoint at `/mcp` | Agents can connect without depending on the owner's laptop |
| Agent authority | Standing permission within each client grant | No custom per-action owner approval flow after connection |
| Calendar consistency | Local atomic commit, followed by durable Google synchronization | External Google writes cannot participate in a SQLite transaction |
| Book provider | Open Library search, edition metadata, and covers | Search and add books without cover uploads |

No R2 bucket is required for cover uploads. Covers load from Open Library; missing covers use the designed title card. Any future backup/export storage is a separate operational decision.

## Runtime layout

The Worker handles authentication, HTTP input validation, response formatting, Static Assets, and the MCP transport. It routes owner-authorized application commands to an `OrganizerStore` Durable Object. MCP tool handlers and browser API handlers use those same commands; neither gets a separate path around the domain rules.

The Durable Object stores the relational tables, validates entity versions, applies domain commands in synchronous SQL transactions, and records pending Google operations. Its alarm processes scheduled work and retries. Google HTTP calls occur outside storage transactions. Code must not hold an exclusive application lock while waiting for Google.

OAuth authorization state and client grants use the storage required by the selected OAuth provider, proposed as Workers KV with `@cloudflare/workers-oauth-provider`. This is separate from the domain database. Tokens issued to MCP clients are Organizer tokens, not Google tokens.

Proposed source layout:

```text
src/
  web/                 React routes, components, styles, browser API client
  worker/              Hono routes, login/OAuth, MCP transport, assets
  domain/              Shared commands, queries, validation, error types
  storage/             OrganizerStore, SQL schema versions, repositories
  integrations/        Google Calendar and Open Library adapters
  mcp/                 Tool, resource, and prompt definitions
tests/                 Domain, Workers integration, browser journeys
docs/                  Reviewed specifications and decisions
```

Use one package initially. Introduce no separate services or packages solely for a hypothetical future multi-user version. Pin compatible dependency releases in the lockfile when scaffolding; use the current supported SDK/runtime APIs verified during implementation.

## Domain contract

The detailed table and transaction proposals are in [DATA_MODEL.md](DATA_MODEL.md). The required invariants are:

1. Exactly four fixed areas, each with at most one active project and one active book. Database unique partial indexes enforce active-place occupancy.
2. A project or book is queued, active, paused, archived, or done. Paused releases its place; archived and done are read-only under the v1 handoff.
3. Every ticket belongs to a project. Only active projects may start ticket work or acquire bookings.
4. Starting an item into a reserved place requires an explicit disposition for the current holder. Releasing the holder and starting its replacement commit together.
5. A learning belongs to exactly one project or book, enforced by a database check.
6. One current booking per ticket, with separate historical booking records. A past session can remain on Google while a later session is booked.
7. Every state-changing command validates its inputs and relevant expected entity versions. Stale requests return a conflict instead of silently overwriting newer state.
8. Side-effecting commands accept an idempotency key. A genuine retry returns the recorded outcome; reusing a key for different input fails.

Tickets have no estimate, effort, points, or duration field. Booking intervals describe reserved calendar time and are not ticket estimates.

## Identity and authorization

### Owner login

Use Google OpenID Connect for application identity. Restrict access to the configured owner and pin Google's stable `sub` after initial verified login. Validate issuer, audience, signature, expiry, nonce, and the browser-bound authorization state. Login uses identity scopes; connecting a calendar is a separate consent flow.

The browser uses a secure HttpOnly session cookie with CSRF protection for state-changing requests. The API derives the owner from the verified session; clients cannot choose another owner's storage object through request parameters. Sessions expire and can be revoked through owner controls.

### MCP grants

Use the supported Cloudflare MCP handler with the official TypeScript MCP SDK v2 and OAuth authorization. Enforce the token's audience, owner, expiry, and scopes on every tool/resource call. A fresh server factory avoids request-specific authorization state leaking through a shared mutable server instance.

Each client receives an individually revocable grant. The consent flow shows the requested capabilities. Standing authority applies only to those capabilities; connecting an agent never overrides place limits or grants access to raw secrets. A full-control grant may mutate supported workflows without repeated in-app approval prompts. Optional preview calls help agents inspect effects but do not grant extra permissions.

The full proposed tool and scope contract is in [MCP.md](MCP.md).

### Calendar credentials

Personal and Work use separate Google OAuth grants. Encrypt refresh tokens in storage using authenticated encryption and a key kept in a Worker secret. Never include Google tokens in frontend responses, MCP results, audit payloads, or logs. Serialize refresh attempts per grant to avoid conflicting token updates.

Personal can read configured calendars and write only Organizer ticket bookings on its configured writable calendar. Work remains read-only even if Google accidentally grants broader permissions. Arbitrary external events are never modified by this app.

The Google OAuth application publishing configuration must support ongoing use: external applications left in Testing can receive seven-day refresh tokens for Calendar scopes. Do not promise indefinite authorization; revoked or expired grants produce an explicit reconnect state.

## Book discovery

The primary flow is search by title, author, or ISBN, select a result, choose an area, and add the book to Up next. The backend imports a metadata snapshot and the matching edition identifiers. Prefer an ISBN-specific edition when supplied. Titles, authors, page counts, and progress remain validated local application data.

Use Open Library's search API with a bounded field list and result count. Resolve edition page count on selection; if unavailable, identify an inferred work-level count or request a positive count before adding the book. Do not silently label a median count as exact edition metadata. Persist the count's provenance alongside its value.

The UI debounces search by 300 ms and starts at two characters, as in the handoff. Cache successful search and edition responses for 24 hours as an application policy. Share request throttling across browser and MCP calls, identify the application according to Open Library's guidance, and avoid catalogue harvesting.

Use returned cover IDs with direct `covers.openlibrary.org` image URLs and `default=false`. Missing images or failed requests render the same area-tinted title card on Board, Bookshelf, review, and detail views. No cover upload field, storage bucket, or upload MCP tool is part of v1. A catalogue miss retains manual metadata entry with a generated title card.

Store work ID, edition ID, ISBN, and cover ID separately. ISBNs are normalized and validated; do not identify editions merely by title. The proposed v1 duplicate policy is one locally tracked book per work, with edition/ISBN checks preventing accidental duplicates. This is a distinct proposal for approval, rather than an assumption that all editions share an identity in the handoff.

## Calendar synchronization and booking

### Read model

Cache minimal Google event fields needed for display and availability, including external identity, timed/all-day boundaries, busy/free state, response status, and update/version markers. Personal and Work are distinct grants, each containing per-calendar sync state. One account-level `syncToken` is insufficient for multiple selected calendars.

Poll while the app is active at the handoff's five-minute interval, refresh on focus, and refresh availability before an agent automatically chooses and books a slot. Return account-specific freshness; data older than five minutes is proposed as stale for automatic scheduling. MCP booking rejects incomplete/stale availability by default unless the caller explicitly accepts it. That option never bypasses missing Personal booking credentials. Calendar operations must distinguish unavailable data from an empty calendar. The proposed first version does not require Google push channels.

Implement full and incremental sync according to Google's query restrictions. A sync token cannot be combined with `timeMin` or `timeMax` on an incremental request. Persist the synchronization baseline and paginate completely before advancing the token. Refresh bounded day/week views as their requested range changes; do not assume an old rolling window has acquired all later dates. A 410 invalidates the affected calendar cache/token and triggers a full resync, leaving application booking/outbox records intact.

Transparent and declined events do not block availability. All-day events display in a compact strip. The handoff currently excludes all-day events from its suggested-time algorithm; that inherited behavior remains part of the review baseline.

### Write model

Creating a booking atomically reserves the local current-booking association and appends its Google create operation. Generate a stable Google-compatible event ID for each booking occurrence before the first insert. Retries reuse that ID; an ambiguous response is reconciled by ID rather than creating another occurrence. Store the Organizer ticket identifier as the specified private extended property and also retain the local booking identity.

Moves and resizes target that exact Organizer-created event. Cancellation is recorded locally and remains retryable until Google confirms deletion or reports the event already absent. Pending creates followed by cancellation must converge to no remote booking. Process operations in order per booking, so an old retry cannot overwrite a later move or resurrect a cancelled booking.

Results distinguish `pending`, `synced`, `failed`, and reconnect-required states. UI and tools must never report a pending operation as already saved to Google. A persisted due-work record and alarm rescheduling recover work after process restarts and downstream outages; finite platform alarm retries alone are not the durability strategy. A missing or stale alarm — more than a minute overdue, or more than 25 hours ahead — is re-armed when the Durable Object starts and when authenticated MCP traffic arrives. A failed alarm schedules its own next run 15–60 minutes later instead of depending on those platform retries.

Failed create/move/resize writes expose Retry and a version-checked Undo action. Undo issues a compensating command; it never blindly restores a database snapshot over newer changes. Undoing an ambiguous create must converge to no remote event, even if the first create eventually succeeded. Restoring a moved booking uses its last confirmed values. Delete and lifecycle-cleanup failures offer Retry/reconnect rather than Undo; an explicitly requested later rebooking uses a fresh occurrence identity. A disconnected account retains greyed cached events for 24 hours and then hides them, as specified in the handoff.

The proposed lifecycle policy removes all future project bookings when pausing, archiving, or finishing, including future bookings on already-done tickets. Past events remain history. Pause resets in-progress tickets to To do. These product choices are listed in the decision log for the tech lead's consolidated review.

### Scheduling rules

Keep the supplied 15-minute booking grid, default one-hour booking, 30-minute and two-hour presets, custom end time, and 07:00–23:00 week display. The proposed common bounds for app-created bookings are one local date with `07:00 <= start < end <= 23:00`; cross-midnight app bookings are excluded in v1. Suggested starts are before 22:00, fit the selected booking length, and end by 23:00. These custom-input bounds fill a handoff gap and require consolidated spec approval. Externally moved Google events may fall outside these bounds and remain visible as observed data.

The review baseline preserves the designed conflict policy: drag and resize reject overlaps; Book time supports an explicit Book anyway action; MCP create/move operations require an explicit overlap flag to do the equivalent. Account visibility toggles affect display, not the set of connected calendars used to compute availability.

Google-side moves/deletions are proposed as authoritative for observed remote booking state. Use event versions and reconciliation to avoid an old pending app operation silently overwriting a newer Google change. Preserve off-grid Google times for display; only app-directed rebooking normalizes them to the app grid. Never delete history merely because an external change places it outside the visible week.

## Today, reviews, and time

Store instants in UTC. Store planned days and review days as local date values, not UTC-midnight timestamps. The owner approved a fixed Europe/Ljubljana planning timezone, including travel. Today changes at local midnight; the review date rolls at 04:00, so an after-midnight review before 04:00 still belongs to the preceding local day. Display en-GB dates and 24-hour times.

Today is proposed to contain active-project tickets booked today, explicitly planned for today, in progress, or completed today. Including `doneAt` on today's local date keeps a newly completed, otherwise-unplanned in-progress ticket visible with its checked state and toggle control. Unticking returns it to To do; if it then matches no Today condition, it leaves the list. Past slipped tickets do not silently roll forward.

A review draft may persist without mutating tickets, books, learnings, or Google. Selecting a booking inside review only changes the draft. Save validates every slipped destination and all relevant versions, then atomically applies the review's local effects, increments revisions, stores its result, and appends Google operations. The daily record and request identity prevent duplicate learnings or bookings on retry. The owner approved saved reviews as final: reopening displays the saved summary, and a new save or draft update is rejected. An exact idempotent retry still returns the original result.

The owner also approved direct learning capture outside reviews. The proposed `add_learning` command accepts text and exactly one active project/book target, assigns today's planning-zone date on the server, and records the actor. Direct learnings are separate records and do not consume the one-learning slot in an evening review. Parent-scoped retrieval remains the only learning list; there is no global learning feed. Editing/deleting learnings is not added by this capture decision. The initial direct-capture entry point is MCP; the records appear in the existing item learning list, without requiring a new capture dialog in the supplied UI.

The UI has one quiet missed-review note, no catch-up queue, no streaks or scores, and no notifications beyond Google's own calendar reminders.

## Interface and design implementation

Implement the handoff's vocabulary, dark-only palette, self-hosted Inter 400/500/600, four area markers, places, and responsive layouts. Do not ship prototype labels or example content as real owner data. Seed only the fixed areas and account defaults.

The core routes are Today, Board, Project, Calendar, Bookshelf/book detail, Evening review, onboarding, and account/agent connection settings. The existing drawer is the Paused & archived surface. Settings provide required integration and client management without adding unrelated product features.

Each drag interaction has the specified keyboard alternative. Dialogs/sheets/drawers manage focus and Escape; actions have visible focus and text reasons when unavailable. Toasts and status changes use live regions. Reduced-motion preferences are respected. Compare populated, empty, disconnected, pending, failed, and stale-state views at 1440 and 390 pixels, plus the 1180/900/640 breakpoint transitions.

## Verification and operations

Use domain tests for place occupancy and replacement races, lifecycle guards, exactly-one learning parent, booking history, stale versions, and idempotency. Workers runtime integration tests cover SQL rollback, persisted jobs, alarm recovery, and MCP/browser parity.

A controlled Google adapter must exercise a lost successful insert response, duplicate retry, failed move/delete, Retry/Undo compensation, cancellation before pending creation completes, 429/5xx, invalid refresh credentials, insufficient scopes, 24-hour disconnected-cache expiry, full-resync recovery, and a restart after local commit. Test both OAuth roles and prohibit all Work writes. Use a real owner-approved test-calendar smoke test before production readiness is claimed.

Browser tests cover one complete journey per implementation slice, calendar keyboard placement/resize, modal focus return, review draft abandonment/save/immutability, direct learning capture on the correct item, book fallback, and no page overflow at 390 pixels. Test Europe/Ljubljana DST, local midnight, 21:45, 04:00, and events crossing dates.

Separate development and production data, OAuth callbacks, secrets, and integration calendars. Enable structured Worker logs with request/actor/operation IDs and redaction. Keep SQL schema migrations ordered and forward compatible. Define an export/restore procedure and test restoration before release; database recovery does not itself reverse external Google operations.

## Implementation checkpoints

| Slice | Concrete reviewable result | Required checks |
| --- | --- | --- |
| 1. Persisted core and MCP | Owner auth, seeded areas, Board/project/ticket workflows, full-place swap, drawer; matching MCP tools | Place races, transaction rollback, lifecycle validation, scoped agent writes, retries and stale versions |
| 2. Books | Search/add, Bookshelf/detail, progress, automatic covers and fallback; matching MCP tools | Catalogue/manual/error paths, duplicate protection, page bounds, no upload requirement |
| 3. Google Calendar | Separate grants, cached events, booking/week view, outbox/reconnect states; matching MCP tools | Work read-only, no duplicate inserts, ordered retries, Google-side changes, keyboard/touch scheduling |
| 4. Today and review | Derived plan, reservation strip, timeline, four-step drafts/final save, direct learning capture, missed note; matching MCP tools | No effects before Save, atomic local review, saved-review immutability, daily uniqueness, direct-learning target guards and date boundaries |
| 5. Release verification | Visual/a11y polish, agent connection guide, deployment and recovery instructions | Reference-width comparisons, end-to-end journey, real integration smoke test, export/restore and secret checks |

The tech lead approved the consolidated specification and requested the complete app. These slices have been implemented together for local review. Deployment remains a checkpoint against a concrete tested build and stated resource configuration.

## Primary technical references

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) supports the proposed app/API deployment.
- [Cloudflare SQLite storage transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync) and [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) support local atomic commands and durable due work.
- [Cloudflare MCP handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), [official MCP SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/), and [Workers OAuth provider](https://github.com/cloudflare/workers-oauth-provider) describe the proposed MCP implementation.
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [OAuth token lifecycle](https://developers.google.com/identity/protocols/oauth2), [Calendar incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync), [event listing constraints](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), and [event IDs for retry protection](https://developers.google.com/workspace/calendar/api/guides/create-events) support identity and synchronization behavior.
- [Open Library search](https://openlibrary.org/dev/docs/api/search), [covers](https://openlibrary.org/dev/docs/api/covers), and [usage policy](https://openlibrary.org/developers/api) support the book integration.
