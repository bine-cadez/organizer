# Organizer data and workflow contract

Status: approved for implementation on 18 October 2026. The owner-scoped SQLite Durable Object, fixed Europe/Ljubljana zone, 04:00 review cutoff, final saved reviews, direct learning capture, and detailed workflow baseline are implemented locally. Historical proposal wording records the specification's origin. HANDOFF.md is product reference; the user's decisions take precedence. See OPERATIONS.md for live release checks.

## 1. Storage boundary and conventions

One owner Durable Object contains the domain tables, review drafts, operation outbox, command receipts, and audit records. The authenticated owner determines object routing. A caller cannot supply an arbitrary owner identifier to gain access to another object. Browser and MCP operations call the same domain commands; neither receives arbitrary SQL access.

Each mutating command executes its reads, precondition checks, writes, version increments, audit entry, idempotency receipt, and outbox insertion in one synchronous SQLite transaction. Any failed check aborts the whole command. Network calls happen after that transaction, never inside it. The owner object is the coordination unit; MCP transport/session objects, if any, are not separate copies of Organizer data.

Use application-generated globally unique opaque IDs for entities. Entity tables have created_at, updated_at, and a positive INTEGER version unless stated otherwise. Store instants as INTEGER UTC epoch milliseconds. Serialize instants as RFC 3339 UTC strings at API/MCP boundaries. Store civil dates as validated YYYY-MM-DD values and time zones as IANA identifiers. A date is not converted to midnight UTC.

Persist revisions as positive integers but expose version and ownerRevision as opaque strings. Clients compare for equality and return them; clients do not increment or interpret them. A successful semantic change increments each affected entity/aggregate once and advances ownerRevision once. An exact idempotent replay and a read do not advance versions. Calendar reconciliation and draft autosaves are writes and advance the revisions of what they actually change.

## 2. Domain tables

These are logical table definitions. Cross-row rules listed under command guards must also be enforced by the shared command layer. They are not expressible as ordinary row CHECK constraints.

### owner_settings and aggregate_versions

| Table | Fields and keys | Constraints |
| --- | --- | --- |
| owner_settings | singleton key; planning_time_zone; locale; setup_skipped_at; version | One row; planning_time_zone is fixed to Europe/Ljubljana; locale en-GB. No device-based zone changes or travel-zone setting in v1. Approved DM07. |
| aggregate_versions | key primary key; version | Revision rows for owner, place:<areaId>:<kind>, queue:<areaId>, and tickets:<projectId>:<status>. Seed eight places and four queues. Create ticket-column revisions with a project. |

At the boundary, expectedVersions keys are item:<id> for a project or book, ticket:<id>, booking:<id>, place:<areaId>:<project-or-book>, queue:<areaId>, tickets:<projectId>:<status>, review:<localDate>, and operation:<id>. Entity keys use the corresponding table's version; aggregate keys use aggregate_versions. The aggregate_versions row keyed owner supplies ownerRevision for whole-owner snapshots. A command declares the keys it requires and rejects missing or stale preconditions before changing anything. A response returns updated affected versions and ownerRevision.

### areas, projects, books, queue_entries

| Table | Fields and keys | Checks and relationships |
| --- | --- | --- |
| areas | id primary key; code; name; full_name | Exactly four seeded rows: tech/T/Tech, sales/S/Sales & Business, ship/P/Product Shipping, self/G/General. No public create, rename, or delete operation. |
| projects | id primary key; area_id foreign key; title; goal nullable; state; started_at; paused_at; archived_at; done_at; version | Trimmed title length 1–120; state queued, active, paused, archived, or done. Area is required. |
| books | id primary key; area_id foreign key; title; authors_json; provider nullable; work_id nullable; edition_id nullable; isbn_normalized nullable; cover_id nullable; cover_url nullable; page_count; page_count_source; current_page; state; lifecycle timestamps; version | Nonblank title; authors is an array, possibly empty for manual entry; same state set as projects; positive page_count and 0 ≤ current_page ≤ page_count. page_count_source is edition, work_median, or manual. DM06. |
| queue_entries | id primary key; area_id foreign key; position; project_id nullable foreign key; book_id nullable foreign key | Exactly one target; each target occurs at most once; position is a nonnegative integer; unique area_id + position. Target area must match the entry area. |

