# Organizer MCP contract

Status: approved and implemented locally, 18 October 2026. All 47 tools are registered. Remote production OAuth requires configured credentials and deployment. Optional `offline_access` is an authorization-server capability separate from application scopes.

## 1. Approved foundations and proposed details

The owner has approved a single-user app on Cloudflare, extensive remote MCP control, standing agent permissions including lifecycle changes and review saves, and eventual Google Calendar synchronization. The app and MCP share the same application commands. The approved architecture uses React/TypeScript/Vite, a Hono Worker, an owner SQLite Durable Object, owner Google login, and standard remote MCP OAuth.

Book discovery uses Open Library with automatic covers. There are no cover-upload tools or cover-upload storage requirements. The owner has also approved a fixed Europe/Ljubljana planning timezone and 04:00 review-day cutoff, final immutable saved reviews, and direct learning capture on a project or book. The active-target, date-assignment, and learning editability guards are proposed refinements in DECISIONS P18. Review still captures at most one learning; direct capture can add multiple learnings per day. Permanent deletion of projects, books, tickets, or reviews is undefined and is not exposed.

The tool names, scopes, schemas, numerical bounds, revision-key syntax, examples, and error codes below are contract details for technical review. They specify the intended v1 boundary without adding screens, agents hosted inside Organizer, arbitrary automation scripts, or an unrestricted database interface. The approved product choices in [DECISIONS.md](DECISIONS.md), including the fixed review-day policy, final reviews and direct learning capture, take precedence over assumptions in examples.

## 2. Service and shared command boundary

Expose one canonical HTTPS endpoint, `https://<organizer-origin>/mcp`. Its deployed origin is configuration, not a client argument. Use MCP revision `2026-07-28` with ordinary legacy stateless compatibility through the official Cloudflare handler. Do not introduce a transport session or a Durable Object per MCP client; the owner Durable Object persists application state independently of MCP transport.

Use `createMcpHandler` from `agents/mcp/server` with a factory that creates a fresh SDK v2 `McpServer` from `@modelcontextprotocol/server`. Mount it behind the MCP OAuth resource handler. Keep the compatible `agents` and SDK versions pinned together when implementation begins. The Worker/Hono router remains responsible for application routes and authentication routes.

```text
Browser routes ── authenticated owner session ─┐
                                            ├─ application queries/commands
MCP tools ── verified MCP grant + scopes ─────┘          │
                                                       ├─ owner SQLite Durable Object
                                                       └─ durable calendar outbox → Google
```

Tool handlers validate their schemas, obtain verified actor context, call the shared service, and format results. They must not duplicate lifecycle logic or mutate storage directly. An app command that is forbidden through the UI remains forbidden through MCP, including a second reserved place, booking Work, booking queued projects, or editing archived/done items.

The app does not need an embedded LLM, MCP sampling, a local stdio package, MCP Apps, or the Tasks extension to support these workflows. The normal operation-status tools below expose asynchronous calendar work.

## 3. Identity, grants, and scopes

There are three distinct credentials and purposes:

| Credential | Purpose | Boundary |
|---|---|---|
| Owner Google OIDC identity plus app session | Owner signs into the web app and approves MCP clients | Validate the Google identity and configured owner allowlist; use stable Google `sub` as identity. No calendar permission is implied. |
| Organizer MCP OAuth grant | A particular client acts for the owner with granted scopes | Organizer-issued, audience-bound access token; independently revocable client/grant; never substitutes for an app cookie or a Google token. |
| Personal/Work Google Calendar grants | Organizer reads calendars and writes its permitted Personal bookings | Separate role-bound integration records with encrypted refresh tokens; never returned by tools, resources, prompts, or logs. |

Use the supported single-Worker `OAuthProvider` from `@cloudflare/workers-oauth-provider`, with its OAuth KV namespace and protected-resource discovery. The owner login can also identify the owner during MCP authorization. Implement the provider's browser-bound consent/upstream flow; display the requesting client, redirect destination and scopes. Consent may be remembered. Use the library's resource/audience validation and PKCE support rather than a custom bearer-token protocol.

Standing approval means an authorized client can call its granted tools without a second Organizer approval dialog for each invocation. Clients may provide their own confirmation UI. Organizer must not claim that a model saying `confirmed: true` supplies authorization, and must not expose an elevation or guard-bypass argument. New client connection, scope elevation and Google account connection remain browser authorization flows.

Proposed scopes are additive; `organizer:read` is required for every tool and resource:

| Scope | Allows |
|---|---|
| `organizer:read` | Owner context, places/items/tickets/books, review context and integration/operation summaries |
| `organizer:write` | Queue/edit content, ticket status/order/planned day, consequential current-booking summary sync on ticket rename, reading progress, direct learning capture, dismiss skipped-review note |
| `calendar:busy:read` | Busy intervals, free starts and availability freshness; no external event titles |
| `calendar:details:read` | External event titles and calendar event details; implies `calendar:busy:read` |
| `calendar:book` | Create/move/resize/remove Organizer ticket bookings; implies busy read |
| `lifecycle:write` | Start/pause/finish/archive/resume/restore/swap items, including their specified ticket and booking effects |
| `review:write` | Persist an eligible unsaved draft and save its daily review once, including its specified ticket, book, learning and booking effects |
| `audit:read` | Read bounded change receipts; still subject to field redaction |

The approved owner grant may include all scopes. Scopes also permit a narrower client grant later without changing tool contracts. A lifecycle/review grant authorizes that command's documented compound effects; it does not grant unrestricted use of other tools. For example, `review:write` authorizes bookings created by saving that review, but a standalone `book_ticket` call still needs `calendar:book`. The proposed ticket rename command similarly authorizes only its specified current-booking summary synchronization, never a calendar time change. Revocation blocks new client commands; already committed commands and their durable calendar effects remain accepted intent until the owner explicitly changes/cancels them.

