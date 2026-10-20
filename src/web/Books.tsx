import { useEffect, useState, type FormEvent } from "react";
import type { BookCandidate, Item } from "../shared/types";
import {
  ApiError,
  formatAudiobookProgress,
  formatDuration,
  isAudiobook,
  request,
  safe,
  splitDuration,
} from "./api";
import { useApp } from "./context";
import {
  areaNames,
  Button,
  Cover,
  Empty,
  ErrorText,
  Field,
  Icon,
  Modal,
  PageHeader,
  Progress,
  Segment,
  Tile,
} from "./ui";
import { ItemActions, LearningList } from "./Core";

export function Bookshelf({ selectedId }: { selectedId?: string }) {
  const { state, navigate, setModal, openItem } = useApp();
  const [filter, setFilter] = useState("all");
  const [mobile, setMobile] = useState(matchMedia("(max-width:900px)").matches);
  useEffect(() => {
    const query = matchMedia("(max-width:900px)");
    const listener = () => setMobile(query.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);
  const books = state.items.filter(
    (i) => i.kind === "book" && i.state !== "archived",
  );
  const displayed = books.filter((b) => filter === "all" || b.state === filter);
  const selected = state.items.find(
    (i) => i.id === selectedId && i.kind === "book",
  );
  return (
    <>
      <PageHeader
        title="Bookshelf"
        subtitle="Every book you've queued, are reading or have finished."
      >
        <Button primary onClick={() => setModal({ type: "find" })}>
          <Icon name="search" />
          Find a book
        </Button>
      </PageHeader>
      <div className="shelf-toolbar">
        <Segment
          label="Bookshelf filter"
          value={filter}
          onChange={setFilter}
          values={[
            { id: "all", label: `All ${books.length}` },
            {
              id: "queued",
              label: `Want to read ${books.filter((b) => b.state === "queued").length}`,
            },
            {
              id: "active",
              label: `Reading ${books.filter((b) => b.state === "active").length}`,
            },
            {
              id: "done",
              label: `Read ${books.filter((b) => b.state === "done").length}`,
            },
          ]}
        />
        <small>Covers and details from the books database</small>
      </div>
      <div
        className={`shelf-layout ${selected && !mobile ? "with-detail" : ""}`}
      >
        <div>
          {displayed.length ? (
            <div className="books-grid">
              {displayed.map((book) => (
                <button
                  className={`shelf-book ${selected?.id === book.id ? "selected" : ""}`}
                  key={book.id}
                  onClick={() => openItem(book)}
                >
                  <Cover item={book} />
                  {book.state === "active" && (
                    <Progress
                      current={
                        isAudiobook(book)
                          ? (book.positionMinutes ?? 0)
                          : (book.currentPage ?? 0)
                      }
                      total={
                        isAudiobook(book)
                          ? (book.durationMinutes ?? 1)
                          : (book.pageCount ?? 1)
                      }
                    />
                  )}
                  <strong>{book.title}</strong>
                  <span className="shelf-author">
                    {book.authors?.join(", ") || "Unknown author"}
                  </span>
                  <small>
                    <Tile area={book.areaId} />
                    {book.state === "active"
                      ? isAudiobook(book)
                        ? formatAudiobookProgress(
                            book.positionMinutes ?? 0,
                            book.durationMinutes ?? 0,
                          )
                        : `p. ${book.currentPage ?? 0} / ${book.pageCount}`
                      : book.state === "queued"
                        ? "Want to read"
                        : book.state === "done"
                          ? "Read"
                          : "Paused"}
                  </small>
                </button>
              ))}
            </div>
          ) : (
            <section className="panel">
              <Empty
                title={
                  books.length
                    ? "No books in this view."
                    : "A place for what you read."
                }
              >
                <p>
                  {books.length
                    ? "Choose another filter to see your books."
                    : "Find a book, add it to an area’s Up next, and start when its book place is open."}
                </p>
                <Button onClick={() => setModal({ type: "find" })}>
                  Find a book
                </Button>
              </Empty>
            </section>
          )}
        </div>
        {selected && !mobile && (
          <BookDetail item={selected} onClose={() => navigate("bookshelf")} />
        )}
      </div>
      {selected && mobile && (
        <Modal
          title={selected.title}
          onClose={() => navigate("bookshelf")}
          className="book-detail-sheet"
        >
          <BookDetail item={selected} onClose={() => navigate("bookshelf")} />
        </Modal>
      )}
    </>
  );
}
function BookDetail({ item, onClose }: { item: Item; onClose: () => void }) {
  const { state, command, start, busy } = useApp();
  const audio = isAudiobook(item);
  const [page, setPage] = useState(item.currentPage ?? 0);
  const [hours, setHours] = useState(
    () => splitDuration(item.positionMinutes ?? 0).hours,
  );
  const [minutes, setMinutes] = useState(
    () => splitDuration(item.positionMinutes ?? 0).minutes,
  );
  const [progressError, setProgressError] = useState("");
  useEffect(() => setPage(item.currentPage ?? 0), [item.currentPage, item.id]);
  useEffect(() => {
    const parts = splitDuration(item.positionMinutes ?? 0);
    setHours(parts.hours);
    setMinutes(parts.minutes);
    setProgressError("");
  }, [item.positionMinutes, item.id]);
  const holder = state.items.find(
    (i) =>
      i.state === "active" &&
      i.kind === "book" &&
      i.areaId === item.areaId &&
      i.id !== item.id,
  );
  return (
    <aside className="panel book-detail" aria-live="polite">
      <div className="book-detail-top">
        <Cover item={item} />
        <div>
          <h2>{item.title}</h2>
          <p>
            {item.authors?.join(", ")}
            {audio
              ? ` · Audiobook · ${formatDuration(item.durationMinutes ?? 0)}`
              : ` · ${item.pageCount} pages`}
          </p>
          <p>
            <Tile area={item.areaId} />
            {state.areas.find((a) => a.id === item.areaId)?.fullName}
          </p>
        </div>
        <button
          className="icon-button desktop-detail-close"
          onClick={onClose}
          aria-label="Close book detail"
        >
          ×
        </button>
      </div>
      {item.state === "active" && (
        <>
          <div className="book-progress-line">
            <strong>
              {audio
                ? formatAudiobookProgress(
                    item.positionMinutes ?? 0,
                    item.durationMinutes ?? 0,
                  )
                : `Page ${item.currentPage ?? 0} of ${item.pageCount}`}
            </strong>
            {!audio && (
              <span>
                {Math.round(
                  ((item.currentPage ?? 0) / (item.pageCount || 1)) * 100,
                )}
                %
              </span>
            )}
          </div>
          <Progress
            current={
              audio ? (item.positionMinutes ?? 0) : (item.currentPage ?? 0)
            }
            total={audio ? (item.durationMinutes ?? 1) : (item.pageCount ?? 1)}
          />
          {audio ? (
            <form
              className="book-page-form duration-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (
                  !Number.isInteger(hours) ||
                  !Number.isInteger(minutes) ||
                  hours < 0 ||
                  minutes < 0 ||
                  minutes > 59
                ) {
                  setProgressError("Use whole hours and 0–59 minutes.");
                  return;
                }
                const position = hours * 60 + minutes;
                if (position > (item.durationMinutes ?? 0)) {
                  setProgressError(
                    "That position is past the end of the audiobook.",
                  );
                  return;
                }
                setProgressError("");
                command("set_book_progress", {
                  bookId: item.id,
                  position: { hours, minutes },
                }).catch((error: Error) => setProgressError(error.message));
              }}
            >
              <Field label="Hours">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={999}
                  required
                  aria-label="Current hours"
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value))}
                />
              </Field>
              <Field label="Minutes">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={59}
                  required
                  aria-label="Current minutes"
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                />
              </Field>
              <Button small disabled={busy}>
                Update position
              </Button>
            </form>
          ) : (
            <form
              className="book-page-form"
              onSubmit={(e) => {
                e.preventDefault();
                safe(
                  command("set_book_progress", {
                    bookId: item.id,
                    currentPage: page,
                  }),
                );
              }}
            >
              <Field label="Current page">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={item.pageCount}
                  required
                  value={page}
                  onChange={(e) => setPage(Number(e.target.value))}
                />
              </Field>
              <Button small disabled={busy}>
                Update page
              </Button>
            </form>
          )}
          {progressError && <ErrorText message={progressError} />}
          {(audio
            ? item.positionMinutes === item.durationMinutes
            : item.currentPage === item.pageCount) && (
            <Button
              primary
              onClick={() => safe(command("finish_item", { itemId: item.id }))}
            >
              Mark as read
            </Button>
          )}
        </>
      )}
      {item.state === "queued" && (
        <>
          <p>In {areaNames[item.areaId]}'s Up next.</p>
          <Button className="open-place-button" onClick={() => start(item)}>
            {holder
              ? `Book place reserved for “${holder.title}”`
              : audio
                ? "Start listening, place is open"
                : "Start reading, place is open"}
          </Button>
        </>
      )}
      {item.state === "paused" && (
        <>
          <p>
            {audio
              ? `Paused · ${formatAudiobookProgress(item.positionMinutes ?? 0, item.durationMinutes ?? 0)}`
              : `Paused · p. ${item.currentPage ?? 0} of ${item.pageCount}`}
          </p>
          <Button
            small
            disabled={Boolean(holder)}
            onClick={() => safe(command("resume_item", { itemId: item.id }))}
          >
            {audio ? "Resume listening" : "Resume reading"}
          </Button>
          {holder && (
            <p className="muted">Book place reserved for “{holder.title}”</p>
          )}
        </>
      )}
      {item.state === "archived" && (
        <Button
          onClick={() => safe(command("restore_item", { itemId: item.id }))}
        >
          Restore to Up next
        </Button>
      )}
      {item.state === "done" && (
        <p>
          <span className="read-stamp">Read</span>
        </p>
      )}
      {["active", "queued", "paused"].includes(item.state) && (
        <div className="book-detail-actions">
          <ItemActions item={item} />
        </div>
      )}
      {!item.coverUrl && (
        <p className="muted">
          No cover in the books database. We use a title card.
        </p>
      )}
      <LearningList item={item} />
    </aside>
  );
}
export function FindBook({
  areaId,
  start = false,
  onClose,
}: {
  areaId?: string;
  start?: boolean;
  onClose: () => void;
}) {
  const { state, command, refresh, busy } = useApp();
  const [area, setArea] = useState(areaId ?? "tech");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<BookCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState(false);
  const [selected, setSelected] = useState<BookCandidate>();
  const [pageCount, setPageCount] = useState("");
  const [format, setFormat] = useState<"pages" | "time">("pages");
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState("");
  useEffect(() => {
    if (search.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => {
      setLoading(true);
      setError("");
      request<{ items: BookCandidate[] }>(
        `/api/books/search?q=${encodeURIComponent(search.trim())}`,
        { signal: controller.signal },
      )
        .then((value) => {
          if (active) setResults(value.items ?? []);
        })
        .catch((e) => {
          if (active && e.name !== "AbortError")
            setError(
              "Couldn't reach the books database. Try again, or add it by hand.",
            );
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);
  async function add(
    candidate?: BookCandidate,
    count?: number,
    duration?: { hours: number; minutes: number },
  ) {
    setError("");
    try {
      const before = new Set(state.items.map((i) => i.id));
      await command(
        "queue_book",
        {
          areaId: area,
          source: candidate
            ? { type: "open_library", editionId: candidate.editionId }
            : duration
              ? {
                  type: "manual",
                  title,
                  authors: authors
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  progressUnit: "time",
                  duration,
                }
              : {
                  type: "manual",
                  title,
                  authors: authors
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  pageCount: count,
                },
          ...(candidate && count ? { pageCountOverride: count } : {}),
        },
        !start,
      );
      if (start) {
        const next = await refresh();
        const item = next.items.find(
          (i) => i.kind === "book" && !before.has(i.id),
        );
        if (item) await command("start_item", { itemId: item.id });
      }
      onClose();
    } catch (e) {
      if (
        candidate &&
        e instanceof ApiError &&
        e.code === "BOOK_METADATA_INCOMPLETE"
      ) {
        setSelected(candidate);
        setPageCount(candidate.pageCount ? String(candidate.pageCount) : "");
        setError(
          "Confirm the page count for this edition. The search result may use an estimated work-level count.",
        );
      } else setError((e as Error).message);
    }
  }
  const duplicate = (candidate: BookCandidate) =>
    state.items.some(
      (i) =>
        i.kind === "book" &&
        ((candidate.workId && i.workId === candidate.workId) ||
          i.editionId === candidate.editionId ||
          (candidate.isbn && i.isbn === candidate.isbn)),
    );
  return (
    <Modal
      title={manual ? "Add a book by hand" : "Find a book"}
      onClose={onClose}
      className="find-book-dialog"
    >
      <Field label="Add to Up next in">
        <select value={area} onChange={(e) => setArea(e.target.value)}>
          {state.areas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      {manual ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (format === "time") {
              const lengthHours = Number(hours);
              const lengthMinutes = Number(minutes);
              if (
                !Number.isInteger(lengthHours) ||
                !Number.isInteger(lengthMinutes) ||
                lengthHours < 0 ||
                lengthHours > 999 ||
                lengthMinutes < 0 ||
                lengthMinutes > 59 ||
                (lengthHours === 0 && lengthMinutes === 0)
              ) {
                setError(
                  "Enter a length of at least 1 minute. Minutes must be 0–59.",
                );
                return;
              }
              safe(
                add(undefined, undefined, {
                  hours: lengthHours,
                  minutes: lengthMinutes,
                }),
              );
              return;
            }
            safe(add(undefined, Number(pageCount)));
          }}
        >
          <Segment
            label="Book format"
            value={format}
            onChange={(value) => {
              setFormat(value as "pages" | "time");
              setError("");
            }}
            values={[
              { id: "pages", label: "Book" },
              { id: "time", label: "Audiobook" },
            ]}
          />
          <Field label="Title">
            <input
              autoFocus
              required
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="Author" hint="Separate authors with commas.">
            <input
              value={authors}
              onChange={(e) => setAuthors(e.target.value)}
            />
          </Field>
          {format === "time" ? (
            <div className="duration-fields">
              <Field label="Hours">
                <input
                  type="number"
                  required
                  min={0}
                  max={999}
                  inputMode="numeric"
                  aria-label="Length hours"
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                />
              </Field>
              <Field label="Minutes">
                <input
                  type="number"
                  required
                  min={0}
                  max={59}
                  inputMode="numeric"
                  aria-label="Length minutes"
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <Field label="How many pages?">
              <input
                type="number"
                required
                min={1}
                inputMode="numeric"
                value={pageCount}
                onChange={(e) => setPageCount(e.target.value)}
              />
            </Field>
          )}
          <p className="muted">
            {format === "time"
              ? "We'll use a title card. You'll track listening progress in hours and minutes."
              : "We'll use a title card. You can track reading progress as usual."}
          </p>
          <ErrorText message={error} />
          <div className="form-actions">
            <Button ghost type="button" onClick={() => setManual(false)}>
              Back to search
            </Button>
            <Button primary disabled={busy}>
              Add to Up next
            </Button>
          </div>
        </form>
      ) : (
        <>
          <Field label="Title, author or ISBN">
            <input
              autoFocus
              type="search"
              placeholder="e.g. The Mom Test"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={200}
            />
          </Field>
          <div
            className="book-search-results"
            aria-live="polite"
            aria-busy={loading}
          >
            {loading ? (
              <p className="muted">Searching books…</p>
            ) : search.trim().length < 2 ? (
              <Empty title="Start typing to search." />
            ) : results.length ? (
              results.map((candidate) => (
                <article className="book-result" key={candidate.editionId}>
                  <Cover
                    item={{ ...candidate, areaId: area as Item["areaId"] }}
                    className="result-cover"
                  />
                  <div>
                    <strong>{candidate.title}</strong>
                    <p>
                      {candidate.authors.join(", ")}
                      {candidate.year ? ` · ${candidate.year}` : ""}
                      {candidate.pageCount
                        ? ` · ${candidate.pageCountSource === "work_median" ? "about " : ""}${candidate.pageCount} pages`
                        : ""}
                    </p>
                    {!candidate.coverUrl && (
                      <small>No cover found. We'll use a title card.</small>
                    )}
                    {selected?.editionId === candidate.editionId && (
                      <form
                        className="missing-pages"
                        onSubmit={(e) => {
                          e.preventDefault();
                          safe(add(candidate, Number(pageCount)));
                        }}
                      >
                        <Field label="How many pages?">
                          <input
                            autoFocus
                            type="number"
                            min={1}
                            required
                            inputMode="numeric"
                            value={pageCount}
                            onChange={(e) => setPageCount(e.target.value)}
                          />
                        </Field>
                        <Button small primary disabled={busy}>
                          Add book
                        </Button>
                      </form>
                    )}
                  </div>
                  {duplicate(candidate) ? (
                    <small>Already on your shelf</small>
                  ) : (
                    <Button
                      small
                      disabled={busy}
                      onClick={() => {
                        if (!candidate.pageCount) {
                          setSelected(candidate);
                          setPageCount("");
                        } else safe(add(candidate));
                      }}
                    >
                      Add
                    </Button>
                  )}
                </article>
              ))
            ) : (
              !error && (
                <Empty title={`No books match “${search}”.`}>
                  <p>
                    Check the spelling, try the author's surname, or paste the
                    ISBN from the back cover.
                  </p>
                </Empty>
              )
            )}
          </div>
          <ErrorText message={error} />
          <div className="form-actions">
            <Button
              ghost
              onClick={() => {
                setManual(true);
                setTitle(search);
                setError("");
              }}
            >
              Add it by hand
            </Button>
            <Button ghost onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