Projects and books remain separate tables to keep their fields and ticket relationships direct. A shared queue_entries table defines the area's mixed project/book Up next order. Commands maintain exactly one queue entry for a queued item and none for other states. Reordering writes the affected area's order atomically, using temporary nonconflicting positions if necessary; it checks queue:<areaId>.

Required indexes:

- Unique partial index on projects(area_id) for state = active, and the equivalent on books. These enforce the eight-place limit independently of UI/MCP validation.
- Projects and books by state + area_id for Board, shelf, and drawer queries.
- Unique queue target indexes on nonnull project_id and book_id, plus unique area_id + position.
- Unique partial indexes on nonnull normalized ISBN, provider + edition_id, and provider + work_id within this owner's database enforce the proposed one-tracked-book-per-work policy, including archived records. Do not impose uniqueness on titles. Retain the chosen edition identifiers and any provider metadata used to normalize equivalent ISBN forms. DM06 and DECISIONS P15 define this proposed user behavior.

Lifecycle timestamps record the most recent transition of that kind. They are not a complete history; audit records provide that. Starting sets started_at if absent. Resuming preserves the original started_at. Completion is explicit; a book at its last page is not automatically done.

### tickets

| Fields and keys | Checks and relationships |
| --- | --- |
| id primary key; project_id required foreign key; title; status; planned_for nullable date; column_position; current_booking_id nullable; done_at nullable; version | Nonblank title; status todo, in_progress, done, or closed; nonnegative column_position. No standalone ticket and no estimate/effort/duration field. |

Indexes: project_id + status + column_position; planned_for; project_id; unique nonnull current_booking_id. The booking reference must belong to the same ticket: enforce with a composite foreign key from ticket id + current_booking_id to the unique booking ticket_id + id pair. Insert a booking before assigning the pointer inside the same transaction.

Column ordering uses its column aggregate revision. Moving a ticket changes both source and destination column revisions. New tickets start in To do. Only active projects permit work-status changes, explicit day planning, or new/moved bookings; done and closed tickets cannot receive a new booking. Queued and paused projects allow ticket creation in To do, title edits, and reordering within an existing column. Project/book metadata remains editable in queued/active/paused states. Previously completed tickets may remain on a restored queued project, but queued/paused work cannot newly advance to in_progress or done. Archived/done project contents are read-only. DM02.

Marking an individual ticket done preserves its Google event, including a future event; booking removal remains an explicit action. Reopening a ticket changes it to todo and clears done_at. Closing a ticket because its project finished is distinct from completing it and does not invent a done_at. DM04.

### learnings

| Fields and keys | Checks and relationships |
| --- | --- |
| id primary key; text; created_on date; source_kind; review_id nullable foreign key; project_id nullable foreign key; book_id nullable foreign key; created_by_actor_id; version | Text length 1–2000 after trimming; exactly one item target; source_kind review or direct. A review source requires review_id; a direct source requires review_id null. Unique nonnull review_id enforces at most one learning per saved review while allowing many direct learnings per day. |

Indexes: project_id + created_on and book_id + created_on, newest first; unique partial review_id where nonnull. Learnings are immutable after creation in v1: no learning edit/delete command is requested. There is no global learning page or cross-item attachment.

The owner approved direct capture outside reviews. The proposed command guard requires exactly one currently active project or book. It validates the target's current version and active state in the transaction, derives created_on from the server's current Europe/Ljubljana civil date, and records the authenticated human/agent in created_by_actor_id and audit. The client cannot backdate or impersonate the creator. Multiple direct captures on a day are allowed, including a day with a review learning; ordinary idempotency prevents retries from duplicating a capture. Appending advances the target item's version and ownerRevision. Direct learning dates use civil midnight, not the 04:00 review cutoff. The active-target/date/editability refinements are proposed in DECISIONS P18.

### calendar_accounts, calendar_sources, calendar_events

| Table | Fields and keys | Checks and relationships |
| --- | --- | --- |
| calendar_accounts | id primary key; role unique; google_subject; google_email; encrypted_credentials; encryption_key_version; write_calendar_id nullable; status; version | Role personal or work; status connected, needs_reconnect, or error; write_calendar_id is null for work. No account row is required before first OAuth connection. |
| calendar_sources | account_id foreign key + calendar_id composite primary key; calendar_time_zone; read_enabled; sync_token nullable; sync_profile_json; coverage_start_utc/coverage_end_utc nullable; last_synced_at; last_error_at nullable; version | Token, original query profile, coverage bounds, and sync status belong to each calendar. Personal write calendar is also read. A changed baseline/window requires a bounded full refresh; range coverage is validated before availability is called complete. |
| calendar_events | account_id + calendar_id + google_event_id composite primary key; title; start_utc/end_utc nullable; all_day; start_date/end_date nullable; is_busy; provider_etag nullable; provider_updated_at nullable; deleted_at nullable; cached_at | Timed events require end > start and no date-only interval. All-day events require an exclusive end date after start date. Cancelled provider events are tombstoned for reconciliation. |