Filter the advertised tool/resource list using the verified grant and check required scopes again on every call. Filtering is a discovery convenience, not authorization. Return standards-compliant HTTP 401/403 challenges for missing/invalid tokens or scopes. Do not put an interactive Access login page in front of the MCP endpoint that prevents normal MCP OAuth discovery.

## 4. Common types, time, and results

All schemas are closed objects unless an explicitly named map is required. Publish JSON Schema input and output definitions. Unknown fields and invalid enum values are validation errors. IDs are opaque; clients use returned IDs rather than deriving database keys or supplying account ownership IDs.

| Type | Sketch |
|---|---|
| `AreaId` | `tech`, `sales`, `ship`, `self`; fixed seeds |
| `ItemKind` / `ItemState` | `project` or `book`; `queued`, `active`, `paused`, `archived`, `done` |
| `TicketStatus` | `todo`, `in_progress`, `done`, `closed`; `closed` is server-owned |
| `LocalDate` | ISO `YYYY-MM-DD`, interpreted in configured owner timezone |
| `Instant` | RFC 3339 timestamp with an explicit offset; output normalized to UTC |
| `Version` | Opaque string; storage may use an integer, but clients must not increment or compare tokens numerically |
| `Page<T>` | `{ items: T[], nextCursor: string \| null }` |
| `Warning` | `{ code, message, relatedIds?: string[] }`; actionable data, never hidden instructions |

The approved owner planning timezone is fixed to `Europe/Ljubljana`, including during travel; browser/device timezone does not change it. Today and calendar dates use its civil date. Between 00:00 and 03:59 local time, review defaults to the preceding date; at 04:00 it rolls to the current date. An unsaved preceding review becomes missed at that cutoff and cannot be caught up. Within a review, tomorrow means review date plus one civil day. `get_context` returns the timezone, local date, eligible review date and cutoff. Store instants in UTC and date-only plans/reviews as local dates. A booking's input instant must be explicit; reject nonexistent or ambiguous local times when the client uses a date/time conversion helper. DST behavior is tested through the same conversion service as the UI.

There is no ticket estimate or duration field. Booking start/end describe an actual calendar event and do not add an estimate to the ticket.

Every read returns this logical envelope in `structuredContent`:

```json
{
  "data": {},
  "meta": {
    "requestId": "req_...",
    "asOf": "2026-10-18T18:00:00Z",
    "timezone": "Europe/Ljubljana",
    "ownerRevision": "87",
    "versions": { "item:prj_rust": "8" },
    "warnings": []
  }
}
```

`ownerRevision` identifies the owner snapshot returned by that read. It is diagnostic/context information, not a replacement for the targeted write preconditions. Detail responses include relevant entity/aggregate versions and permitted next actions. Calendar reads also include per-account `lastSyncedAt`, connection status and completeness. An availability response never silently presents a disconnected Work account as known free time.

Publish a matching `outputSchema`, return a concise text summary alongside structured content, and include an app-relative `href` where there is a corresponding screen. Rich links supplement the structured payload; no essential behavior depends on an MCP host rendering custom UI.

## 5. Mutation semantics

The common mutation input fields are omitted from individual catalog rows:

```text
mode?: "apply" | "preview"                 // default apply
idempotencyKey: string                      // required in apply mode
expectedVersions: Record<RevisionKey, Version>
```

Apply requires the revision keys relevant to the command. Preview may omit keys to inspect current effects and receive the exact preconditions for apply. Preview does not write domain state, create outbox work, consume a place, create a learning, or save a review. A preview is optional: standing authorization permits a direct apply call with current revisions. There is no mandatory preview token or `confirmed` flag.

Revision keys are `item:<id>`, `ticket:<id>`, `booking:<id>`, `place:<areaId>:<kind>`, `queue:<areaId>`, `tickets:<projectId>:<status>`, `review:<localDate>`, and `operation:<id>`. Entity revisions come from rows; place/queue/column revisions protect aggregate membership and order. A command publishes the keys it requires in its tool description and read response. The service checks all preconditions in the same SQLite transaction as the mutation. An unrelated book update must not invalidate a ticket edit merely because the owner revision changed.

For create/queue operations, require the destination queue version. For start/resume, require item and place versions. A swap requires current/next item and place versions, plus the next item's queue version. Ticket moves require the ticket and both affected column versions. Booking edits require the booking/ticket versions and current project eligibility; create also requires the project version. Direct learning capture requires its active parent's item version. A review save validates the review, every affected item/ticket/place, and relevant booking/operation versions; its draft/context result supplies these preconditions.

If a revision changed, return `VERSION_CONFLICT` with safe current versions and a concise conflict summary; apply nothing. Re-read and decide whether to resubmit. Never automatically overwrite an owner's later browser edit because an agent loaded a draft earlier.

An apply result has this shape:

```json
{
  "outcome": "applied",
  "summary": "Rust paused; Postgres is now active.",
  "entities": [],
  "versions": {
    "item:prj_rust": "9",
    "item:prj_pg": "2",
    "place:tech:project": "6",
    "queue:tech": "11"
  },
  "effects": {
    "ticketsChanged": 2,
    "futureBookingsRemoved": 1,
    "operationIds": ["op_..."]
  },
  "syncStatus": "pending",
  "requestId": "req_..."
}
```

A preview uses `outcome: "preview"`, lists proposed effects and required versions, and returns no operation IDs. `syncStatus` is `not_required`, `pending`, `synced`, or `failed`; it describes related external work, not whether the local transaction committed.

Idempotency rules:

