import { useEffect, useRef, useState } from "react";
import type { ReviewDraft, SlippedDestination, Ticket } from "../shared/types";
import {
  addDays,
  currentBooking,
  eventsForDay,
  localInstant,
  query,
  safe,
  shortDate,
  timeOf,
  todayTickets,
} from "./api";
import { useApp } from "./context";
import {
  Button,
  Cover,
  Empty,
  ErrorText,
  Field,
  Icon,
  PageHeader,
  Tile,
} from "./ui";

export function ReviewScreen() {
  const { state, command, navigate, setModal, refresh } = useApp();
  const existing = state.reviews.find((r) => r.date === state.reviewDate);
  const saved = Boolean(existing?.savedAt);
  const activeBooks = state.items.filter(
    (i) => i.kind === "book" && i.state === "active",
  );
  const activeItems = state.items.filter((i) => i.state === "active");
  const date = state.reviewDate;
  const tomorrow = addDays(date, 1);
  const [tickets] = useState(() => todayTickets(state, date));
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [draftState, setDraftState] = useState("");
  const [draft, setDraft] = useState<ReviewDraft>(
    () =>
      existing?.draft ?? {
        completedTicketIds: tickets
          .filter((t) => t.status === "done")
          .map((t) => t.id),
        slippedDestinations: tickets
          .filter((t) => t.status !== "done")
          .map((t) => ({
            ticketId: t.id,
            destination: { kind: "tomorrow_unbooked" },
          })),
        bookPages: activeBooks.map((b) => ({
          bookId: b.id,
          currentPage: b.currentPage ?? 0,
        })),
        markReadBookIds: [],
        learning: null,
      },
  );
  const latest = useRef(draft);
  latest.current = draft;
  const baseline = useRef({
    ...state.versions,
    [`review:${date}`]: existing?.version ?? "0",
  });
  const reviewVersion = useRef(existing?.version ?? "0");
  const persistChain = useRef<Promise<unknown>>(Promise.resolve());
  const touched = useRef(false);
  useEffect(() => {
    let active = true;
    query<any>("get_review", { date })
      .then(async (value) => {
        if (!active) return;
        await refresh();
        if (!active || touched.current) return;
        if (value.draft) setDraft(value.draft);
        baseline.current = { ...baseline.current, ...value.requiredVersions };
        reviewVersion.current = value.review?.version ?? "0";
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [date, refresh]);
  const persist = (value = latest.current): Promise<any> => {
    const run = persistChain.current
      .catch(() => undefined)
      .then(async () => {
        setDraftState("Saving draft…");
        const patch = {
          ...value,
          learning: value.learning?.text.trim() ? value.learning : null,
        };
        const result = await command(
          "update_review_draft",
          {
            date,
            patch,
            expectedVersions: {
              ...baseline.current,
              [`review:${date}`]: reviewVersion.current,
            },
          },
          true,
        );
        reviewVersion.current =
          result.data?.versions?.[`review:${date}`] ??
          result.meta?.versions?.[`review:${date}`] ??
          reviewVersion.current;
        setDraftState("Draft saved");
        return result;
      });
    persistChain.current = run;
    return run;
  };
  useEffect(() => {
    if (!dirty || saved || saving) return;
    const timer = setTimeout(() => {
      persist().catch((e) => {
        setDraftState("Draft not saved");
        setError(e.message);
      });
    }, 650);
    return () => clearTimeout(timer);
  }, [draft, dirty, saved, saving]);
  function update(patch: Partial<ReviewDraft>) {
    touched.current = true;
    setDirty(true);
    setError("");
    setDraft((d) => ({ ...d, ...patch }));
  }
  function destination(ticketId: string, value: SlippedDestination) {
    update({
      slippedDestinations: [
        ...draft.slippedDestinations.filter((d) => d.ticketId !== ticketId),
        { ticketId, destination: value },
      ],
    });
  }
  async function save() {
    setSaving(true);
    setError("");
    try {
      await persist();
      await command("save_review", {
        date,
        expectedVersions: {
          ...baseline.current,
          [`review:${date}`]: reviewVersion.current,
        },
      });
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const slipped = tickets.filter(
    (t) => !draft.completedTicketIds.includes(t.id),
  );
  const starts = availableReviewStarts(state, tomorrow, slipped);
  if (saved)
    return (
      <div className="review-shell">
        <PageHeader
          title="Evening review"
          subtitle={`${shortDate(date)} · saved`}
        >
          <Button ghost onClick={() => navigate("today")}>
            Close
          </Button>
        </PageHeader>
        <section className="panel review-saved">
          <span className="saved-mark">
            <Icon name="check" />
          </span>
          <h2>Review saved. Good night.</h2>
          <p>
            {existing?.saved?.completedTicketIds.length ?? 0} tickets done ·{" "}
            {existing?.saved?.slippedDestinations.length ?? 0} moved ·{" "}
            {existing?.saved?.bookPages.length ?? 0} page updates ·{" "}
            {existing?.saved?.learning ? 1 : 0} learning saved.
          </p>
          <p className="muted">
            This review is final. Your work and learnings are saved on their
            project or book.
          </p>
          <Button primary onClick={() => navigate("calendar")}>
            See tomorrow's plan <Icon name="next" />
          </Button>
        </section>
      </div>
    );
  return (
    <div className="review-shell">
      <PageHeader
        title="Evening review"
        subtitle={`${shortDate(date)} · about 3 minutes`}
      >
        <Button ghost onClick={() => navigate("today")}>
          <Icon name="close" />
          Close
        </Button>
      </PageHeader>
      <nav className="review-steps" aria-label="Review steps">
        {["Tick off", "Slipped", "Book pages", "What I learned"].map(
          (label, i) => (
            <button
              key={label}
              aria-current={i === step ? "step" : undefined}
              className={i <= step ? "reached" : ""}
              onClick={() => setStep(i)}
            >
              {i + 1}. {label}
            </button>
          ),
        )}
      </nav>
      <section className="panel review-panel">
        {step === 0 && (
          <>
            <h2>What got done today?</h2>
            <p className="review-lead">
              Tick everything you finished. Partly done counts as not done; it
              moves to the next step.
            </p>
            {tickets.length ? (
              tickets.map((ticket) => {
                const item = state.items.find(
                  (i) => i.id === ticket.projectId,
                )!;
                const booking = currentBooking(state, ticket);
                return (
                  <label className="review-ticket" key={ticket.id}>
                    <input
                      type="checkbox"
                      checked={draft.completedTicketIds.includes(ticket.id)}
                      onChange={(e) => {
                        const ids = e.target.checked
                          ? [...draft.completedTicketIds, ticket.id]
                          : draft.completedTicketIds.filter(
                              (id) => id !== ticket.id,
                            );
                        update({
                          completedTicketIds: ids,
                          slippedDestinations: ids.includes(ticket.id)
                            ? draft.slippedDestinations.filter(
                                (d) => d.ticketId !== ticket.id,
                              )
                            : [
                                ...draft.slippedDestinations.filter(
                                  (d) => d.ticketId !== ticket.id,
                                ),
                                {
                                  ticketId: ticket.id,
                                  destination: { kind: "tomorrow_unbooked" },
                                },
                              ],
                        });
                      }}
                    />
                    <Tile area={item.areaId} />
                    <span className="review-ticket-title">
                      <strong>{ticket.title}</strong>
                      <small>{item.title}</small>
                    </span>
                    <small>
                      {booking
                        ? `Booked ${timeOf(booking.start)}`
                        : "Not booked"}
                    </small>
                  </label>
                );
              })
            ) : (
              <Empty title="No tickets were planned today." />
            )}
          </>
        )}
        {step === 1 && (
          <>
            <h2>{slipped.length} tickets slipped. Where do they go?</h2>
            <p className="review-lead">
              Nothing gets silently carried over. Pick a spot for each one.
            </p>
            {slipped.length ? (
              slipped.map((ticket) => {
                const item = state.items.find(
                  (i) => i.id === ticket.projectId,
                )!;
                const selected = draft.slippedDestinations.find(
                  (d) => d.ticketId === ticket.id,
                )?.destination;
                const first = starts.get(ticket.id);
                return (
                  <div className="slipped-row" key={ticket.id}>
                    <div className="slipped-title">
                      <Tile area={item.areaId} />
                      <span>
                        <strong>{ticket.title}</strong>
                        <small>{item.title}</small>
                      </span>
                    </div>
                    <div
                      className="slipped-options"
                      role="group"
                      aria-label={`Destination for ${ticket.title}`}
                    >
                      <Button
                        small
                        disabled={!first}
                        aria-pressed={
                          selected?.kind === "book" &&
                          selected.start === first?.start
                        }
                        onClick={() =>
                          first &&
                          destination(ticket.id, {
                            kind: "book",
                            ...first,
                            allowOverlap: false,
                          })
                        }
                      >
                        {first
                          ? `Tomorrow ${timeOf(first.start)}`
                          : "No free start"}
                      </Button>
                      <Button
                        small
                        aria-pressed={selected?.kind === "tomorrow_unbooked"}
                        onClick={() =>
                          destination(ticket.id, { kind: "tomorrow_unbooked" })
                        }
                      >
                        Tomorrow, unbooked
                      </Button>
                      <Button
                        small
                        onClick={() =>
                          setModal({
                            type: "book",
                            ticket,
                            date: tomorrow,
                            onStage: (value) =>
                              destination(ticket.id, {
                                kind: "book",
                                ...value,
                              }),
                          })
                        }
                      >
                        {selected?.kind === "book" &&
                        selected.start !== first?.start
                          ? `Picked ${timeOf(selected.start)}`
                          : "Pick a time"}
                      </Button>
                      <Button
                        small
                        aria-pressed={selected?.kind === "back_to_todo"}
                        onClick={() =>
                          destination(ticket.id, { kind: "back_to_todo" })
                        }
                      >
                        Back to To do
                      </Button>
                    </div>
                  </div>
                );
              })
            ) : (
              <Empty title="Nothing slipped. You're ready for the next step." />
            )}
          </>
        )}
        {step === 2 && (
          <>
            <h2>Which page are you on?</h2>
            <p className="review-lead">
              Only your active books. Leave it unchanged if you didn't read
              today.
            </p>
            {activeBooks.length ? (
              activeBooks.map((book) => {
                const page =
                  draft.bookPages.find((p) => p.bookId === book.id)
                    ?.currentPage ??
                  book.currentPage ??
                  0;
                return (
                  <div className="review-book" key={book.id}>
                    <Cover item={book} />
                    <div>
                      <h3>{book.title}</h3>
                      <small>
                        {book.authors?.join(", ")} ·{" "}
                        {state.areas.find((a) => a.id === book.areaId)?.name}
                      </small>
                      <small>Yesterday: p. {book.currentPage ?? 0}</small>
                      {page === book.pageCount && (
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={draft.markReadBookIds.includes(book.id)}
                            onChange={(e) =>
                              update({
                                markReadBookIds: e.target.checked
                                  ? [...draft.markReadBookIds, book.id]
                                  : draft.markReadBookIds.filter(
                                      (id) => id !== book.id,
                                    ),
                              })
                            }
                          />
                          Mark as read, opens the place
                        </label>
                      )}
                    </div>
                    <label className="review-page">
                      p.{" "}
                      <input
                        aria-label={`Current page for ${book.title}`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={book.pageCount}
                        value={page}
                        onChange={(e) => {
                          const currentPage = Number(e.target.value);
                          update({
                            bookPages: [
                              ...draft.bookPages.filter(
                                (p) => p.bookId !== book.id,
                              ),
                              { bookId: book.id, currentPage },
                            ],
                            markReadBookIds:
                              currentPage === book.pageCount
                                ? draft.markReadBookIds
                                : draft.markReadBookIds.filter(
                                    (id) => id !== book.id,
                                  ),
                          });
                        }}
                      />{" "}
                      / {book.pageCount}
                    </label>
                  </div>
                );
              })
            ) : (
              <Empty title="No books are active right now.">
                <p>Start a book from Up next when you're ready to read.</p>
              </Empty>
            )}
          </>
        )}
        {step === 3 && (
          <>
            <h2>What did you learn today?</h2>
            <p className="review-lead">
              A sentence or two, in your own words. It's saved on the book or
              project you pick, and shows up on its page.
            </p>
            <div
              className="learning-targets"
              role="group"
              aria-label="Save learning on"
            >
              {activeItems.map((item) => (
                <Button
                  small
                  key={item.id}
                  aria-pressed={draft.learning?.target.id === item.id}
                  onClick={() =>
                    update({
                      learning: {
                        text: draft.learning?.text ?? "",
                        target: { kind: item.kind, id: item.id },
                      },
                    })
                  }
                >
                  <Tile area={item.areaId} />
                  {item.title}
                </Button>
              ))}
            </div>
            <Field label="What I learned (optional)">
              <textarea
                rows={5}
                maxLength={2000}
                value={draft.learning?.text ?? ""}
                placeholder="e.g. Write-ahead logs make crash recovery cheap because…"
                onChange={(e) => {
                  const target = draft.learning?.target;
                  if (!target && e.target.value) {
                    setError(
                      "Pick the book or project this learning belongs to.",
                    );
                    return;
                  }
                  update({
                    learning: target ? { text: e.target.value, target } : null,
                  });
                }}
              />
            </Field>
            {!activeItems.length && (
              <p className="muted">
                There are no active books or projects to attach a learning to.
                You can save the review without a learning.
              </p>
            )}
            <small>Each book and project keeps its own learnings.</small>
          </>
        )}
      </section>
      <ErrorText message={error} />
      <footer className="review-footer">
        <div>
          {step > 0 && (
            <Button ghost onClick={() => setStep((n) => n - 1)}>
              ‹ Back
            </Button>
          )}
          <small role="status">{draftState}</small>
        </div>
        {step < 3 ? (
          <Button primary onClick={() => setStep((n) => n + 1)}>
            Next: {["", "Slipped", "Book pages", "What I learned"][step + 1]}{" "}
            <Icon name="next" />
          </Button>
        ) : (
          <Button primary disabled={saving} onClick={() => safe(save())}>
            <Icon name="check" />
            {saving ? "Saving…" : "Save review"}
          </Button>
        )}
      </footer>
      <p className="review-final-note">Saving makes this review final.</p>
    </div>
  );
}
function availableReviewStarts(
  state: ReturnType<typeof useApp>["state"],
  date: string,
  tickets: Ticket[],
) {
  const values = new Map<string, { start: string; end: string }>();
  if (
    !state.connections.some(
      (c) => c.role === "personal" && c.status === "connected",
    )
  )
    return values;
  const busy = eventsForDay(state, date)
    .filter((e) => e.isBusy)
    .map((e) => [Date.parse(e.start!), Date.parse(e.end!)]);
  for (const ticket of tickets) {
    for (let minute = 420; minute <= 1320; minute += 15) {
      const time = (value: number) =>
        `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
      const start = localInstant(date, time(minute));
      const end = localInstant(date, time(minute + 60));
      const s = Date.parse(start),
        e = Date.parse(end);
      if (s <= Date.now() || busy.some(([a, b]) => a < e && b > s)) continue;
      values.set(ticket.id, { start, end });
      busy.push([s, e]);
      break;
    }
  }
  return values;
}