Indexes: calendar_events(account_id, calendar_id, start_utc), and date interval lookup for all-day strips. Store the fields needed for display/reconciliation, not unrelated attendee or description data. OAuth credentials are encrypted with a Worker-managed key; secrets and token bodies never enter audit, command responses, or operation errors.

Account visibility toggles affect display only. Availability still considers all selected connected sources, independently of whether a layer is hidden. Transparent/declined events are not busy. The handoff's all-day/free-start and overlap rules require the separate scheduling decision in TECH_SPEC.md; do not silently reinterpret them here.

## 3. Booking identity, history, and current booking

### bookings

| Fields and keys | Checks and relationships |
| --- | --- |
| id primary key; ticket_id foreign key; account_id foreign key; calendar_id; google_event_id; start_utc; end_utc; remote_start_utc/end_utc nullable; remote_etag nullable; desired_presence; sync_state; retired_at nullable; provider_deleted_at nullable; version | end > start; desired_presence present or absent; sync_state pending, synced, or failed. Account needs_reconnect is separate from booking sync state. The owning account must be personal. Unique account_id + calendar_id + google_event_id, and unique ticket_id + id for ticket ownership checks. |

Indexes: ticket_id + start_utc; start_utc; sync_state. The row retains its identity and Google mapping throughout retries. start/end represent the requested Organizer interval; remote_start/end represent the last observed provider interval. They differ while a move is pending. The event is never moved to the work account or silently transferred between calendars.

The current booking is the row selected by tickets.current_booking_id. It is the one occurrence Organizer manages as that ticket's current appointment. It may have ended before the next command retires it. An active upcoming/ongoing booking is a current row with desired_presence present, no provider deletion, and end_utc > now. There can be at most one such booking per ticket because there is one pointer.

Rebooking an upcoming/ongoing current appointment changes that row and queues an update. Booking again after the previous occurrence ended retires the old row, preserves its event on Google, creates a new row, and changes the pointer atomically. Review rescheduling follows the same rule: yesterday's occurrence is history; tomorrow gets a distinct booking. Never overwrite an old occurrence's times merely to avoid storing another row. DM03.

Proposed v1 input bounds: a booking lies within one owner-local date, with 07:00 ≤ start < end ≤ 23:00 and start/end on the 15-minute grid. Suggested start chips begin before 22:00; a one-hour drag drop must start by 22:00 to fit. Custom end does not authorize a cross-midnight event. A Google-side edit outside these hours is preserved as provider data, with the visible grid clipped and an accessible out-of-hours indication; never clamp and write it back silently. This scheduling refinement is pending approval with DM05.

Remove booking clears the current pointer, sets desired_presence absent, retires that row, and queues deletion. A Google-side deletion records the tombstone and clears a matching current pointer without deleting the ticket or changing its status. The booking record remains available for review/audit history.

Calendar projections merge cached events and bookings by account + calendar + provider event ID, displaying each event once. Pending creates contribute requested busy time. Pending moves retain the observed remote interval and requested interval for conflict calculations until reconciled; they must not imply that Google has already accepted the move. Pending deletions remain visibly pending and busy at their observed Google interval until success.

## 4. Item transitions and atomic place swaps

| Transition | Transactional local effects |
| --- | --- |
| New → queued | Create item and queue entry at the area's end; no ticket may start in progress. |
| queued → active | Require the matching place to be open; remove queue entry; update item and place versions. Unique index is the final race guard. |
| active → paused | Release place; in_progress tickets become todo; other ticket statuses remain; clear planned_for on unfinished tickets; retire booking pointers and enqueue future-event cleanup. DM01/DM02. |
| active → archived | Release place; preserve ticket statuses for reading; clear planned_for on unfinished tickets; retire booking pointers and enqueue future cleanup; item becomes read-only. DM01. |
| active → done | Release place; project todo/in_progress tickets become closed; clear their planned_for; book current_page becomes page_count. Retire pointers and enqueue future cleanup for all project tickets, including already-done tickets. DM01/DM02. |
| paused → active | Require place open; preserve ticket statuses after the pause reset; no automatic booking restoration or replanning. |
| archived → queued | Append to Up next; preserve content and completed tickets, but reset in_progress → todo to satisfy the queued guard; clear unfinished planning; no booking restoration. DM02. |
| done → another state | Reject in v1. A final saved review cannot be changed to bypass this. DM02/DM08. |