1. Scope the key to owner, verified actor/client-grant identity and tool. Store a canonical fingerprint of the exact apply arguments, including `expectedVersions`, and the durable result in the owner transaction.
2. Check an existing key before current revision preconditions. An exact successful retry using its original arguments/versions returns the original receipt/operation IDs without another mutation. Same key with changed arguments, including changed version tokens, returns `IDEMPOTENCY_KEY_REUSED`.
3. Retain successful receipts throughout v1 with no automatic expiry. Include `deduplicated: true` on replay. Clients must not intentionally reuse a key for a new action.
4. A precondition/validation failure does not consume the key. After a known failure the caller can re-read and submit corrected/current preconditions. An ambiguous client timeout is retried with the same key and exact original arguments; agents must not generate a new key or silently replace its versions simply because the response was lost.

Add truthful MCP tool annotations: reads are read-only; mutating tools remain mutating even though they offer preview. Mark lifecycle/deletion/overwrite effects as potentially destructive, external lookups/writes as open-world, and idempotency only where these semantics hold. Annotations never authorize the operation.

## 6. Tool catalog

There are 47 tools in this contract. Scope cells list additional scopes beyond the common `organizer:read`. Rows show domain inputs and the primary `data`/result content; the common envelopes, mutation fields and relevant versions still apply. All lists use the pagination/bounds in section 10.

### Orientation and item queries — 5 tools

| Tool | Scope | Input sketch | Output sketch |
|---|---|---|---|
| `get_context` | — | `{}` | Server/contract version, timezone, local/review date, granted scopes, fixed areas, rules summary, integration warnings, limits |
| `get_today` | —; busy/details grant for external calendars | `{ date?: LocalDate }` | Read-only day context: derived active tickets, reservation count, skipped note and authorized calendar projection; default current date |
| `get_board` | — | `{}` | Four areas, eight places/holders, ordered Up next, counts and place/queue/item versions |
| `list_items` | — | `{ kind?, areaId?, states?, query?, cursor?, limit? }` | `Page<ItemSummary>`; searches project/book titles only, includes state/source IDs and version |
| `get_item` | — | `{ itemId, cursor?, limit? }` | Project/book detail, progress, parent-scoped learnings page, permitted actions and versions; ticket summaries use `list_tickets` |

`get_today` is a read for another date, not a catch-up review workflow. A grant without calendar scopes receives Organizer tickets/bookings but no external calendar intervals or titles. `get_item` never aggregates learnings across parents.

### Project metadata and shared item lifecycle — 10 tools

| Tool | Scope | Input sketch | Output/effect |
|---|---|---|---|
| `queue_project` | `organizer:write` | `{ areaId, title, goal?, initialTicketTitles?: string[] }` | New queued project and To do tickets, appended atomically to Up next |
| `update_project` | `organizer:write` | `{ projectId, patch: { title?, goal?: string \| null } }` | Updated editable metadata; cannot change area, state or place by patch |
| `start_item` | `lifecycle:write` | `{ itemId }` | Queued item becomes active only if its matching place is Open; otherwise `PLACE_RESERVED` |
| `pause_item` | `lifecycle:write` | `{ itemId }` | Active → paused; opens place; in-progress tickets → To do; future booking deletions staged |
| `finish_item` | `lifecycle:write` | `{ itemId }` | Active → done; project open tickets → closed with future deletions; book reaches page count; opens place |
| `archive_item` | `lifecycle:write` | `{ itemId }` | Active → archived, opens place, stages future booking deletions; read-only afterward |
| `resume_item` | `lifecycle:write` | `{ itemId }` | Paused → active only when matching place is Open; no automatic rebooking |
| `restore_item` | `lifecycle:write` | `{ itemId }` | Archived → queued, appended to area's Up next; done items cannot restore |
| `replace_active_item` | `lifecycle:write` | `{ currentItemId, nextItemId, disposition: "pause" \| "finish" \| "archive" }` | Vacates current and starts queued next of same kind/area in one local transaction; all specified effects returned |
| `reorder_up_next` | `organizer:write` | `{ areaId, itemId, beforeItemId: string \| null }` | Reorders one queued project/book within the mixed area's queue; null appends; returns queue version |

Editable metadata is restricted to queued/active/paused items; archived and done remain read-only. This narrowly scoped metadata interface does not imply an area-moving feature. There is no pause-to-archive transition in v1, no generic `set_state`, and no done-item reopening. `replace_active_item` never runs both items concurrently and cannot override a different current holder.

### Tickets — 7 tools

| Tool | Scope | Input sketch | Output/effect |
|---|---|---|---|
| `list_tickets` | — | `{ projectId?, date?, statuses?, booked?: boolean, cursor?, limit? }` | `Page<TicketSummary>`; at least project or date required; deterministic ordering |
| `get_ticket` | — | `{ ticketId }` | Ticket, project state, current booking, permitted actions, entity/column versions |
| `create_ticket` | `organizer:write` | `{ projectId, title }` | New To do ticket appended to editable project's To do column; project required |
| `update_ticket` | `organizer:write` | `{ ticketId, title }` | Title edit and proposed summary-only synchronization of its current upcoming/ongoing booking; no change to booking identity, account, times or ownership |
| `set_ticket_status` | `organizer:write` | `{ ticketId, status: "todo" \| "in_progress" \| "done", beforeTicketId?: string \| null }` | Work-status/column change on an active project only; closed is server-owned |
| `set_ticket_day` | `organizer:write` | `{ ticketId, plannedFor: LocalDate \| null }` | Sets/clears explicit unbooked-day plan on an active project; does not move, remove or create a Google booking |
| `reorder_tickets` | `organizer:write` | `{ projectId, status, ticketId, beforeTicketId: string \| null }` | Reorders within one column; null appends; all IDs must belong to that project/column |

