# Organizer technical decisions

Updated 19 October 2026. Owner and tech lead: Bine Čadež.

The tech lead approved the consolidated specifications and said “i approve create the app now” on 18 October 2026. The app is implemented. The owner subsequently authorized deployment of the current database followed by CI/CD on pushes to `main`. Production resources and the verified database transfer are now in place; production authentication and CI credentials remain setup steps. The original handoff remains reference material; it cannot override the owner's decisions.

## Approved direction

| ID | Decision | Approval context |
| --- | --- | --- |
| A01 | A single-user app for the owner, with four fixed areas and the supplied designs | Owner chose single user |
| A02 | Host on Cloudflare | Owner chose Cloudflare |
| A03 | React, TypeScript, Vite frontend; Hono Worker backend; owner-scoped SQLite Durable Object | Foundation proposed; owner accepted with the book-API amendment |
| A04 | Standard remote HTTPS MCP endpoint; OAuth and separately revocable client grants | Owner requested extensive agent control and accepted the foundation |
| A05 | Standing agent permission within granted scopes, including supported lifecycle, review, and booking actions | Owner explicitly approved question 2 |
| A06 | Commit domain changes atomically, then synchronize Google through durable pending operations with visible status | Owner explicitly approved question 3 |
| A07 | Open Library book search, metadata, and automatic covers | Owner accepted after confirming the API is free |
| A08 | No cover upload requirement; title-card fallback when a cover is missing; no R2 bucket for cover uploads | Book-API amendment and approved continuation |
| A09 | Tech lead reviews specifications and implementation checkpoints | Owner's original instruction; ongoing |
| A10 | Fixed Europe/Ljubljana planning timezone during travel; 04:00 review cutoff | Owner explicitly chose the fixed-zone option |
| A11 | Saved reviews are final and cannot be edited | Owner explicitly chose final reviews, replacing the handoff's reopen-and-edit behavior |
| A12 | Agents may capture learnings directly on a project or book, outside review | Owner explicitly approved direct capture |

The detailed [technical specification](TECH_SPEC.md), [data model](DATA_MODEL.md), and [MCP contract](MCP.md), including P01–P21 below, were approved by the instruction to create the app. Historical “proposed” wording records their origin; it no longer denotes an outstanding approval.

## Resolved product questions

The owner answered these questions while the draft was prepared. Their answers replace the earlier recommendations.

| ID | Question | Approved decision | Data-model reference |
| --- | --- | --- | --- |
| D01 | Do Today and review dates remain tied to Europe/Ljubljana during travel? | Yes. A review saved before 04:00 belongs to the preceding local day; Today still uses the ordinary local calendar date | DM07 |
| D02 | Can a saved review be corrected? | No. Saved reviews are final; exact idempotent retries return the original save receipt | DM08 |
| D03 | May agents save a learning outside evening review? | Yes. Direct capture is allowed, still attached to exactly one project or book | DM09 |

## Approved product and workflow baseline

These fill handoff gaps or confirm its explicitly unconfirmed defaults. The consolidated implementation approval covers this baseline.