Future cleanup means events whose start is at or after the command's captured effective_at. Leave past and already-running occurrences on Google as history; they stop being current appointments when the item leaves active. Local bookings for future cleanup become desired_presence absent. A failed remote delete does not reserve the place again. The UI/MCP response reports accepted local state plus pending/failed operation IDs. DM01.

A full-place swap is one command containing expected versions for the current holder, incoming queued item, place, and queue. Verify both items still belong to that area/type and match the supplied states; apply finish/pause/archive to the old holder; remove the incoming queue entry; activate the incoming item; update all affected versions; append audit/outbox records. Any failure rolls back everything local. There is no override or admin bypass. Google cannot participate in this SQLite transaction.

No public hard deletion of projects, books, tickets, booking history, learnings, or reviews is specified for v1. Use archive, close, or remove booking where applicable. Any future deletion command requires its own approved retention and relationship behavior. DM11.

## 5. Command receipts, audit, and external operations

| Table | Fields and keys | Purpose |
| --- | --- | --- |
| command_receipts | id primary key; verified_actor_or_grant_id; idempotency_key; command_name; canonical_request_hash; response_json; committed_at | Owner is implicit in the object. Unique verified_actor_or_grant_id + command_name + idempotency_key. The fingerprint includes command, arguments, and expectedVersions. Same key/hash returns the original committed response; same key with a different request rejects. Validation failures do not consume a key. |
| audit_log | id primary key; command_id nullable; actor_type; actor_id; action; entity references; before_after_json; occurred_at | Append-only domain audit; actor is human, authenticated agent, or system sync. Records meaningful fields and causation, never OAuth credentials. Does not become a product statistics feature. |
| outbox_operations | operation_id primary key; command_id nullable foreign key; booking_id nullable foreign key; source_account_id/source_calendar_id nullable composite foreign key; action; target_version; payload_json; base_remote_etag nullable; state; attempt_count; next_attempt_at; lease_until nullable; last_error_code nullable; last_error_message nullable; version | action create/update/delete targets exactly one booking; action sync targets exactly one calendar source. System-scheduled sync may have no originating command. State pending, running, waiting_retry, needs_reconnect, succeeded, failed, or superseded. The same names are public; operationId identifies pending work. |

Indexes: command receipt uniqueness; audit by entity + occurred_at and command_id; operations by state + next_attempt_at and booking_id + created_at. Retain receipts and minimal audit/booking identities throughout v1; no automatic expiry of retry protection. Storage retention beyond the owner's active use is an operational policy to approve separately, not a promise to discard audit after an arbitrary number of days.

All mutations, including UI commands and durable draft autosaves, use idempotencyKey. Authentication and current agent permissions are checked before returning even a stored response. Check the existing namespaced receipt and request fingerprint before live revision preconditions: an exact replay returns the committed response even though the original command advanced versions; mismatched reuse rejects. Only a genuinely new request proceeds to live revision checks. A successful receipt is committed with the actual domain writes; a process failure cannot leave a committed write without its receipt. The response contains operation IDs, not a false assertion of Google success.

An alarm processes due jobs sequentially per booking or calendar source, performs provider I/O outside transactions, then records success/failure in a fresh transaction. A completed older operation cannot mark a newer booking version synced. Before sending, skip an operation safely superseded by a newer local decision; do not assume an ambiguously completed create never reached Google. Expired running leases are retried after restart. Calendar sync requests schedule/coalesce one read operation per selected source and return their operation IDs. There are no fire-and-forget promises holding the only copy of work.

Create uses a stable provider-valid Google event ID derived once from the booking ID, plus private organizerTicketId and organizerBookingId markers. An ambiguous timeout is resolved using that identity before another insert attempt. Ticket ID alone cannot deduplicate separate historical occurrences. Update/delete retries address the same event. Already-absent deletion is success. Retryable failures enter waiting_retry with backoff; invalid credentials put the operation and account into needs_reconnect; a final failure remains visible with Retry rather than disappearing.