No ticket tool accepts an estimate, effort, points, owner ID, standalone mode or arbitrary event ID. Ticket title edits, To do creation, and within-column reorder are proposed for queued/active/paused projects; work-status and explicit day planning require active. Archived/done contents are read-only. Completing an individual ticket preserves its event. Ticket rename proposes a summary-only patch for its current upcoming/ongoing booking, preserving historical titles and all provider times; this is documented as DECISIONS P21 rather than silently included in a metadata write.

### Book discovery and progress — 5 tools

| Tool | Scope | Input sketch | Output/effect |
|---|---|---|---|
| `search_books` | — | `{ query, cursor?, limit? }` | Bounded Open Library candidates with work/edition IDs, title/authors, ISBN/year/pages when present, automatic cover URL and source link |
| `get_book_candidate` | — | `{ editionId }` or `{ isbn }` | Selected edition's normalized metadata; page-count provenance and missing-field warnings |
| `queue_book` | `organizer:write` | `{ areaId, source: { type: "open_library", editionId } \| { type: "manual", title, authors, pageCount }, pageCountOverride? }` | Queued local book metadata snapshot and automatic cover/title-card choice; proposed one-local-book-per-work rule also rejects duplicate edition/ISBN |
| `update_book` | `organizer:write` | `{ bookId, patch: { title?, authors?, pageCount? } }` | Edits permitted local metadata; lowering page count clamps current page in same transaction |
| `set_book_progress` | `organizer:write` | `{ bookId, currentPage }` | Updates an active book's page; 0..pageCount; reaching final page returns `canFinish: true`, not automatic completion |

`finish_item` marks a book read and frees its place. Source IDs/ISBN are normalized by the server; never accept arbitrary fetch URLs. Missing page count requires an explicit positive count before adding. Persist whether the count is edition metadata, a work median, or a manual correction. `queue_book` imports the chosen edition and checks metadata server-side rather than trusting an agent-supplied cover URL. `search_books` and `get_book_candidate` use bounded cached human-directed lookups, not catalogue crawling. No upload, image generation, file path, custom cover URL or second provider is required.

### Calendar and Organizer bookings — 7 tools

| Tool | Scope | Input sketch | Output/effect |
|---|---|---|---|
| `list_calendar_events` | `calendar:busy:read`; details grant for titles | `{ start, end, roles?: ("personal" \| "work")[], detail?: "busy" \| "titles", cursor?, limit? }` | Authorized cached events/intervals, all-day/busy flags and account freshness; forbidden detail level returns missing-scope error |
| `find_free_starts` | `calendar:busy:read` | `{ date, from?: Instant, lengthMinutes?: number, excludeBookingId? }` | Up to four starts that fit the requested length, default 60 minutes; conflicts/freshness/completeness; no availability guarantee or reservation |
| `list_bookings` | — | `{ ticketId }` or `{ start, end, cursor?, limit? }` | Current/historical Organizer bookings with operation/sync state; no external event descriptions |
| `book_ticket` | `calendar:book` | `{ ticketId, start, end, allowOverlap: boolean, acceptIncompleteAvailability?: boolean }` | Creates one current booking locally and enqueues Personal Google insert; rejects existing upcoming/ongoing current booking and non-active project; ended linked occurrence becomes history |
| `move_booking` | `calendar:book` | `{ bookingId, start, end, allowOverlap: boolean, acceptIncompleteAvailability?: boolean }` | Moves/reschedules upcoming/ongoing current Organizer booking, preserving identity; Personal Google patch staged; ended occurrence requires a new booking |
| `resize_booking` | `calendar:book` | `{ bookingId, end }` | Changes current booking end in 15-minute steps, min 15 minutes; applies week-view no-overlap/max-end rules |
| `remove_booking` | `calendar:book` | `{ bookingId }` | Clears current booking and stages deletion of its Organizer-created Google event; historical bookings stay as history |

Proposed booking bounds are one owner-local date with 07:00 ≤ start < end ≤ 23:00, both on the 15-minute grid. Suggested starts begin before 22:00 and must fit `lengthMinutes` (15–960 in 15-minute multiples, default 60); a one-hour drop starts no later than 22:00. Validate through the shared booking service. `allowOverlap` is explicit for Book time/move semantics: false rejects detected conflict, true records the detected conflicts and permits the handoff's Book anyway behavior. Resize follows the handoff's stricter grip rules. Google-observed off-grid/out-of-hours/cross-date moves are preserved as provider data; never normalize them by silently writing back. Any remaining overlap decision is tracked in DECISIONS rather than inferred from an agent tool name.

An active project and valid Personal booking credentials are required. Proposed automatic scheduling refreshes busy data before choosing/booking time, and treats data older than five minutes as stale. `acceptIncompleteAvailability` defaults false when a configured read calendar is disconnected or its busy data is stale. Explicit true acknowledges incomplete information; it never bypasses missing Personal booking credentials, Work read-only restrictions or place/state guards. Results must distinguish “no conflict in cached data” from “fresh verified free time.”

Agents cannot set account/write-calendar IDs, attendees, reminders, arbitrary descriptions or Google extended properties. The service chooses the Personal write calendar, event content and Organizer ticket marker. Account visibility toggles are presentation preferences, not permission to ignore busy time.

### Direct learning capture — 1 tool

| Tool | Scope | Input sketch | Output/effect |
|---|---|---|---|
| `add_learning` | `organizer:write` | `{ text, target: { kind: "project" \| "book", id } }` plus mutation envelope | Creates one learning on exactly one active parent; returns `{ id, text, createdOn, target }`, updated parent version and `syncStatus: "not_required"` |

