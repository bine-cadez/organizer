# Organizer — Developer handoff

**Version** 1.0 · 18 Oct 2026 · Prepared for Bine Čadež (owner, implementer)
**Scope** Design is final for v1. Stack, architecture, hosting and auth library are the developer's call. Nothing here prescribes a framework; where an API is named, it is a suggestion with real endpoints.

**Sources of truth, in order:** this document → `DESIGN.md` (tokens, visual rules) → `PRODUCT.md` (product rules) → `prototype/` (behaviour and copy) → Figma (visual reference). Where they disagree, this document wins and the conflict is listed in [§9 Known prototype gaps](#9-known-prototype-gaps).

---

## Contents

1. [Overview & links](#1-overview--links)
2. [Domain model](#2-domain-model)
3. [Screen-by-screen spec](#3-screen-by-screen-spec)
4. [Book time & calendar behaviour](#4-book-time--calendar-behaviour)
5. [Books API](#5-books-api)
6. [Missed evening review](#6-missed-evening-review)
7. [Design tokens, components, accessibility, responsive](#7-design-tokens-components-accessibility-responsive)
8. [Acceptance criteria & out of scope](#8-acceptance-criteria--out-of-scope)
9. [Known prototype gaps](#9-known-prototype-gaps)

---

## 1. Overview & links

**What it is.** A single-user, dark-only web app (desktop and phone browser) that stops overcommitment. Four fixed areas; each area has exactly **two places**: one project place and one book place. A place is **Open** or **Reserved**. Everything else waits in the area's **Up next**. Tickets become real time on Google Calendar. Two daily rituals: a fast **morning check** (Today) and a short **evening review**.

**Vocabulary (use these words in UI and code):** area, place (project place / book place), Open, Reserved, Up next, ticket, Book time, learning, Paused, Archived, Done.

### Links

| What | Where |
|---|---|
| Figma file | https://www.figma.com/design/wdiJhqAirUq7VuQsSWdqsu |
| Prototype (local) | `cd prototype && python3 -m http.server 8765` → http://localhost:8765/index.html |
| Prototype archive | `/workspace/self-improve-prototype.tar.gz` (DESIGN.md, PRODUCT.md, prototype/) |
| Screenshots | `/workspace/self-improve/shots/*.png` (51 files, `<screen>-desktop.png` / `-mobile.png`) |

### Figma page guide

| Page | Contents | Notes |
|---|---|---|
| Cover | Title card, palette, page list | — |
| Desktop | 11 frames at 1440 wide, named `Desktop / …` | Captured from the prototype; editable frames, Inter text, vector icons. Book covers are image fills. |
| Mobile | 11 frames at 390 wide, named `Mobile / …` | Same screens; mobile tab bar shown in flow, not fixed. |
| States | 15 frames, named `States / …` | Popovers, dialogs, empty and edge states, calendar drag/drop/resize. |
| Design system | `Foundations` sheet; components `Button`, `Lamp`, `Area tile`, `Ticket row`, `Place card` | 41 colour variables (collection `Organizer`, mode `Dark`) + 9 radius variables; 41 colour styles; 15 Inter text styles (`Inter/…`). Components are bound to variables. |

Captured screens have no auto-layout and do not use the components; treat them as pixel references and the Design system page as the build reference. Calendar day-column hour lines are missing in Figma (CSS repeating background); see the prototype.

### Prototype entry points and scenario URLs

| URL | Shows | Figma frame |
|---|---|---|
| `index.html` | Today | `Desktop / Today`, `Mobile / Today` |
| `index.html?state=skipped` | Quiet skipped-review note | `States / Skipped review note` |
| `index.html?state=noevents` | No events today | `States / No events today` |
| `index.html` → click **Book time** | Book time popover | `States / Book time popover · Desktop/Mobile`, `· 2 h preset`, `overlap · Book anyway` |
| `board.html` | Board | `Desktop / Board`, `Mobile / Board` |
| `board.html?full=tech` | Full-place dialog | `States / Full place attempt · Desktop/Mobile` |
| `board.html?state=emptyarea` | Area with nothing active or queued (General) | `States / Empty area` |
| `board.html` → ⋯ on a place | Place menu | `States / Place menu` |
| `board.html?drawer=1` / `&tab=archived` | Paused & archived drawer | `Desktop / Paused & archived drawer`, `Mobile / …` |
| `project.html?id=rust` | Active project board | `Desktop / Project board (Rust)` |
| `project.html?id=pg` | Queued project (locked In progress) | screenshot `project-queued-locked-*.png` |
| `review.html?step=1…4` | Evening review steps | `Desktop / Evening review 1 · Tick off` … `4 · Learned` |
| `review.html?step=4` → **Save review** | Review saved | screenshot `review-saved-desktop.png` |
| `shelf.html` / `?filter=reading` | Bookshelf | `Desktop / Bookshelf` |
| `shelf.html?book=ddia` | Book detail (sheet on mobile) | screenshot `shelf-book-detail-mobile.png` |
| `shelf.html?book=staff` | Missing cover | `States / Missing cover` |
| `shelf.html?q=staff` / `?q=zero%20to%20sold` | Find a book: results / no results | `States / Search no results` |
| `calendar.html` | Week view | `Desktop / Calendar`, `Mobile / Calendar` |
| `calendar.html?demo=drag` / `drop` / `resize` | Drag ghost, dropped 1 h block, resize | `States / Calendar · Dragging ticket`, `· Dropped 1 h`, `· Resized` |
| `onboarding.html` | First run | `Desktop / First run`, `Mobile / First run` |

### File list

| File | Purpose |
|---|---|
| `PRODUCT.md` | Product rules, users, principles |
| `DESIGN.md` | Design tokens (YAML front matter) + visual rules |
| `.impeccable/design.json` | Machine-readable token sidecar (if present in your copy) |
| `prototype/*.html` | One page per screen; each sets `data-page` and loads the three scripts |
| `prototype/app.js` | All prototype behaviour: shell, Today, Board, drawer, full-place dialog, project, review, shelf, calendar, first run |
| `prototype/data.js` | Example content (not real data). Times are minutes from midnight; `day` 0 = Mon 19 Oct |
| `prototype/icons.js` | Inline SVG icon set (Lucide-style names) |
| `prototype/styles.css` | All styles and tokens as CSS custom properties |
| `prototype/fonts/` | Inter 400/500/600, latin + latin-ext, woff2 |
| `prototype/assets/` | Example book covers (`cover-<ISBN>.jpg`) |

---

## 2. Domain model

Single user. All timestamps stored in UTC; display in the user's zone (Europe/Ljubljana for Bine). Field names are suggestions.

### Entities

**Area** (fixed seed data, 4 rows; not user-editable)

| id | code | name (UI) | full name |
|---|---|---|---|
| `tech` | T | Tech | Tech Improvement |
| `sales` | S | Sales & Business | Sales / Business Improvement |
| `ship` | P | Product Shipping | Product Shipping |
| `self` | G | General | General Self-improvement |

**Project**

| Field | Type | Notes |
|---|---|---|
| id | id | |
| areaId | → Area | required |
| title | string | required, ≤ 120 chars |
| goal | string? | one line shown under the title on the project board |
| state | enum | `queued` · `active` · `paused` · `archived` · `done` |
| upNextOrder | int? | order within the area's Up next (queued only) |
| startedAt, pausedAt, archivedAt, doneAt | timestamp? | drive drawer notes ("Paused 2 Oct") |
| tickets | Ticket[] | |
| learnings | Learning[] | |

**Book**

| Field | Type | Notes |
|---|---|---|
| id | id | |
| areaId | → Area | required; chosen when adding ("Add to Up next in") |
| title, authors | string, string[] | from the books API or entered by hand |
| externalId | string? | e.g. Open Library work key `/works/OL…W` and edition key `/books/OL…M` |
| isbn | string? | |
| coverUrl | string? | null → title card (§5) |
| pageCount | int? | editable; see §5 |
| currentPage | int | 0 by default; 0 ≤ currentPage ≤ pageCount |
| state | enum | `queued` · `active` · `paused` · `archived` · `done` |
| upNextOrder, timestamps | as Project | |
| learnings | Learning[] | |

Bookshelf labels map from state: `queued` → **Want to read**, `active` → **Reading**, `done` → **Read**, `paused` → **Paused**, `archived` → hidden from the shelf (visible in the drawer).

**Ticket**

| Field | Type | Notes |
|---|---|---|
| id | id | |
| projectId | → Project | **required**; every ticket belongs to a project |
| title | string | required |
| status | enum | `todo` · `in_progress` · `done` · `closed` (closed = auto-closed when its project finished) |
| plannedFor | date? | the day it shows on Today when not booked (set by review step 2 "Tomorrow, unbooked") |
| order | int | within its column on the project board |
| bookedEventId | → BookedEvent? | at most one active booking per ticket in v1 |
| doneAt | timestamp? | |

No estimate, duration, points or effort field. Do not add one.

**Learning**

| Field | Type | Notes |
|---|---|---|
| id | id | |
| text | string | required, 1–2000 chars |
| createdOn | date | the review day |
| projectId xor bookId | → Project / → Book | **exactly one** must be set (DB check constraint) |

**CalendarAccount**

| Field | Type | Notes |
|---|---|---|
| id | id | |
| role | enum | `personal` (can book) · `work` (read-only) — exactly one of each, work optional |
| googleEmail | string | |
| oauth tokens | secret | encrypted at rest; refresh token required |
| calendarIds | string[] | calendars to read (default: `primary`) |
| writeCalendarId | string? | personal only; default `primary` |
| status | enum | `connected` · `needs_reconnect` · `error` |
| syncToken | string? | per calendar, for incremental sync |
| lastSyncedAt | timestamp? | |

**BookedEvent** (an event this app created for a ticket)

| Field | Type | Notes |
|---|---|---|
| id | id | |
| ticketId | → Ticket | |
| accountId | → CalendarAccount | always the personal account |
| googleEventId, googleCalendarId | string | |
| start, end | timestamp | 15-minute grid; end > start |
| syncState | enum | `pending` · `synced` · `failed` |

External (non-app) events are cached read-only as **CalendarEvent** {accountId, googleEventId, title, start, end, allDay, isBusy}. Never written.

### Relations

```
Area 1 ── * Project 1 ── * Ticket 0..1 ── 1 BookedEvent * ── 1 CalendarAccount(personal)
Area 1 ── * Book
Project 1 ── * Learning        Book 1 ── * Learning      (Learning belongs to exactly one)
CalendarAccount 1 ── * CalendarEvent (read-only cache)
```

### Item states (Project and Book share the same machine)

| State | UI name | Holds the place? | Tickets can be in progress / booked? |
|---|---|---|---|
| `queued` | Up next | No | **No** (tickets may be pre-planned in To do only) |
| `active` | Active / Reading | **Yes** | Yes |
| `paused` | Paused | No (frees it) | No; tickets keep their status, bookings are removed (see below) |
| `archived` | Archived | No | No; read-only |
| `done` | Done / Read | No | No; read-only |

### State transitions

| From → To | Trigger (UI) | Guard | Side effects |
|---|---|---|---|
| (new) → queued | Add to Up next / Find a book → Add | — | appended to the area's Up next |
| queued → active | **Start** (Up next) | area's place of that type is Open | if Reserved → full-place dialog, never an override |
| queued → active (via dialog) | Full-place dialog: Finish / Pause / Archive current | current holder transitions first, atomically | then the queued item starts; toast `“A” paused. “B” is now active.` |
| active → done | ⋯ **Mark as done** / **Mark project done** / dialog **Finish it** | — | project: all `todo`/`in_progress` tickets → `closed`; their future BookedEvents deleted from Google. Book: `currentPage` = `pageCount` |
| active → paused | ⋯ **Pause, opens the place** / dialog **Pause it** | — | place opens; ticket statuses kept; `in_progress` → `todo`; future bookings deleted from Google (ask nothing; toast says so) |
| active → archived | ⋯ **Archive, scrap it** / dialog **Archive it** | — | place opens; future bookings deleted; item read-only |
| paused → active | Drawer **Resume** | place is Open, else button disabled with reason | — |
| paused → archived | Drawer (optional v1.1) | — | — |
| archived → queued | Drawer **Restore to Up next** | — | appended to Up next |
| done → * | — | not allowed in v1 | — |

### Hard rules (enforce on the server, not only in UI)

1. **At most 1 active project and 1 active book per area.** Enforce with a unique partial index, e.g. `UNIQUE(area_id, type) WHERE state = 'active'`. No override, no soft warning, no admin bypass.
2. **Paused frees the place.** A paused item never counts toward the limit.
3. **Resume only when the place is Open.** Otherwise reject with a clear error; UI shows the disabled Resume with `{Area} project place is reserved for “{title}”`.
4. **Queued items cannot have in-progress tickets or bookings.** Reject `status = in_progress` and BookedEvent creation for tickets whose project is not `active`.
5. **Finishing a project closes its open tickets** (`todo`, `in_progress` → `closed`).
6. **Every ticket belongs to a project.** No standalone tickets in v1.
7. **No time estimates** on any entity.
8. **A learning attaches to exactly one book or project.** No global learnings page or list.
9. Starting via the full-place dialog is a **single transaction**: vacate current + start next, or nothing.

---

## 3. Screen-by-screen spec

Shared shell: desktop leather rail (236 px) with wordmark, nav (Today, Board, Calendar, Bookshelf, Evening review, Paused & archived + count), account legend ("Personal · can book", "Work · read-only"). Under 900 px: mobile header (wordmark) + 5-item bottom tab bar (Today, Board, Calendar, Shelf, Review). Paused & archived is reached from Board on mobile. Toasts: bottom centre, `role="status"`, 3.2 s.

Remove the "Prototype · example content" chips in production.

### 3.1 Today — `Desktop / Today`, `Mobile / Today`

**Purpose:** the morning check. What do I do today, and when?

| Part | Content / data | Interactions |
|---|---|---|
| Header | `Monday, 19 October` (weekday, day month); sub: `Morning plan · {n} tickets from {p} projects · {u} not booked yet` | **Week** → Calendar; **Evening review** → Review |
| Skipped note (conditional) | see §6 | Dismiss |
| Reservation book (signature strip) | Counter `{free}` + `of 8 places open`; four area cells, each with Project and Book rows: title + cream disc, or `Open` in brass + brass ring | Each cell links to that area on Board |
| Today's tickets | Grouped by area (tile + name + `· {project title}`). Ticket = today's tickets of active projects: booked today OR `plannedFor = today` OR `in_progress`. Row: checkbox, title, `In progress` pill, right side either booked chip `07:30–08:30` or **Book time** | Checkbox toggles done/todo (optimistic). **Book time** opens the popover (§4). Area with open project place shows `· project place open` and `No project running here. Start one from Up next` |
| Today on your calendars | 07:00–22:00 timeline; legend Work (dashed) / Personal (raised) / Booked ticket (area tint); now-line with brass dot | Read-only; booked block for a just-booked ticket animates in |

**States:** no tickets → panel text `Nothing planned for today. Pick tickets from the Board or book time on the week view.` (new copy). No events (`?state=noevents`) → `Nothing on either calendar today.` / `Work and Personal are both clear from 07:00 to 22:00. Book your tickets into the day so they don't drift.` + primary `Plan the day on the week view`. Calendar error → see §4.6.
**Mobile:** reservation book becomes 2×2 (labels Project/Book hidden); ticket's Book time wraps under the title; timeline 40 px/hour; popover becomes a bottom sheet.

### 3.2 Board — `Desktop / Board`, `Mobile / Board`

**Purpose:** see and change what holds each place.

| Part | Content | Interactions |
|---|---|---|
| Header | `Board` / `One project and one book per area. Everything else waits in Up next.` | **Paused & archived** (drawer), primary **Add to Up next** |
| Lane (×4) | Tile + area name + state lamp: `Reserved` (both taken), `1 open`, `2 open` | — |
| Project place, Reserved | area tint card; title (→ project board); `{d} of {n} tickets done · {p} in progress`; progress bar; ⋯ | ⋯ menu: `Mark as done` / `Pause, opens the place` / `Archive, scrap it` + hint `Paused items wait in Paused & archived.` |
| Project place, Open | dashed brass outline; `Project place open`; hint `Start a project from Up next below.` or `Nothing queued yet. Add a project to Up next.` | — |
| Book place, Reserved | mini cover, title (→ book detail), `p. {page} of {pages}`, bar, ⋯ | same menu (Mark as done = Read) |
| Book place, Open | `Book place open`; `Start a book from Up next below.` / `No books queued. Find one on the Bookshelf.` | — |
| Up next | `Up next · {n}`, + button; rows: icon, title, `{n} tickets planned` or author, **Start** | **Start**: if place Open → start, toast `Started “{title}” in {Area}`; if Reserved → full-place dialog. Reorder by drag (and keyboard: move up/down actions) |

**Full-place dialog** (`States / Full place attempt`)
- Header: place card `Reserved` + tile + `{Area} · {project|book} place`, right side `1 of 1 place taken`.
- Title: `To start “{next}”, open the {kind} place first`
- Body: `Each area keeps one {kind} at a time. Decide what happens to the current one. There's no way to run both.` Then the current item with its progress.
- Choices (cards, first one focused):
  - **Finish it** — `Mark done. Open tickets close with it.`
  - **Pause it** — `Keeps its tickets. Resume when the place opens.`
  - **Archive it** — `Scrap it. Stays readable, can be restored to Up next.`
- Footer: `Then “{next}” starts in {Area}.` + ghost **Keep current**. Esc or scrim click = Keep current.
- Result toast: `“{current}” paused. “{next}” is now active.` (finished / archived variants).

**Empty area** (`States / Empty area`): lane `2 open`, both places open; Up next shows `Up next is empty. Queue projects and books here as ideas come up; they wait until a place opens.` + **Queue a project or book**.

**Add to Up next form** (not prototyped; keep it simple): type (Project / Book), area, title, optional goal, optional initial tickets (one per line). Choosing Book opens Find a book (§3.5).

**Place toasts:** `Paused: “{title}”. {Area} project place is open.` (Done / Archived variants).

**Responsive:** 4 lanes → 2 columns < 1180 px → 1 column < 640 px.

### 3.3 Project board — `Desktop / Project board (Rust)`

| Part | Content | Interactions |
|---|---|---|
| Crumbs | `Board › {Area}` | links |
| Header | large tile, title, lamp `Active · holds the project place` or `Queued in Up next`, `{d} of {n} done` | Active: **Pause**, **Archive**, primary **Mark project done** (confirm: `Finish “{title}”? {k} open tickets will close.`). Queued: primary **Start project** (→ full-place dialog if needed) |
| Goal | one line | — |
| Columns | To do · In progress · Done (counts). Card: title + booked chip `Today 07:30` or ghost **Book time** | drag cards between columns (keyboard: card menu "Move to…"); **Add ticket** at bottom of To do (inline input, Enter to add) |
| Queued lock | In progress column shows `No work in progress while queued` / `{Area}'s project place is reserved for “{title}”. Start this project when that one is done, paused or archived.` | no Book time on queued tickets |
| Learnings | list by date, newest first | Empty: `Nothing yet. Evening review asks what you learned and saves it here.` (queued: `Learnings appear here once this project is running.`) |

**Mobile:** columns stack.

### 3.4 Evening review (4 steps) — `Desktop / Evening review 1 · Tick off` … `4 · Learned`

Header `Evening review` / `{Mon 19 Oct} · about 3 minutes`, ghost **Close**. Step bar `1. Tick off · 2. Slipped · 3. Book pages · 4. What I learned` (steps are links; current has `aria-current="step"`). Footer: **Back**, primary `Next: {step}` / **Save review**. Draft persists between steps; nothing is committed until Save.

| Step | Title / lead | Content | Rules |
|---|---|---|---|
| 1 Tick off | `What got done today?` / `Tick everything you finished. Partly done counts as not done; it moves to the next step.` | today's tickets: checkbox, tile, title, project, `Booked 07:30` / `Not booked` | ticked → `done` on save |
| 2 Slipped | `{n} tickets slipped. Where do they go?` / `Nothing gets silently carried over. Pick a spot for each one.` | per ticket, single-choice: `Tomorrow {first free start}` · `Tomorrow, unbooked` · `Pick a time` (opens Book time with Tomorrow) · `Back to To do` | each slipped ticket needs a choice; default = first option. Past booking for a slipped ticket is left on Google as history, not moved silently |
| 3 Book pages | `Which page are you on?` / `Only your active books. Leave it unchanged if you didn't read today.` | active books: cover, title, author · area, `Yesterday: p. {n}`, numeric input `p. [ ] / {pages}` | 0 ≤ page ≤ pageCount; if page = pageCount, offer `Mark as read` (frees the place) |
| 4 What I learned | `What did you learn today?` / `A sentence or two, in your own words. It's saved on the book or project you pick, and shows up on its page.` | single-select chips of active books and projects (tile + title); textarea, placeholder `e.g. Write-ahead logs make crash recovery cheap because…` | optional; if text entered, exactly one target required. One learning per save in v1 |

**Saved state:** `Review saved. Good night.` / `{d} tickets done, {m} moved, {k} page update(s), {l} learning saved on {title}.` + `Tomorrow starts with {time} “{ticket}”` + **See tomorrow's plan**.
**No tickets today:** step 1 shows `No tickets were planned today.` and steps 1–2 are skippable. **Mobile:** single column; slipped options wrap below.
A review can be done once per day; reopening the same evening edits the saved review.

### 3.5 Bookshelf + Find a book — `Desktop / Bookshelf`, `States / Missing cover`, `States / Search no results`

| Part | Content | Interactions |
|---|---|---|
| Header | `Bookshelf` / `Every book you've queued, are reading or have finished.` | primary **Find a book** |
| Filters | segmented: `All` · `Want to read` · `Reading` · `Read` with counts | filter |
| Grid | cover (2:3) with page bar if reading, title, author, tile + `p. {page} / {pages}` or status | select → detail panel (desktop, sticky right) / bottom sheet (mobile) |
| Detail | cover, title, `{author} · {pages} pages`, tile + area full name; Reading: `Page {p} of {n}` + %; Want to read: `In {Area}'s Up next.` + `Start reading, place is open` (brass) or locked `Book place reserved for “{title}”`; Read: `Read` stamp; Learnings list | Start reading follows the same rules as Board Start |
| Missing cover | title card + `No cover in the books database. Upload one` | upload image (store yourself) |

**Find a book dialog:** title `Find a book`; field `Title, author or ISBN` (placeholder `e.g. The Mom Test`); `Add to Up next in` area picker (single select, required); results: cover or title card, title, `{author} · {year} · {pages} pages`, `No cover found. We'll use a title card.` when missing, **Add**. Empty query: `Start typing to search.` No results: `No books match “{q}”.` / `Check the spelling, try the author's surname, or paste the ISBN from the back cover.` + **Add it by hand** (title, author, pages). Error: `Couldn't reach the books database. Try again, or add it by hand.` Debounce 300 ms; min 2 chars. Duplicate (same externalId/ISBN already on shelf): show `Already on your shelf` instead of Add.
**Mobile:** 3-column grid, authors hidden; detail as bottom sheet (max 82 vh) with close button.

### 3.6 Calendar (week) — `Desktop / Calendar`, `States / Calendar · …`

| Part | Content | Interactions |
|---|---|---|
| Header | `Week of 19 October`; sub (desktop) `Drag a ticket into free time. It lands as a 1 h block; drag its bottom edge to change the length.` (mobile) `Tap a ticket, then tap free time. It lands as 1 h; adjust the end after.` | account toggles (show/hide Personal, Work); week nav ‹ This week › |
| Not booked yet | `Not booked yet · {n}`: unbooked, not-done tickets of active projects; card: grip, title, tile + project | drag; or click/tap to pick (`aria-pressed`), hint `Now tap a free spot on the week to book it.` |
| Week grid | Mon–Sun, 07:00–23:00, 44 px/hour; today column `today` tint + date in brass; now-line | Work events: dashed `work-line` outline + lock icon; Personal: raised fill; Booked tickets: area tint + bottom grip |

Drop/resize behaviour in §4.3–4.4. **Mobile (< 640):** 3 day columns; Not booked yet becomes a horizontal scroller above the grid. All-day events: show in a strip above the grid (not prototyped; keep compact, read-only).

### 3.7 Paused & archived drawer — `Desktop / Paused & archived drawer`

Right drawer 440 px (full width on mobile), scrim `--scrim`. Title `Paused & archived`, close. Tabs `Paused {n}` / `Archived {n}`. Includes **projects and books**.

| Item | Paused | Archived |
|---|---|---|
| Row | tile, title, `{Area} · Paused {2 Oct} · {5 of 12 tickets done}` (book: `p. {n} of {m}`) | `{Area} · Archived {12 Sep}` |
| Action | place Open → brass **Resume** + `Place is open`; Reserved → disabled Resume + `{Area} project place is reserved for “{title}”` | `Archived` stamp + ghost **Restore to Up next** |

Empty: `Nothing paused.` / `Nothing archived.` + `Pausing or archiving from the Board puts items here.` Esc closes; focus returns to the opener.

### 3.8 First run — `Desktop / First run`, `Mobile / First run`

Side panel (leather): wordmark, `Four areas. Two places at each.`, `Every area keeps one place for a project and one for a book. Everything else waits in Up next until a place opens.`, the four areas with two empty place marks (desktop only).
Main: `Set up in two steps` / `Connect your calendars, then reserve your first place. You can add the rest later.`

1. `Connect your Google calendars` — two account cards: **Personal account** `{email} · reads events and creates events when you book time` → `Connected` chip after OAuth; **Work account** `Read-only. Meetings show as busy time; nothing is ever written here.` → primary **Connect Google**. Note `You can skip Work for now; Today and the week view will show Personal only.`
2. `Reserve your first place` — `Pick an area and add the one project or book you're working on now. Add more to Up next whenever you like.` Four area buttons (`Project place open · Book place open`) → opens the Add form pre-set to that area, starts it immediately.

Footer: primary **Continue →**, ghost **Skip setup**. Personal is required before booking works; app is usable read-only without it. Shown until Personal is connected or setup is skipped; re-enterable from settings.
**Mobile:** single column; account cards put the status/button on their own row (button full width). No horizontal overflow at 390 px.

---

## 4. Book time & calendar behaviour

### 4.1 Book time popover (`States / Book time popover`, `· 2 h preset`, `· overlap · Book anyway`)

| Control | Behaviour |
|---|---|
| Title | `Book time for “{ticket}”` |
| Day | segmented **Today** / **Tomorrow** (default Today; after 21:45 default Tomorrow) |
| Start | up to 4 chips = starts of the next free gaps ≥ 15 min across **all connected calendars + existing bookings**, from max(now + 15 min, 07:00) rounded up to :00/:15/:30/:45, before 22:00; or `or [time]` input (15-min step). First chip preselected |
| Length | chips **30 min** / **1 h** (default) / **2 h**; or `or ends at [time]`; custom end must be > start |
| Fit line (`aria-live="polite"`) | free: `Free until 09:30 (“Standup”)` or `Free for the rest of the day`; overlap (alert colour, warning icon): `Overlaps “Standup” 09:30–09:45` |
| Primary | `Book today 08:30–09:30`; on overlap `Book anyway today 08:30–11:30`. **Overlaps are allowed** (confirmed) |
| Footnote | lock icon + `Creates an event on your Personal Google calendar. Work stays read-only.` |
| Result | toast `Booked today 08:30–09:30 on Personal calendar`; ticket shows the time chip; Today timeline updates |

Mobile (< 640): bottom sheet, full width. Esc closes; focus starts on the first start chip and returns to the Book time button.
Rebooking a booked ticket: clicking its time chip opens the same popover prefilled, primary `Move to …`, plus ghost `Remove booking`.

### 4.2 Free-start algorithm (reference: `freeStarts()` in `app.js`)

```
busy = events(work ∪ personal, busy only, not all-day) ∪ bookedEvents  for the day, sorted
cur  = ceil15(max(from, 07:00))
for [s,e] in busy ∪ [[22:00, 24:00]]:
    if s − cur ≥ 15 min: emit cur (stop at 4)
    cur = max(cur, ceil15(e))
```
Treat events with `transparency = transparent` (Google "Free") as not busy. Declined events are not busy.

### 4.3 Drag / tap to book (week view)

- Drop (or pick then tap) creates a **1 h block** at the snapped start (15-min grid, clamped to 07:00–23:00). Ghost label `17:00–18:00 · 1 h, resize after`.
- Drop target overlaps an event → ghost `Overlaps an event`, drop rejected with toast `That overlaps an event. Drop it into free time.` (prototype behaviour; see §9 for the open question vs popover).
- Success toast `Booked {Tue 20} 17:00–18:00 on Personal calendar`; card leaves Not booked yet; block animates in.
- **Keyboard alternative (required):** focus a ticket card → Enter/Space picks it → arrow keys move a focus cursor over 15-min slots (←/→ day, ↑/↓ 15 min) → Enter books 1 h; Esc cancels. Or use Book time from the card's menu.

### 4.4 Resize

- Bottom grip on every booked-ticket block; drag in **15-minute steps**; minimum 15 min; max end 23:00; label updates live (`15:00–16:45`).
- Will not resize into another event (stops at the boundary).
- Keyboard: grip is `role="slider"`, focusable, `aria-valuetext="{end}"`; ↑/↓ = −/+ 15 min.
- On release: PATCH Google event; toast `Now 15:00–16:45 on Personal calendar`.
- Moving a block (drag body) is v1.1; in v1 move via the popover.

### 4.5 Google Calendar integration

| Topic | Spec |
|---|---|
| Accounts | Two separate OAuth grants: Personal (required for booking) and Work (optional). Store refresh tokens encrypted |
| Writes | **Only** to the personal account's `writeCalendarId` (default `primary`). Never write to Work. Server rejects any write for `role = work` |
| Event content | summary = ticket title; description = `Booked from Organizer · {Project}`; `extendedProperties.private.organizerTicketId = {ticketId}`; no attendees; default reminders |
| Create / update / delete | `events.insert`, `events.patch`, `events.delete` on the personal calendar |
| Read | `events.list` per selected calendar with `singleEvents=true`, `timeMin/timeMax` window (e.g. −7 to +28 days), then incremental with `syncToken`. HTTP 410 → drop token, full resync |
| Freshness | poll every 5 min while the app is open + on focus; optionally `events.watch` push channels (need a public HTTPS endpoint; channels expire, renew) |
| Edits made in Google | if a BookedEvent is moved in Google, update start/end from Google (Google wins). If deleted in Google, unbook the ticket and show it in Not booked yet |
| Time zones | use the calendar's time zone from `calendars.get` / settings; store UTC |

**Suggested OAuth scopes (least privilege):**

| Account | Scope | Why |
|---|---|---|
| Work | `https://www.googleapis.com/auth/calendar.events.readonly` | event titles and times for display (titles are shown, so `calendar.freebusy` alone is not enough) |
| Work (optional) | `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | let the user pick which work calendars to show |
| Personal | `https://www.googleapis.com/auth/calendar.events.owned` | read and create/change/delete events on calendars the user owns (covers `primary`) |
| Personal (alternative) | `https://www.googleapis.com/auth/calendar.events` | if events from calendars shared *to* the user must also be read |
| Personal (optional) | `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | calendar picker |

Avoid the full `https://www.googleapis.com/auth/calendar` scope. Scopes listed per Google's *Choose Google Calendar API scopes* page. For a private single-user app, keep the OAuth client in Testing with Bine as test user, or complete verification if published.

### 4.6 Failure handling

| Failure | Detect | UI | System |
|---|---|---|---|
| Network / 5xx / 429 on read | request error | Calendar panels show last cached data + quiet line `Calendar last updated {14:05}. Retrying…` | exponential backoff (1 s → 60 s), max 5 tries, then every 5 min |
| Write fails (create/patch/delete) | error on insert/patch | keep the block shown as **pending** (dashed brass outline), toast `Couldn't save to Google Calendar. Retrying.`; after final failure: `Not saved to Google. Try again` with **Retry** / **Undo** | BookedEvent `syncState = failed`; idempotent retry (store a client request id; check `organizerTicketId` before insert to avoid duplicates) |
| Token revoked / expired refresh (`invalid_grant`, 401 after refresh) | auth error | account status `needs_reconnect`; rail legend shows `Personal · reconnect`; banner-free inline message on Today and Calendar: `Personal calendar disconnected. Reconnect to book time.` + **Reconnect**. Book time buttons disabled with the same reason | stop polling that account; keep cached events greyed for 24 h, then hide |
| Work disconnected | same | `Work calendar disconnected. Busy times from Work aren't shown.` + **Reconnect** | booking still works; free-start chips use Personal only |
| Insufficient scope (403) | error reason | `Organizer needs permission to create events. Reconnect and allow calendar access.` | re-run OAuth with the required scope |
| Sync token invalid (410) | status 410 | none | full resync |

---

## 5. Books API

Suggested provider: **Open Library** (free, no key). Alternatives (Google Books) are fine if the same fields are available.

| Need | Endpoint |
|---|---|
| Search | `GET https://openlibrary.org/search.json?q={query}&fields=key,title,author_name,first_publish_year,number_of_pages_median,cover_i,isbn,editions&limit=10` (also `title=`, `author=` params) |
| Edition details (pages, ISBN) | `GET https://openlibrary.org/books/{OLID}.json` (e.g. `/books/OL7440033M.json`) or `GET https://openlibrary.org/isbn/{isbn}.json` → `number_of_pages` |
| Cover by cover id (preferred, not rate-limited) | `https://covers.openlibrary.org/b/id/{cover_i}-{S|M|L}.jpg` |
| Cover by ISBN / OLID | `https://covers.openlibrary.org/b/isbn/{isbn}-M.jpg`, `https://covers.openlibrary.org/b/olid/{OLID}-M.jpg` |
| Detect missing cover | append `?default=false` → 404 when no cover (default returns a blank image) |

Notes from Open Library docs: lookups by ISBN/OCLC/LCCN are limited to **100 requests per IP per 5 minutes** (403 when exceeded), cover-ID and OLID lookups are not; don't crawl; use `covers.openlibrary.org` URLs in `src`; a courtesy link back to Open Library is appreciated (put it in About/footer). Send a descriptive `User-Agent` with an app name and contact. Cache search results for 24 h and store the chosen cover URL (or a copy) with the book.

**Cover fallback (title card):** when `cover_i` is absent or the image 404s/errors → render a 2:3 card in the book's area tint with the title (Inter 600) and author (400), `role="img"`, `aria-label="No cover found for {title}"`. Search results show `No cover found. We'll use a title card.`; detail shows `No cover in the books database. Upload one`.

**Page count:** take the selected edition's `number_of_pages`; else the work's `number_of_pages_median`; else ask on add (`How many pages?`, numeric, required to track progress). Always editable from the book detail. If pageCount changes below currentPage, clamp currentPage. Progress % = currentPage / pageCount, rounded.

---

## 6. Missed evening review

- A day's review is "missed" if no review was saved by 04:00 the next morning (local time).
- **Skip it.** No catch-up flow, no stacked reviews, no streaks, no counts, no badges.
- Next morning, Today shows at most **one** quiet line above the reservation book: moon icon + `No review last night. Tonight starts fresh.` + ghost **Dismiss**. Colour Vellum (`ink-3`), no background, no banner.
- Dismiss hides it for that day (persist). It never shows for more than one missed night, and never if the user dismissed it already that day.
- Tickets from the missed day: stay as they are (unticked tickets keep status; past bookings stay on Google). They appear on the next review only if planned/booked for that day.
- Prototype: `index.html?state=skipped` · Figma `States / Skipped review note`.

---

## 7. Design tokens, components, accessibility, responsive

Dark only (`color-scheme: dark`). No light theme, no toggle. The PDF of this document is dark-on-light for printing only.

### 7.1 Colour variables

| CSS variable | Hex | Use |
|---|---|---|
| `--ground` | `#15100b` | page background |
| `--panel` | `#1f1812` | panels, cards |
| `--panel-2` | `#2a2119` | secondary buttons, popovers, choices |
| `--raised` | `#33291f` | hover, personal events, toast |
| `--well` | `#120d09` | inputs |
| `--today` | `#1b150f` | today column in week view |
| `--line` | `#46382a` | default borders |
| `--line-2` | `#2f251c` | faint dividers, hour lines |
| `--line-strong` | `#5c4a37` | checkbox border, strong seams |
| `--work-line` | `#7d6a52` | dashed outline of work events |
| `--ink` | `#f1e7d3` | primary text |
| `--ink-2` | `#cdbd9f` | secondary text, "Reserved" |
| `--ink-3` | `#a8977b` | meta, muted, skipped note |
| `--brass` | `#c9a55a` | primary button, focus ring, open-place ring |
| `--brass-hi` | `#dbb96e` | brass text, links, "Open", primary hover |
| `--brass-ink` | `#1a130c` | text on brass |
| `--brass-soft` | `#2f2617` | selected fills, open-place button, booked chip |
| `--brass-line` | `#8a7140` | dashed open-place outline, place card border |
| `--brass-edge` | `#4d3f24` | inset edge on selected nav/segments |
| `--brass-press` | `#3a2f1c` | pressed open-place button |
| `--selection` | `#6b5530` | text selection |
| `--leather` | `#13221b` | rail, tab bar, onboarding side |
| `--leather-2` | `#1a2e24` | rail hover |
| `--leather-ink` | `#e9dfca` | rail text |
| `--leather-ink-2` | `#b8b29a` | rail secondary text |
| `--leather-line` | `#22382d` | rail borders |
| `--tech` / `--tech-tint` | `#84b3a5` / `#1c2a26` | Tech marker / reserved tint |
| `--sales` / `--sales-tint` | `#d69a6d` / `#2d2119` | Sales & Business |
| `--ship` / `--ship-tint` | `#cf8a93` / `#2d1c20` | Product Shipping |
| `--self` / `--self-tint` | `#a99ad0` / `#232031` | General |
| `--tile-ink` | `#17110b` | letter on area tiles |
| `--done` / `--done-soft` / `--done-line` / `--done-ink` | `#8fac7f` / `#1f2a1c` / `#4b5d41` / `#142010` | done ticks, stamps |
| `--alert` / `--alert-soft` | `#e0a093` / `#3a1c19` | overlap warning, destructive confirm only |
| `--scrim` | `rgba(8,5,3,.62)` | dialog/drawer scrim |
| `--brass-wash` | `rgba(201,165,90,.10)` | subtle brass hover |
| `--alert-wash` | `rgba(224,160,147,.08)` | overlap ghost fill |

Rules: brass only for actions and open places; area colour solid only on the tile (always with its letter); no traffic-light greens/reds, glows, gradients-as-material, faux leather.

### 7.2 Type (Inter only, self-hosted woff2, latin + latin-ext; 400/500/600; no italics)

| Token | Size / weight / line-height | Use |
|---|---|---|
| display | 30 / 600 / 1.15, −0.015em | page titles (24 under 900 px) |
| step-title | 24 / 600 / 1.2 | review step titles |
| card-word | 22 / 600 / 1 | place card "Reserved" |
| brand | 21 / 600 / 1 | wordmark |
| headline | 19 / 600 / 1.25 | panel headings |
| headline-sm | 18 / 600 / 1.25 | lane headings |
| title-lg | 17 / 600 / 1.2 | book titles in review |
| title | 16 / 600 / 1.3 | card titles |
| body | 15 / 400 / 1.5 | default text, tickets (ticket titles 500) |
| ui | 14 / 600 / 1.3 | buttons, nav (nav 500) |
| small | 13 / 400 / 1.35 | meta |
| caption | 12 / 500 / 1.3 | labels, tab bar |
| counter | 40 / 500 / 1, −0.03em | open-places counter (30 under 640 px) |

`font-feature-settings: "calt" 0` (keeps `--follow` literal); `font-variant-numeric: lining-nums` globally; `tabular-nums` only on time-bearing elements (hour labels, time chips, booked chips, counter, time inputs). Sentence case; no uppercase eyebrows. "Open" = brass-hi 500; "Reserved" = ink-2 500.

### 7.3 Spacing, radius, elevation, focus, motion

| Group | Values |
|---|---|
| Spacing | 6 · 10 · 16 · 22 · 36 px (xs → xl) |
| Radius | 2 grip · 3 swatch · 4 cover/stamp · 6 tile/place card/focus · 8 button/input/chip/nav · 10 place/card · 12 panel/popover · 16 dialog · 20 sheet/pill |
| Elevation | `--shadow: 0 1px 2px rgba(0,0,0,.35), 0 8px 22px rgba(0,0,0,.30)`; `--shadow-lift: 0 6px 14px rgba(0,0,0,.45), 0 22px 48px rgba(0,0,0,.50)` — only on popovers, menus, dialogs, drawer, toasts, sheets |
| Focus ring | `:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; border-radius: 6px }` — never removed |
| Motion | easing `cubic-bezier(.16,1,.3,1)`; hover 150 ms; popover/menu 200–220 ms (fade + 4 px rise); dialog 280 ms; drawer 320 ms (slide 30 px); booked block "land" 600 ms (scaleY .6 → 1). `prefers-reduced-motion: reduce` → no animation or transition |
| Sizes | buttons 38 / 32 px; inputs 42 px; checkbox 22 px; tiles 20 / 26 / 40 px; rail 236 px; popover 340 px; drawer 440 px; dialog max 580 px |

### 7.4 Component inventory

| Component | Variants / states | Figma |
|---|---|---|
| Button | Primary (≤1 per view), Secondary, Ghost, Open place; Default 38 / Small 32; hover, active (1 px down), focus, disabled (`aria-disabled` + reason text) | `Button` |
| Icon button | 34 px square, transparent → raised on hover; always `aria-label` | — |
| Segmented control | 2–4 options, selected = brass-soft + brass-edge inset | — |
| Chip button (time/length) | default, pressed (`aria-pressed`) | — |
| Lamp (place state) | Open (brass ring), Reserved (cream disc), Paused (vellum ring) | `Lamp` |
| Area tile | T/S/P/G × Small/Default/Large | `Area tile` |
| Ticket row | Open (Book time), Booked (time chip), Done (moss tick, strikethrough); In progress pill | `Ticket row` |
| Place (board) | Reserved project, Reserved book, Open project, Open book | — |
| Place card | Reserved (dialog header) | `Place card` |
| Reservation book | 8 places, counter; 4 → 2×2 cells | — |
| Popover / bottom sheet | Book time; fit line ok / overlap | — |
| Menu | place actions | — |
| Dialog | full-place, find a book, confirm finish | — |
| Drawer | Paused / Archived tabs | — |
| Calendar event block | work (dashed, lock), personal, booked ticket (area tint, grip), pending, failed, new | — |
| Ghost slot | ok / overlap | — |
| Book cover | image, title card fallback, with page bar | — |
| Toast | status | — |
| Input / textarea / time input | default, focus, error (alert text below) | — |
| Quiet note | skipped review | — |
| Empty state | title + one line + optional action | — |

### 7.5 Accessibility requirements

- **Contrast:** every text/surface pair ≥ 4.5:1 (AA); non-text marks ≥ 3:1. Verified pairs:

| Pair | Ratio | Pair | Ratio |
|---|---|---|---|
| ink on ground | 15.4 | brass-hi on brass-soft | 7.92 |
| ink-2 on panel | 9.5 | tile-ink on tech / sales / ship / self | 8.0 / 7.76 / 6.87 / 7.33 |
| ink-3 on panel | 6.16 | alert on panel-2 | 7.23 |
| ink-3 on panel-2 | 5.55 | done on panel | 6.99 |
| brass-hi on panel | 9.33 | tech / sales / ship / self on panel | 7.49 / 7.27 / 6.44 / 6.86 |
| brass-ink on brass | 7.89 | ink on tech-tint | 12.15 |
| leather-ink on leather | 12.48 | ink-2 on ship-tint | 8.76 |
| leather-ink-2 on leather | 7.76 | ink-2 on ground | 10.24 |

  Any new pair must be measured before use.
- **Colour is never the only cue:** area = colour + letter + name; place state = mark + word; overlap = icon + text.
- **Keyboard:** everything operable without a pointer. Drag-to-book has the pick-then-place keyboard flow (§4.3); resize grip is a slider (↑/↓ 15 min); Up next and project cards have "Move to…/Move up/down" menu actions.
- **Dialogs & popovers:** `role="dialog"`, `aria-modal="true"` for dialogs, labelled by their heading; focus moves to the first meaningful control (first choice / first start chip / search input); focus trapped in modal dialogs and sheets; Esc closes; focus returns to the trigger. Drawer: same.
- **Menus:** `role="menu"`/`menuitem`, arrow-key navigation, Esc returns focus.
- **Live regions:** toasts `role="status"`; fit line `aria-live="polite"`; book detail `aria-live="polite"`.
- **Forms:** visible labels (or `sr-only` labels for the page input), errors in text, `inputmode="numeric"` for pages.
- **Reduced motion:** honour `prefers-reduced-motion` (no animation/transition).
- **Targets:** ≥ 24×24 px (WCAG 2.2 AA); primary touch targets 32–38 px.
- **Language & locale:** `lang="en"`, en-GB dates (`Monday, 19 October`), 24 h times, en dash in ranges (`08:30–09:30`).

### 7.6 Responsive breakpoints

| Width | Changes |
|---|---|
| > 1180 | full layout: rail + 4 board lanes; reservation book 1 × (counter + 4 cells); shelf grid + sticky detail |
| ≤ 1180 | board 2 columns; reservation book 2 × 2 with counter row; shelf detail below grid |
| ≤ 900 | rail → bottom tab bar (5 items, safe-area padding); mobile header; Today single column; project columns stack; calendar sidebar above grid, horizontal scroller; book detail → bottom sheet |
| ≤ 640 | board 1 column; week view 3 days; popover → bottom sheet; full-place choices stack; shelf 3 columns, authors hidden; drawer full width |
| 390 | reference phone width; **no horizontal overflow on any screen** |

---

## 8. Acceptance criteria & out of scope

### 8.1 Acceptance checklist

**Places & states**
- [ ] Each area shows exactly one project place and one book place, each Open or Reserved.
- [ ] Server rejects a second active project or book in an area (unique constraint + API error); UI never offers an override.
- [ ] Start on a Reserved place opens the full-place dialog; Finish/Pause/Archive + start happens in one transaction; Keep current changes nothing.
- [ ] Pause opens the place; paused item appears in the drawer with Resume.
- [ ] Resume is disabled with the reason when the place is Reserved, enabled when Open.
- [ ] Archive opens the place; Restore to Up next returns it to the end of Up next.
- [ ] Finishing a project closes all its open tickets and deletes their future bookings from Google.
- [ ] Queued projects cannot move tickets to In progress or book time (UI hidden + server rejects).
- [ ] Reservation book counter equals the number of Open places (0–8).

**Today**
- [ ] Shows today's tickets of active projects grouped by area, with booked times or Book time.
- [ ] Ticking a ticket marks it done (persisted) and updates counts.
- [ ] Timeline shows Work (dashed, lock), Personal, and booked tickets for 07:00–22:00 with a now-line.
- [ ] No-events and calendar-error states render as specified.

**Book time**
- [ ] Today/Tomorrow; up to 4 free-start chips computed from both calendars and existing bookings; custom start in 15-min steps.
- [ ] 30 min / 1 h / 2 h / custom end; end must be after start.
- [ ] Fit line shows free-until or overlap; overlap changes the button to "Book anyway …" and still books.
- [ ] Booking creates exactly one event on the Personal calendar (none on Work), with `organizerTicketId`; retries never duplicate.
- [ ] Bottom sheet under 640 px; Esc and focus return work.

**Calendar**
- [ ] Drag or pick-then-tap creates a 1 h block on the 15-min grid; overlap drop rejected with message.
- [ ] Keyboard pick-and-place works without a pointer.
- [ ] Resize by grip in 15-min steps, min 15 min, cannot cross another event; ↑/↓ on focused grip.
- [ ] Changes made in Google (move/delete) reflect within one sync cycle.
- [ ] Revoked token → reconnect state, Book time disabled with reason; cached data shown.

**Evening review**
- [ ] Four steps; draft persists across steps; nothing saved until Save review.
- [ ] Every slipped ticket gets exactly one destination; "Pick a time" opens Book time for Tomorrow.
- [ ] Page update validated 0..pageCount; reaching the last page offers Mark as read.
- [ ] A learning with text requires exactly one target book or project; it appears on that item's page.
- [ ] Saved summary shows counts and tomorrow's first booking.

**Missed review**
- [ ] One quiet dismissible note the morning after a missed review; never more than one; no counts or streaks.

**Bookshelf & books**
- [ ] Filters All / Want to read / Reading / Read with counts.
- [ ] Find a book searches Open Library (debounced), shows covers or "No cover found", adds to the chosen area's Up next.
- [ ] No-results and error states with "Add it by hand".
- [ ] Missing cover renders the title card everywhere (board, shelf, review, detail).
- [ ] Page count from edition → work median → asked on add; editable.

**First run**
- [ ] Personal OAuth connects; Work optional and skippable; first place can be reserved; Skip setup works.
- [ ] No horizontal overflow at 390 px.

**Design & a11y**
- [ ] Only Inter 400/500/600; no italics anywhere.
- [ ] All tokens from §7.1; no light theme.
- [ ] All text pairs ≥ 4.5:1; focus ring visible on every interactive element.
- [ ] Dialog/popover/drawer focus management as §7.5; reduced motion honoured.
- [ ] Layouts match Figma frames at 1440 and 390 within normal implementation tolerance.

### 8.2 Out of scope for v1 (undecided — do not build)

| Item | Status |
|---|---|
| Standalone tickets / habits outside projects | **Undecided — out of scope** |
| Recurring tickets | **Undecided — out of scope** |
| Learnings attached to more than one item | **Undecided — out of scope** (v1: exactly one) |
| Notifications / reminders (push, email) | **Out of scope** (Google's own event reminders apply to booked events) |
| Global learnings page, search across learnings | **Out of scope by decision** |
| Time estimates, durations, story points | **Out of scope by decision** (never) |
| Streaks, stats, scores, review catch-up | **Out of scope by decision** (never) |
| Multi-user, sharing, teams | Out of scope |
| Light theme | Out of scope by decision |
| Non-Google calendars (Outlook, iCal) | Out of scope |
| Moving a booked block by dragging its body | v1.1 (v1: via popover) |
| Custom areas / renaming areas | Out of scope (four fixed areas) |
| Final Bookshelf status labels | To confirm with Bine (current: Want to read / Reading / Read) |

### 8.3 Proposed defaults in this handoff (not yet confirmed by Bine)

These fill gaps the design didn't decide. They are easy to change; confirm before building.

| Default | Where |
|---|---|
| Pausing or archiving deletes the item's **future** bookings from Google; `in_progress` tickets go back to `todo` on pause | §2 transitions |
| Book time defaults to **Tomorrow** after 21:45 | §4.1 |
| Today lists tickets that are booked today, planned for today, or in progress | §3.1 |
| A review counts as missed if not saved by 04:00 next morning | §6 |
| "Mark project done" asks for confirmation with the number of open tickets that will close | §3.3 |
| Google wins when a booked event is moved or deleted in Google | §4.5 |
| One learning per review save; reaching the last page offers "Mark as read" | §3.4 |
| Rebooking from the time chip, with "Remove booking" | §4.1 |

---

## 9. Known prototype gaps

The prototype is a static mock with example data. Where it differs from this spec, **build the spec**:

| Prototype behaviour | Spec |
|---|---|
| Book "Pause" returns the book to Up next (`want`) | Books pause like projects: state `paused`, shown in the drawer |
| Drawer lists projects only | Drawer lists projects and books |
| Drawer scrim has a blue tint (`rgba(8,20,45,.3)`) | use `--scrim` |
| Popover allows overlaps ("Book anyway"); calendar drop/resize blocks them | Kept as designed for v1; **open question for Bine** whether drops should also allow overlap with a warning |
| "Tue" hard-coded in booked chips for tomorrow | format the real weekday |
| Add to Up next, Add ticket, Upload cover, Pick a time, week navigation, account toggles, Add it by hand are toasts or inert | implement per §3 |
| Review step 2 uses fixed times (07:30/12:00/17:00) | use the free-start algorithm for Tomorrow |
| Ticket "today" flag | derive from booking date, `plannedFor`, or `in_progress` |
| Fonts, covers, data are local example assets | real data from APIs; keep Inter self-hosted |