| ID | Proposal | Effect |
| --- | --- | --- |
| P01 | Pausing moves in-progress tickets to To do. Pause/archive/finish remove all future bookings of that project, including those belonging to already-done tickets | Frees the place without leaving future reserved sessions; past history remains |
| P02 | Preserve overlap behavior: drag/resize reject; Book time permits explicit Book anyway; equivalent MCP create/move operations require an explicit flag | Default agent booking never silently overlaps |
| P03 | Suggest free starts that fit the selected booking length | Corrects the reference algorithm's 15-minute-gap versus one-hour-default mismatch |
| P04 | External Google moves/deletions win when reconciling an observed newer event version; preserve externally set off-grid times | Avoids reverting intentional Google-side edits |
| P05 | Today derives membership from booked-today, planned-today, or in-progress tickets of active projects. Book time defaults to Tomorrow after 21:45 | Uses handoff defaults instead of a prototype-only today flag |
| P06 | Review draft choices persist across reload/devices. No domain effects, including Google booking, occur until Save | Review remains a single deliberate commit |
| P07 | One learning within a review, attached to exactly one active project or book. Separate direct learnings are unlimited by the daily review count. Reaching the last page offers Mark as read | Keeps the review flow alongside approved direct capture |
| P08 | Mark project done shows its open-ticket count before the UI command; MCP may call the same authorized command without a separate owner approval | Preserves informed UI completion and approved agent standing authority |
| P09 | Done/archived items remain read-only, and done items cannot reopen in v1 | Matches the handoff's deliberate lifecycle restriction |
| P10 | Keep Bookshelf labels All, Want to read, Reading, Read; All includes paused books with a Paused badge, archived books stay in the drawer | Resolves the missing paused shelf filter without adding a new screen |
| P11 | Prefer exact edition page count; otherwise identify an estimated work count or ask for a positive count before adding the book. Counts remain editable on nonterminal books | Prevents division by zero and misleading edition progress |
| P12 | Availability uses connected calendars even if hidden in the calendar display. All-day events display but do not block suggested slots, as specified in the handoff | Makes visibility separate from availability; retains the existing all-day rule |
| P13 | Owner login and agent OAuth grants are separate from Personal/Work Calendar authorization. Work never receives writes | Applies both to browser and MCP |
| P14 | New settings contain only required account, integration, and agent-client controls | Supplies reconnect/revocation paths missing from the screen list |
| P15 | Track at most one local book per Open Library work, while retaining edition and ISBN identifiers | A stricter duplicate policy than edition identity alone; this is an explicit proposal |
| P16 | App-created bookings stay on one local date with `07:00 <= start < end <= 23:00`; suggestions start before 22:00 and fit the duration | Resolves unspecified custom-time and cross-midnight behavior; external Google edits are still preserved |
| P17 | Retain active-project tickets completed today in Today, even if their prior membership was only in-progress | Keeps the checked row visible; unticking may remove it if no Today condition remains |
| P18 | Direct learning capture requires an active target and assigns the current Europe/Ljubljana date; no new learning edit/delete commands | Specifies the smallest workflow covered by A12 |
| P19 | Retry/Undo is available for failed booking create/move/resize. Failed deletion or lifecycle cleanup offers Retry/reconnect; later rebooking is explicit | Narrows the handoff's generic Undo language to safe, version-checked compensation |
| P20 | Queued/active/paused items allow metadata edits; their ticket titles/order and To do preparation remain editable. Ticket work status and explicit day planning require an active project | Keeps paused content usable without letting it reserve work or calendar time |
| P21 | Ticket-title edits update only the current upcoming/ongoing booking's Google summary; past titles remain historical snapshots | Documents the consequential external effect of metadata editing |

Detailed edge cases and any additional proposed constraints appear in DATA_MODEL.md. If a draft detail conflicts with this log or the handoff, flag it during review rather than treating the draft as an automatic override.

## Scope boundary

Keep the supplied v1 exclusions: no standalone/recurring tickets, custom areas, estimates, global learning feed/search, streaks/statistics, notification system, non-Google calendars, teams, public signup, or light theme. No permanent-delete tools or arbitrary database/calendar administration tools are implied by extensive MCP access.

## Review and implementation sequence

1. Review the specification drafts with D01–D03 incorporated, approving or amending the remaining proposals.
2. Build the persisted core, owner access, and corresponding MCP tools; demonstrate and verify it.
3. Build books, then Calendar, then Today/review with MCP parity at each step.
4. Review the completed responsive UI, integration behavior, recovery procedure, and agent connection guide.
5. Approve the concrete production deployment.

Ordinary implementation choices within an approved slice do not require a new permission question. Material changes to product rules, security boundaries, storage architecture, or scope return to the tech lead for review.