Direct capture outside review is approved. The following guard/date refinements are proposed in DECISIONS P18: trimmed text contains 1–2000 characters; the single discriminated target selects exactly one active project or book; the server verifies identity/state in the transaction and assigns today's Europe/Ljubljana civil `createdOn`, independent of the review-day cutoff. Clients cannot backdate it. Multiple direct captures on a day are permitted, with one result for an exact idempotent retry. `get_item` provides the existing parent-scoped learning query. No learning update/delete tool or global learning search/feed is exposed. Direct captures do not create, edit or reopen a review and do not consume its one-learning allowance.

### Evening review and skipped-note dismissal — 4 tools

| Tool | Scope | Input sketch | Output/effect |
|---|---|---|---|
| `get_review` | —; busy/details grants enrich calendars | `{ date?: LocalDate }` | Eligible day's context/unsaved draft or a saved review's final receipt; today's tickets, active books, eligible learning targets and required versions; read never reopens a review |
| `update_review_draft` | `review:write` | `{ date, patch: { completedTicketIds?, slippedDestinations?, bookPages?, markReadBookIds?, learning? } }` | Creates/updates draft only for the eligible unsaved day; no ticket/page/learning/booking state changes or external calls |
| `save_review` | `review:write` | `{ date }` | Validates and atomically saves the eligible unsaved review once, with at most one review learning; final afterward; Google writes go to outbox; supports common preview mode |
| `dismiss_skipped_review_note` | `organizer:write` | `{ date }` | Dismisses that day's eligible missed-review note; does not create a review or count a streak |

Draft shape:

```text
completedTicketIds: TicketId[]
slippedDestinations: [{
  ticketId,
  destination:
    { kind: "tomorrow_unbooked" }
    | { kind: "back_to_todo" }
    | { kind: "book", start: Instant, end: Instant, allowOverlap: boolean }
}]
bookPages: [{ bookId, currentPage }]
markReadBookIds: BookId[]
learning: null | { text, target: { kind: "project" | "book", id } }
```

Patches replace an included collection rather than ambiguously merging arrays. Returned draft state includes its version and derived validation issues. Every slipped ticket needs a destination at save, using the same defaults as the UI; saving never silently carries unspecified work forward. A suggested free-start chip resolves to an explicit start/end in the draft. It is rechecked on Save because a suggestion does not reserve time.

Book time selections made during review remain staged. Neither `update_review_draft` nor preview creates Google events or outbox operations. Direct `book_ticket` is for an explicitly separate booking action and must not be used to implement review-step selection.

Saved reviews are final and immutable, as approved. Draft creation/update and first save are permitted only for the currently eligible unsaved review day. Read a saved review as its final receipt; it cannot acquire a new draft or be saved/corrected again. A new command targeting an already saved review returns `REVIEW_ALREADY_SAVED` without changing domain state. An exact retry of the successful original save, checked against its stored idempotency receipt before current revision preconditions, returns that receipt and creates no duplicate review, learning or booking. Validate baseline versions before the first save so a stale draft cannot overwrite independent edits. No catch-up/correction workflow, global learning feed, streaks or review history dashboard is implied.

### Connections, sync, operations and audit — 8 tools

| Tool | Scope | Input sketch | Output/effect |
|---|---|---|---|
| `get_connections` | — | `{}` | Personal/Work role, owner-visible email, connection status and selected-calendar summaries; no OAuth secrets |
| `get_calendar_sync` | — | `{ role?: "personal" \| "work" }` | Last successful sync, pending/failed operation counts, reconnect state and next retry time |
| `request_calendar_sync` | `calendar:busy:read` | `{ role?: "personal" \| "work" }` plus mutation envelope | Schedules bounded read synchronization; coalesces duplicate in-flight requests; per-source operation IDs/status |
| `get_calendar_connect_link` | — | `{ role: "personal" \| "work" }` | App-relative owner-only browser connect/reconnect URL; retrieving link does not connect or change account role |
| `get_operation` | — | `{ operationId }` | Operation status, safe target/action summary, attempts, next retry, failure/recovery hint and current version |
| `retry_operation` | Original command's scope | `{ operationId }` plus mutation envelope | Retries that failed/reconnect-blocked effect after prerequisites are satisfied; same intended Google operation, no new booking |
| `undo_booking_change` | `calendar:book` | `{ operationId }` plus mutation envelope | Reconciles a failed current booking change and applies its safe compensating action/previous confirmed value, or returns `UNDO_UNAVAILABLE` |
| `list_changes` | `audit:read` | `{ since?, until?, entityId?, cursor?, limit? }` | Bounded redacted change receipts with actor/client/tool, affected IDs, state/count summary and result; no global learning text feed |

`retry_operation` checks current ownership, grant scopes, entity revisions and whether the operation is superseded. Calendar read retries need busy-read permission; booking retries need `calendar:book`; cleanup operations may be retried using the lifecycle/review scope that originally authorized them. Original authorization is not a permanent bypass after grant revocation.

`undo_booking_change` is the narrow counterpart of the handoff's failed booking Retry/Undo UI. It handles failed create/move/resize only. Failed delete supports Retry/reconnect recovery; delete/lifecycle/superseded operations return `UNDO_UNAVAILABLE`. It is not general time travel or an undo for project finish/archive/review. It must not remove a later booking or erase history. Undo of a pending or ambiguously completed create records cancellation intent, reconciles using the stable event identity, and deletes the event if it exists. Keep its compensating operation pending until remote absence is confirmed, even if the local current pointer has already been cleared. A failed lifecycle cleanup has Retry/reconnect recovery, not an invented restoration of the old project.

## 7. Calendar outbox and honest completion