The alarm schedules the earliest due job and explicitly reschedules after outages; Cloudflare's automatic alarm retries are finite. On restart/request handling, ensure persisted due work has an alarm. No separate Queue or Workflow is required for v1 unless later operational evidence justifies one.

### Retry and Undo

Retry requires the operation version, current permission, and an idempotency key. It resumes the same intent with the same booking/provider identity after checking that it is still applicable. A superseded or stale operation cannot be retried to override a later command; return the current operation/booking instead.

Undo is a new audited compensation command, not a database rollback of a previously committed command. Require unchanged relevant versions and current domain eligibility. An Undo of create clears the current pointer and converges to no remote event: an unsent create can be superseded, but an ambiguous/sent create must be reconciled and, if present, deleted using its stable identity. Keep pending cancellation visible until absence is confirmed.

An Undo of move or resize restores the recorded pre-command interval through a compensating update, only if it does not overwrite a newer local/provider edit. Narrow v1 scope: Undo is available for failed create/move/resize only. A superseded operation, explicit delete, or project lifecycle cleanup returns UNDO_UNAVAILABLE. Failed deletion recovers through Retry or reconnect; a later explicit rebooking, when domain rules permit, creates a fresh occurrence/provider identity after reconciling the old removal. Do not undo project pause/archive/finish as a side effect of a calendar operation. This narrower Undo boundary is proposed DM12 because the handoff's generic failure table does not distinguish delete from other writes.

## 6. Durable evening review

### reviews and daily_dismissals

| Table | Fields and keys | Checks and relationships |
| --- | --- | --- |
| reviews | id primary key; review_date unique; review_time_zone; draft_json nullable; draft_updated_at nullable; saved_json nullable; saved_at nullable; version | One row per local review date; review_time_zone is Europe/Ljubljana. Before Save, draft_json is present and saved_json/saved_at are null. After Save, saved_json/saved_at are present and draft_json is null. JSON is validated against a versioned application schema. A saved row is immutable. |
| daily_dismissals | local_date + kind composite primary key; dismissed_at | kind skipped_review; persists the one quiet note's dismissal for that day. |

The durable draft includes the reviewed ticket IDs and source versions, each done/slipped choice, resolved date/time/time zone for proposed bookings, book page values and completion choices, optional learning and target, and source versions for affected items. It contains explicit resolved dates rather than a string such as Tomorrow that changes at midnight.

Opening an unsaved review snapshots the eligible tickets for its date or resumes its existing durable draft. Refreshing the draft does not silently replace choices with a new live set. If another agent adds a ticket or changes relevant state, expose the changed data and let the owner refresh/reconcile the draft. A draft has no domain effects: toggling done, entering pages, selecting a target, or picking a booking time changes only the draft. Book time opened from Step 2 stages the selection and makes no Google request. Closing or abandoning a draft leaves tickets, pages, and calendars unchanged. A saved date opens its immutable saved summary, never a new or reopened draft.

### Save contract

After the normal receipt replay check, Save requires that this date has no saved review, validates the draft revision and all source versions whose values or eligibility it relies on, and rejects a saved date with REVIEW_ALREADY_SAVED. It verifies every slipped ticket has one destination, page bounds, active project eligibility for new bookings, and exactly one active learning target when text exists. Target eligibility is checked before applying this review's own transitions, so a book completed by the same Save can receive that review's learning. If anything conflicts, return structured stale/conflict details and preserve the draft; commit no partial review or calendar jobs.

Successful Save is one transaction:

1. Set checked tickets done. Preserve their calendar occurrences.
2. For every unfinished ticket, apply exactly one explicit destination. Tomorrow, unbooked sets planned_for to the resolved tomorrow and status todo. Back to To do clears planned_for and sets todo. A timed tomorrow choice sets planned_for to that date, status todo, and creates/moves the appropriate booking through the normal booking rules. Leave an ended occurrence on Google as history.
3. Apply validated page updates. Mark as read is a separate affirmative choice, even at the last page; it follows the ordinary book completion transition.
4. Save at most one learning with source_kind review, this review_id, created_on equal to review_date, its selected target, and the authenticated creator identity.
5. Save the immutable review payload and saved_at, clear the submitted draft, write audit/idempotency records, and append calendar outbox jobs. Return a saved review summary plus pending operation IDs.