Commit local mutations and their outbox rows in the same owner SQLite transaction. External Google calls happen after commit and cannot participate in it. Local place replacement, ticket updates, page updates and review save are atomic; Google completion is eventual as approved.

An outbox operation has an opaque ID, relevant entity versions, original command/actor identity, intended provider action, status, attempt count, next-attempt time, last safe error and dependency/supersession information. Public and persisted operation states follow DATA_MODEL: `pending`, `running`, `waiting_retry`, `needs_reconnect`, `succeeded`, `failed`, `superseded`. The response envelope reports pending external work for pending/running/waiting_retry/needs_reconnect operations; individual booking syncState and reconnect reason follow DATA_MODEL. Exhausted failures remain visible; confirmed effects report success. Superseded operations cannot independently overwrite newer state.

Use durable, idempotent Google create identity/reconciliation, not just a best-effort title search. A lost insert response followed by retry must not create two events. Serialize/coalesce conflicting per-booking operations and protect provider updates from stale retries. A moved/deleted event observed in Google updates the local current booking according to the handoff's Google-wins rule; return fresh versions so stale agents conflict rather than resurrect it.

When pausing/finishing/archiving, prevent new bookings in the local transaction and stage future booking deletions. Return the item as transitioned with `syncStatus: pending`; do not claim that Google history/availability already changed. Persist pending deletions until acknowledged or explicitly superseded. Calendar displays/availability should identify pending cleanup to avoid double-counting a provider event and its local booking.

Keep historical bookings separate from the one current booking reference. The current pointer may still reference an ended occurrence until a new booking replaces it; it does not prohibit creating tomorrow's occurrence. Rebooking after it ended retires the old row and preserves its Google event. Move/resize/remove tools must not rewrite/delete historical rows; review rescheduling creates tomorrow's row. Thus “one current booking” must not mean “one historical row per ticket.”

## 8. Resources

Resources are read-only projections of the same queries, not a second API with weaker checks. Use these URI templates; enforce the corresponding tool scopes on each read:

| Resource | Contents |
|---|---|
| `organizer://rules` | Fixed areas, place/lifecycle rules, terminology, timezone policy and contract version |
| `organizer://today/{date}` | Authorized daily context from `get_today` |
| `organizer://board` | Places and Up next snapshot |
| `organizer://projects/{id}` | Project detail with its own learnings page |
| `organizer://books/{id}` | Book detail, progress, automatic cover/source and its own learnings page |
| `organizer://calendar/{startDate}/{endDate}` | Bounded authorized calendar projection; busy-only without details scope |
| `organizer://reviews/{date}` | Eligible review context and current draft/saved summary |
| `organizer://integrations/status` | Connection/sync summaries |

Return private cache scope for owner data, proposed TTL up to 15 seconds for live projections and zero for a freshness-critical review read. Static rules/tool catalogs may have longer TTLs, with grant-aware cache partitioning. Do not publish public-cacheable user content. Resources return current versions and include continuation links where an attached list exceeds its bound.

Resource subscriptions are optional and are not required for correct v1 operation. If implemented, notifications invalidate a resource; clients must read again rather than interpreting a notification as a complete state change. No user data or mutation authority resides in transport connection state.

## 9. Prompts

Provide optional user-selected workflow templates. They call existing tools; they do not grant scopes, start scheduled jobs or perform hidden writes when retrieved.

| Prompt | Arguments | Behavior |
|---|---|---|
| `morning_check` | `date?` | Inspect Today/places/calendar freshness and help form a concrete daily plan |
| `plan_tomorrow` | none | Read active tickets/free starts and propose explicit plans or authorized booking actions |
| `evening_review` | none | Guide the eligible unsaved day's four steps; stage a draft, inspect effects and save once when instructed; present saved reviews as final |
| `choose_next_item` | `areaId`, `kind` | Compare that area's queued items and current place; use guarded start/swap commands |
| `review_project` | `projectId` | Read its tickets and parent-scoped learnings; discuss progress without creating new product entities |

Templates tell agents to treat imported book/calendar/user text as data, preserve the configured timezone and use idempotency/revisions. They must not present arbitrary third-party text as server instructions or automatically compose new learnings as the owner's words.

## 10. Pagination, bounds and errors

Proposed bounds are reviewable operational choices: default page size 25, maximum 100; book search maximum 10; query minimum 2 characters and maximum 200; maximum 50 initial ticket titles; calendar list maximum 31 days per call; one-day free-start query; maximum four suggested starts. Titles and learning text use handoff bounds where specified. Enforce positive bounded page counts, author arrays and input sizes before storage/provider calls; finalize unspecified text maxima in shared schemas rather than silently truncating data.

Opaque cursors bind the filter/sort, owner/grant and revision. They are not offsets clients can edit. Use deterministic sorting with an ID tie-breaker. If the bounded result snapshot changed, return `CURSOR_EXPIRED` and require a fresh first page; never silently skip/duplicate rows. Provider search cursors are translated by the Worker and cannot become arbitrary provider URLs.

Rate-limit per owner/client and separately for providers. Proposed Organizer limits are 120 reads/minute and 30 applies/minute per client, with explicit retry-after guidance; provider limits take precedence. Open Library is additionally throttled to its published limits, identified with the real app/contact User-Agent and cached. Reject bulk crawling rather than letting multiple agents circumvent the same owner/provider budget. These numbers are not quotas guaranteed by the hosting platform.

Tool execution failures use `isError: true` and a schema-defined safe payload:

```json
{
  "error": {
    "code": "PLACE_RESERVED",
    "message": "Tech's project place is reserved for Rust.",
    "retryable": false,
    "details": { "currentItemId": "prj_rust" },
    "nextActions": ["get_board", "replace_active_item"],
    "currentVersions": { "place:tech:project": "5" }
  },
  "requestId": "req_..."
}
```