The initial Step 2 default may be a one-hour booking at the first gap that fits one hour; if no such gap exists, require an explicit unbooked/custom choice. Re-evaluate availability on Save. Newly detected overlap requires the explicit overlap permission from the normal booking contract; an old default must not silently authorize a newly conflicting booking. This refines the handoff's 15-minute suggestion algorithm and needs approval. DM05.

### Saved means final

Approved DM08: Save is final immediately, including before the review date's next-morning 04:00 cutoff. There is no saved-review editing, correction transaction, effect-reversal table, or reopened draft. A new Save or draft-autosave request for a saved date rejects with REVIEW_ALREADY_SAVED. The original exact idempotent Save replay returns its committed response without applying tickets, pages, learning, or calendar jobs again. Concurrent saves for one date allow one commit; the other conflicts or observes REVIEW_ALREADY_SAVED. The unique review_date and transactional saved_at guard enforce this on the server.

The saved snapshot records what was committed locally at Save. Later ordinary ticket/book/booking commands or Google reconciliation can change live state without rewriting the review snapshot. Calendar operation progress is queried separately; a remote failure never reopens or partially unsaves the review. Unfinished drafts remain editable until the review date's next-morning 04:00 cutoff, after which they are read-only abandoned drafts with no catch-up Save.

## 7. Dates, Today, and missed reviews

Approved DM07: the owner planning zone is fixed to Europe/Ljubljana, including during travel. Today and calendar columns use its civil calendar date. Between 00:00 and 03:59, Evening review defaults to the preceding date; at 04:00 it rolls to the current date. Tomorrow within a review means review_date + one civil day in Europe/Ljubljana. At 04:00 an unsaved previous review is missed and the single dismissible note becomes eligible; its pending draft is not a catch-up task. Initial setup creates no missed-review note for days before use began.

The first saved review, even if it has zero tickets/pages/learnings, satisfies that date. An unsaved draft does not. The note is at most one line for the immediately preceding missed date, with no streak, count, backlog, or notification. Dismissal is keyed to the current planning-zone date.

Local day membership uses a half-open interval between consecutive Europe/Ljubljana midnights; never assume a day is 24 hours. Calendar display labels use en-GB and 24-hour time. Reject nonexistent local times; require an explicit offset choice for ambiguous times rather than picking silently. UI booking hours normally avoid DST transition hours, but MCP validation must still be correct. V1 has no automatic or manual travel-zone switching.

Today includes tickets of active projects if they have a noncancelled occurrence intersecting today, planned_for equals today, status is in_progress, or status is done and done_at falls within today. Completed-today retention keeps an otherwise unplanned in-progress ticket visible immediately after checking it off. Done tickets also remain visible for their scheduled/planned day so the check can be undone; closed tickets are excluded. Deduplicate by ticket ID. An in-progress ticket appears even without planned_for. Back to To do and item deactivation clear stale planning as described above. Historical bookings remain visible on their calendar date but do not alone carry a ticket into the next day. This extends the handoff's Today predicate and needs approval with DM04.

## 8. Google reconciliation and conflicts

Google is authoritative for observed event times/deletion; Organizer is authoritative for ticket title/status, place ownership, and whether a booking is logically attached to an active project. A Google event title edit does not rename the ticket or project. Proposed title-edit behavior: an explicit Organizer ticket-title change queues a summary-only update for its current upcoming/ongoing event, updates the booking version, and preserves past event-title snapshots. It does not overwrite provider times as part of a rename. Non-app events are always read-only. A copied event containing Organizer markers is not automatically trusted: match the stored account/calendar/event ID before writing. DM10.

When no local calendar mutation is pending, adopt a moved Google event's interval into its booking and update affected versions. If it is deleted, tombstone and unbook it. If a historical event is moved into the future, preserve/display the provider event as busy history but do not silently replace another current booking or reactivate an inactive project. Surface the discrepancy with the affected booking identity. DM10.

When a pending local update was based on an older provider revision and an independent Google edit is detected, stop that update, reconcile to Google, and report an operation conflict. A retry requires a fresh command based on current versions; do not endlessly overwrite the provider change. A completed write already observed by this same operation is an idempotent success, not an independent conflict. Explicit local cancellation remains cancellation intent; a Google move does not reactivate an item or discard a queued cleanup. Already-running/past history is preserved according to the captured cleanup policy. DM01/DM10.