| Error code | Meaning / recovery |
|---|---|
| `VALIDATION_ERROR` | Invalid field/range/schema; return field paths and valid bounds |
| `NOT_FOUND` | Entity absent or not visible; no existence leak across grants |
| `VERSION_CONFLICT` | Read affected state again; preserve draft; choose whether to retry |
| `IDEMPOTENCY_KEY_REUSED` | Key was used for different semantic arguments; inspect original action |
| `PLACE_RESERVED` | No override; keep holder or explicitly choose guarded replacement |
| `INVALID_TRANSITION` / `READ_ONLY_ITEM` | State machine or archived/done guard rejected change |
| `PROJECT_NOT_ACTIVE` | Start the queued project or resume paused one before in-progress/booking |
| `TICKET_NOT_ACTIONABLE` | Closed/done/read-only ticket cannot accept the requested action |
| `BOOK_ALREADY_QUEUED` | Work/edition/ISBN already exists under the proposed one-local-book-per-work rule; return permitted existing-book link |
| `BOOK_METADATA_INCOMPLETE` | Selected edition lacks required count; supply pageCountOverride |
| `BOOKING_EXISTS` / `BOOKING_NOT_CURRENT` | Use current booking/move tool or reload reconciled ticket |
| `BOOKING_CONFLICT` | Return only authorized conflict detail; choose free time or explicit allowed overlap |
| `AVAILABILITY_INCOMPLETE` | Required calendar data disconnected/stale; refresh/reconnect or explicitly accept incomplete availability |
| `RECONNECT_REQUIRED` / `CALENDAR_SCOPE_REQUIRED` | Owner uses browser reconnect flow; no pasted token accepted |
| `REVIEW_NOT_ELIGIBLE` / `REVIEW_VALIDATION_FAILED` | Respect eligible review day and complete required slipped/learning choices |
| `REVIEW_ALREADY_SAVED` | Saved review is final; return its permitted final receipt/link without opening a draft or applying another save |
| `LEARNING_TARGET_NOT_ACTIVE` | Direct capture requires exactly one active project/book; inspect the parent's current state |
| `OPERATION_SUPERSEDED` / `UNDO_UNAVAILABLE` | Newer state or irreversible effects prevent that retry/compensation |
| `PROVIDER_UNAVAILABLE` / `RATE_LIMITED` | Bounded retry/backoff with safe retry-after; show cache freshness |
| `CURSOR_EXPIRED` | Restart pagination with identical filters |

Malformed MCP methods/messages use protocol errors. Authentication/scope failures use HTTP OAuth challenges, not a successful tool response that asks for credentials. An asynchronous provider failure appears on the persisted operation and booking sync state; it does not pretend the committed local action rolled back.

Do not return stack traces, SQL, refresh/access tokens, raw provider payloads or unauthorized work-event titles. `list_changes` exposes receipt summaries, not a search endpoint over all learning text or calendar descriptions. Audit logs record actor/client, tool, request/idempotency/operation references, timestamps, affected IDs, safe field/count changes and outcome.

## 11. Examples

Examples abbreviate the MCP JSON-RPC wrapper and results. Clients discover the actual deployed schemas. Times have explicit offsets; the Europe/Ljubljana example below is before the autumn DST change.

### Queue and start a project

```json
{
  "tool": "queue_project",
  "arguments": {
    "areaId": "tech",
    "title": "Learn Rust",
    "initialTicketTitles": ["Read ownership chapter"],
    "idempotencyKey": "queue-rust-2026-10-18-1",
    "expectedVersions": { "queue:tech": "10" }
  }
}
```

The result includes new item/ticket IDs and queue version. Before start, inspect `get_board`; apply `start_item` with the new item and matching place versions. If reserved, the error identifies the holder; the agent chooses a lifecycle disposition explicitly before `replace_active_item`. There is no `force` argument.

### Preview and apply a swap without a runtime approval gate

```json
{
  "tool": "replace_active_item",
  "arguments": {
    "currentItemId": "prj_rust",
    "nextItemId": "prj_pg",
    "disposition": "pause",
    "mode": "preview"
  }
}
```

Preview reports two in-progress tickets returning to To do, one future booking deletion, and current versions. An already authorized agent may then apply directly:

```json
{
  "tool": "replace_active_item",
  "arguments": {
    "currentItemId": "prj_rust",
    "nextItemId": "prj_pg",
    "disposition": "pause",
    "idempotencyKey": "pause-rust-start-pg-1",
    "expectedVersions": {
      "item:prj_rust": "8",
      "item:prj_pg": "1",
      "place:tech:project": "5",
      "queue:tech": "10"
    }
  }
}
```

Local success returns both items changed and the calendar-delete operation pending. A timeout retry uses the same idempotency key; `get_operation` distinguishes provider success/failure afterward.

### Find and queue a book with its automatic cover

```json
{ "tool": "search_books", "arguments": { "query": "The Mom Test Rob Fitzpatrick", "limit": 5 } }
```

Choose a returned edition ID and inspect `get_book_candidate` if details are needed. Call `queue_book` using `{ "source": { "type": "open_library", "editionId": "<returned edition ID>" } }`, the area, common mutation fields and optional required page-count correction. Do not construct or upload a cover; the selected edition's metadata supplies it, with title-card fallback.

### Book time and inspect synchronization

```json
{
  "tool": "book_ticket",
  "arguments": {
    "ticketId": "tkt_pg_intro",
    "start": "2026-10-19T08:00:00+02:00",
    "end": "2026-10-19T09:00:00+02:00",
    "allowOverlap": false,
    "idempotencyKey": "book-pg-intro-oct19-0800-1",
    "expectedVersions": { "ticket:tkt_pg_intro": "2", "item:prj_pg": "2" }
  }
}
```

The first receipt may say `syncStatus: pending`; report “queued for Personal calendar” until its operation succeeds. Never report that Work was modified. If Google moves the event before a later edit, re-read the current booking/version rather than resubmitting the old times with a new key.

### Stage review time without creating an event

```json
{
  "tool": "update_review_draft",
  "arguments": {
    "date": "2026-10-18",
    "patch": {
      "slippedDestinations": [{
        "ticketId": "tkt_pg_intro",
        "destination": {
          "kind": "book",
          "start": "2026-10-19T08:00:00+02:00",
          "end": "2026-10-19T09:00:00+02:00",
          "allowOverlap": false
        }
      }]
    },
    "idempotencyKey": "review-oct18-draft-2",
    "expectedVersions": { "review:2026-10-18": "1" }
  }
}
```

Only the draft changes. `save_review` in preview mode reports effects/preconditions; apply uses current review and affected entity versions. After a successful save, the review is final. Another command to edit/save it returns `REVIEW_ALREADY_SAVED`; an exact original-save retry returns its stored receipt. To capture another learning afterward, use `add_learning` on an active parent.

## 12. Coverage and acceptance criteria

| Product workflow | MCP coverage |
|---|---|
| First run and calendar account legends | Context/connections/connect-link; browser OAuth, not agent token entry |
| Today/morning check and skipped note | `get_today`, `set_ticket_status`, `set_ticket_day`, booking tools, dismissal |
| Board and Up next | `get_board`, queue/edit, reorder, guarded lifecycle/swap |
| Project board | Project detail/tickets, column moves/reorder, lifecycle, attached learnings |
| Bookshelf/detail/find | Filtered items, Open Library candidate lookup/import, manual entry, progress, attached learnings; automatic covers |
| Calendar Book time/week/resize | Authorized events, free starts, booking create/move/resize/remove, freshness and pending/error status |
| Paused/Archived drawer | State-filtered items, guarded resume/restore; immutable archived detail |
| Direct learning capture | `add_learning` on an active project/book; parent-scoped `get_item` retrieval; multiple direct captures per day |
| Evening review | Eligible unsaved context/draft, staged scheduling, optional preview, atomic local save once, immutable final receipt |
| Provider failure recovery | Connection/sync status, operations, retry and narrow booking Undo |

Implementation is complete only when:

- Every listed tool has a discoverable strict input/output schema, scope checks, truthful annotations, bounded output and a concise result summary.
- UI and MCP invoke the same state-machine commands, including concurrent start/resume/swap guards and exactly one active project/book per area.
- Identical retried applies produce one change/receipt and one intended provider effect; stale revisions and changed-key arguments fail without side effects.
- Work and unrelated Personal events are never mutated. Raw provider/owner OAuth secrets are absent from results/logs; busy-only grants cannot reveal event titles through conflicts, resources or audit.
- Review drafting and preview change no ticket, book, learning, booking or external state. First Save is one local transaction. Saved reviews reject new edit/save commands; exact save retries return one receipt without duplicate review learnings/bookings. A stale unsaved draft cannot overwrite later independent edits.
- Direct learning capture accepts exactly one active project/book and 1–2000 text characters, assigns today's Ljubljana civil date on the server, permits multiple captures per day, and deduplicates exact retries. Review's separate one-learning allowance remains unchanged; no learning edit/delete/global feed is exposed.
- Calendar failures survive Worker/DO restarts; operation results accurately distinguish local commit, pending sync, success, reconnect and exhausted failure. Lost insert responses cannot create duplicates.
- Past booking history survives review rescheduling; Google-side movement/deletion reconciles and invalidates stale versions.
- Search/import/automatic covers work through UI and MCP, with page-count correction, duplicates, no-results/provider failure and title-card fallback. No upload path or undefined deletion feature is required.
- Date/cutoff/DST behavior uses the approved owner-timezone policy and has meaningful boundary tests. Invalid pagination and over-limit inputs fail predictably.
- One authorized end-to-end MCP scenario covers queue → start → ticket → book → reconcile → review; another covers occupied-place swap and failed Google cleanup. Auth tests include wrong owner, revoked client, insufficient scope and isolation from calendar grants.

## 13. Verified primary references

Protocol/runtime facts below were checked on 18 October 2026. Proposed application behavior is defined above, not attributed to these references.

- [MCP Streamable HTTP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) and [version compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning): per-request protocol and legacy compatibility rules.
- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources) and [prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts): schemas, structured results and feature roles.
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) and [authorization security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations): discovery, audience-bound grants, PKCE and token separation.
- [Cloudflare MCP handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/): SDK v2 factory, stateless handler, verified auth context and ordinary legacy compatibility.
- [Official TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) and [Cloudflare Workers OAuth provider](https://github.com/cloudflare/workers-oauth-provider): supported packages and single-Worker OAuth option.
- [OAuth upstream sign-in helpers](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md), [consent page helpers](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/consent-page.md) and [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect): owner identity and per-client authorization implementation.
- [Open Library API usage](https://openlibrary.org/developers/api), [search](https://openlibrary.org/dev/docs/api/search), [editions/ISBN](https://openlibrary.org/dev/docs/api/books) and [covers](https://openlibrary.org/dev/docs/api/covers): human-directed cached discovery, metadata and direct automatic-cover URLs.

No MCP endpoint, OAuth flow, schema or provider integration has been runtime-tested by authoring this specification. Target-client smoke tests and credential/deployment configuration belong to implementation validation.