Use incremental sync independently per selected source and reconcile invalid sync tokens with a full refresh. Sync responses older than a known provider revision do not overwrite newer data. Reconnect resumes queued work only after checking current domain state and provider identity. Cached external events and booking projections must stay distinguishable from confirmed writes.

## 9. Consequential decisions and approval status

DM07–DM09 below are approved user decisions. The remaining rows are recommendations for the consolidated tech lead review.

| ID | Proposed recommendation | Why approval matters |
| --- | --- | --- |
| DM01 | Local transitions commit atomically; Google cleanup is durable and eventual. Future means start ≥ captured command time; preserve already-running/past events. Clean up all project future bookings, including done-ticket bookings. | A failed provider call cannot roll back or re-reserve a local place; pending cleanup is visible. |
| DM02 | Pause resets in_progress → todo and clears unfinished planning; restore from archive also normalizes in_progress before queueing. Queued/active/paused metadata and ticket preparation remain editable; work-status/day-planning changes require active. Done remains irreversible. | Resolves contradictory pause wording and separates content preparation from active work. |
| DM03 | Preserve booking occurrence history; one current pointer; a new session after an ended booking creates another occurrence. | Prevents review rebooking from moving yesterday's Google history. |
| DM04 | Individual ticket Done preserves its calendar event; future removal is explicit. Retain completed-today tickets on Today even without a plan/booking. Closed is distinct from done. | Avoids unapproved calendar deletion and prevents a checked ticket immediately disappearing. |
| DM05 | Review suggestions fit the one-hour default; Save rechecks overlap. Booking inputs stay on one local date, on the 15-minute grid, within 07:00–23:00; suggestions start before 22:00. | Refines the gap algorithm and custom bounds; new conflicts need explicit permission. |
| DM06 | Require positive page_count with provenance on add; allow corrections with clamping. Block matching work/edition/normalized ISBN, including archived records, with a link to the existing item. One tracked book per work is proposed P15. | Tightens nullable fields and explicitly proposes a work-level duplicate policy. |
| DM07 — approved | Fixed Europe/Ljubljana zone, including travel; Today uses midnight; review date rolls at 04:00, so after-midnight review still belongs to yesterday. | Determines daily membership, Tomorrow, and missed-review behavior. |
| DM08 — approved | Saved reviews are final immediately. Persist drafts before Save; reject subsequent mutation of a saved date except exact idempotent replay. | Removes edit/reversal machinery and prevents duplicate review effects. |
| DM09 — approved direction | Allow direct learning capture outside review. Proposed P18 guards: one active project/book, server-created current local date and verified creator; many direct learnings per day, plus at most one per review; no edit/delete. | Enables agent capture while keeping the remaining guard details reviewable. |
| DM10 | Google wins independent move/delete conflicts; ticket text/state stays Organizer-owned; explicit ticket renames patch only the current/future event summary; historical event moves never steal a current booking. | Prevents cross-system overwrites and unexpected place changes while keeping renamed bookings legible. |
| DM11 | No public hard-delete commands in v1; preserve history and use archive/close/cancel where applicable. | Destructive removal and retention are not specified in the handoff. |
| DM12 | Undo only failed create/move/resize through compensation. Delete/lifecycle cleanup use Retry/reconnect, with later rebooking explicit and a fresh identity. | Narrows the handoff's generic Retry/Undo wording and avoids accidental restoration of inactive-project work. |

## 10. Required verification after approval

Before feature rollout, test simultaneous attempts to reserve the same place, rollback halfway through a swap/review, stale revision rejection, exact idempotent replay versus key reuse, and a crash after Google accepts an insert but before local acknowledgment. Test durable draft resume, a draft conflict after another agent changed a ticket/book, two simultaneous saves, REVIEW_ALREADY_SAVED for a second distinct Save or draft mutation, and exact Save replay without duplicated effects. Test multiple direct learnings on one day, inactive-target rejection, verified creator/date derivation including 00:00–04:00, and the review learning limit. Also test a past booking followed by tomorrow's new occurrence, reconnect with pending cleanup, and Europe/Ljubljana midnight/04:00/DST boundaries during travel. These are behavior tests, not a request to implement a second persistence layer.

Platform references checked while drafting: [Cloudflare synchronous SQLite transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync), [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [SQLite partial indexes](https://www.sqlite.org/partialindex.html), and [Google event identity/private properties](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert). Runtime method signatures and deployment configuration remain part of implementation validation.
