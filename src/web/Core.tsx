import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AreaId, Item, Ticket, TicketStatus } from "../shared/types";
import { useApp } from "./context";
import {
  currentBooking,
  dateOf,
  itemProgress,
  longDate,
  query,
  safe,
  shortDate,
  timeOf,
  todayTickets,
} from "./api";
import {
  areaNames,
  Button,
  Cover,
  Empty,
  ErrorText,
  Field,
  Icon,
  Lamp,
  Modal,
  PageHeader,
  Progress,
  Segment,
  Tile,
} from "./ui";
import { DayTimeline } from "./Calendar";

export function ItemActions({ item }: { item: Item }) {
  const { command, setModal } = useApp();
  const ref = useRef<HTMLDetailsElement>(null);
  const close = () => ref.current?.removeAttribute("open");
  return (
    <details
      className="action-menu"
      ref={ref}
      onKeyDown={(e) => {
        const buttons = [
          ...(ref.current?.querySelectorAll<HTMLButtonElement>(
            "[role=menuitem]",
          ) ?? []),
        ];
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        if (e.key === "Escape") {
          close();
          ref.current?.querySelector("summary")?.focus();
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          buttons[
            (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length
          ]?.focus();
        }
      }}
    >
      <summary aria-label={`Actions for ${item.title}`} aria-haspopup="menu">
        ···
      </summary>
      <div role="menu" aria-label={`Actions for ${item.title}`}>
        {["active", "queued", "paused"].includes(item.state) && (
          <button
            role="menuitem"
            onClick={() => {
              close();
              setModal({ type: "edit", item });
            }}
          >
            Edit details
          </button>
        )}
        {item.state === "active" && (
          <>
            <button
              role="menuitem"
              onClick={() => {
                close();
                setModal({ type: "finish", item });
              }}
            >
              Mark as done
            </button>
            <button
              role="menuitem"
              onClick={() => {
                close();
                safe(command("pause_item", { itemId: item.id }));
              }}
            >
              Pause, opens the place
            </button>
            <button
              role="menuitem"
              onClick={() => {
                close();
                safe(command("archive_item", { itemId: item.id }));
              }}
            >
              Archive, scrap it
            </button>
            <small>Paused items wait in Paused & archived.</small>
          </>
        )}
      </div>
    </details>
  );
}
export function Board() {
  const { state, setModal, openItem, start, command } = useApp();
  return (
    <>
      <PageHeader
        title="Board"
        subtitle="One project and one book per area. Everything else waits in Up next."
      >
        <Button onClick={() => setModal({ type: "drawer" })}>
          <Icon name="archive" />
          Paused & archived
        </Button>
        <Button primary onClick={() => setModal({ type: "add" })}>
          <Icon name="plus" />
          Add to Up next
        </Button>
      </PageHeader>
      <div className="board-grid">
        {state.areas.map((area) => {
          const items = state.items.filter((i) => i.areaId === area.id);
          const holders = items.filter((i) => i.state === "active");
          const queued = items
            .filter((i) => i.state === "queued")
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
          return (
            <section
              className="board-lane"
              key={area.id}
              id={`area-${area.id}`}
            >
              <header className="lane-heading">
                <Tile area={area.id} />
                <h2>{area.name}</h2>
                <span className="place-state">
                  <Lamp open={holders.length < 2} />
                  {holders.length === 2
                    ? "Reserved"
                    : `${2 - holders.length} open`}
                </span>
              </header>
              <div className="lane-body">
                {(["project", "book"] as const).map((kind) => {
                  const holder = holders.find((i) => i.kind === kind);
                  const progress = holder && itemProgress(state, holder);
                  return holder ? (
                    <article
                      key={kind}
                      className={`place reserved-place ${area.id}`}
                    >
                      <div className="place-title">
                        {kind === "book" ? (
                          <Cover item={holder} className="mini-cover" />
                        ) : (
                          <Icon name="project" />
                        )}
                        <button
                          className="text-button item-title"
                          onClick={() => openItem(holder)}
                        >
                          {holder.title}
                        </button>
                        <ItemActions item={holder} />
                      </div>
                      <div
                        className={kind === "book" ? "book-place-progress" : ""}
                      >
                        <small>{progress!.label}</small>
                        <Progress
                          current={progress!.current}
                          total={progress!.total}
                        />
                      </div>
                    </article>
                  ) : (
                    <div className="place open-place" key={kind}>
                      <p>
                        <Icon name={`open-${kind}`} />
                        {kind === "project" ? "Project" : "Book"} place open
                      </p>
                      <small>
                        {queued.some((i) => i.kind === kind)
                          ? `Start a ${kind} from Up next below.`
                          : kind === "project"
                            ? "Nothing queued yet. Add a project to Up next."
                            : "No books queued. Find one on the Bookshelf."}
                      </small>
                    </div>
                  );
                })}
                <div className="queue-heading">
                  <span>Up next · {queued.length}</span>
                  <button
                    className="icon-button"
                    aria-label={`Add to ${area.name} Up next`}
                    onClick={() => setModal({ type: "add", areaId: area.id })}
                  >
                    +
                  </button>
                </div>
                <div className="queue-list">
                  {queued.map((item, index) => (
                    <article
                      className="queue-row"
                      key={item.id}
                      draggable
                      onDragStart={(e) =>
                        e.dataTransfer.setData("text/organizer-item", item.id)
                      }
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const id = e.dataTransfer.getData(
                          "text/organizer-item",
                        );
                        if (queued.some((i) => i.id === id) && id !== item.id)
                          safe(
                            command("reorder_up_next", {
                              areaId: area.id,
                              itemId: id,
                              beforeItemId: item.id,
                            }),
                          );
                      }}
                    >
                      <Icon name={item.kind} />
                      <button
                        className="text-button queue-label"
                        onClick={() => openItem(item)}
                      >
                        <span>{item.title}</span>
                        <small>
                          {item.kind === "project"
                            ? `${state.tickets.filter((t) => t.projectId === item.id).length} tickets planned`
                            : item.authors?.join(", ")}
                        </small>
                      </button>
                      <Button small onClick={() => start(item)}>
                        Start
                      </Button>
                      <details className="queue-order">
                        <summary aria-label={`Reorder ${item.title}`}>
                          ↕
                        </summary>
                        <div>
                          <Button
                            small
                            disabled={index === 0}
                            onClick={() =>
                              safe(
                                command("reorder_up_next", {
                                  areaId: area.id,
                                  itemId: item.id,
                                  beforeItemId: queued[index - 1]?.id,
                                }),
                              )
                            }
                          >
                            Move up
                          </Button>
                          <Button
                            small
                            disabled={index === queued.length - 1}
                            onClick={() =>
                              safe(
                                command("reorder_up_next", {
                                  areaId: area.id,
                                  itemId: item.id,
                                  beforeItemId: queued[index + 2]?.id ?? null,
                                }),
                              )
                            }
                          >
                            Move down
                          </Button>
                        </div>
                      </details>
                    </article>
                  ))}
                  {queued.length === 0 && (
                    <div className="queue-empty">
                      <p>
                        Up next is empty. Queue projects and books here as ideas
                        come up; they wait until a place opens.
                      </p>
                      <Button
                        small
                        ghost
                        onClick={() =>
                          setModal({ type: "add", areaId: area.id })
                        }
                      >
                        Queue a project or book
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
export function Today() {
  const { state, command, navigate, setModal, refresh } = useApp();
  const tickets = todayTickets(state);
  const [skipped, setSkipped] = useState<unknown>(null);
  useEffect(() => {
    let active = true;
    const sync = () =>
      query<any>("get_today", { detail: "titles" })
        .then(async (value) => {
          if (!active) return;
          setSkipped(value.skippedReviewNote ?? value.missedReviewNote ?? null);
          await refresh();
        })
        .catch(() => undefined);
    safe(sync());
    window.addEventListener("focus", sync);
    const timer = window.setInterval(sync, 300000);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", sync);
    };
  }, [state.localDate, refresh]);
  const projects = new Set(tickets.map((t) => t.projectId));
  const unbooked = tickets.filter((t) => !currentBooking(state, t)).length;
  return (
    <>
      <PageHeader
        title={longDate(state.localDate)}
        subtitle={`Morning plan · ${tickets.length} ${tickets.length === 1 ? "ticket" : "tickets"} from ${projects.size} ${projects.size === 1 ? "project" : "projects"} · ${unbooked} not booked yet`}
      >
        <Button onClick={() => navigate("calendar")}>
          <Icon name="week" />
          Week
        </Button>
        <Button onClick={() => navigate("review")}>
          <Icon name="review" />
          Evening review
        </Button>
      </PageHeader>
      {Boolean(skipped) && (
        <div className="quiet-note">
          <span>
            You didn't save an evening review yesterday. Today is a fresh start.
          </span>
          <Button
            small
            ghost
            onClick={() =>
              safe(
                command("dismiss_skipped_review_note", {
                  date: state.localDate,
                }).then(() => setSkipped(null)),
              )
            }
          >
            Dismiss
          </Button>
        </div>
      )}
      <section
        className="reservation-book"
        aria-label="Reservations: one project place and one book place per area"
      >
        <div className="reservation-counter">
          <strong>
            {8 - state.items.filter((i) => i.state === "active").length}
          </strong>
          <span>of 8 places open</span>
        </div>
        {state.areas.map((area) => (
          <a className="reservation-cell" href="#/board" key={area.id}>
            <h2>
              <Tile area={area.id} />
              {area.name}
            </h2>
            {(["project", "book"] as const).map((kind) => {
              const item = state.items.find(
                (i) =>
                  i.kind === kind &&
                  i.areaId === area.id &&
                  i.state === "active",
              );
              return (
                <div className="reservation-line" key={kind}>
                  <small>{kind === "project" ? "Project" : "Book"}</small>
                  <span className={!item ? "open-label" : ""}>
                    <Lamp open={!item} />
                    {item?.title ?? "Open"}
                  </span>
                </div>
              );
            })}
          </a>
        ))}
      </section>
      <div className="today-grid">
        <section className="panel ticket-panel">
          <div className="panel-heading">
            <h2>Today's tickets</h2>
            <Button small ghost onClick={() => navigate("board")}>
              <Icon name="board" />
              Board
            </Button>
          </div>
          {tickets.length === 0 && (
            <Empty title="Nothing planned for today.">
              <p>Pick tickets from the Board or book time on the week view.</p>
              <Button small onClick={() => navigate("board")}>
                Go to Board
              </Button>
            </Empty>
          )}
          {state.areas.map((area) => {
            const holder = state.items.find(
              (i) =>
                i.areaId === area.id &&
                i.kind === "project" &&
                i.state === "active",
            );
            const rows = tickets.filter((t) => t.projectId === holder?.id);
            if (holder && !rows.length) return null;
            return (
              <section className="today-area" key={area.id}>
                <h3>
                  <Tile area={area.id} />
                  {area.name}
                  <span>· {holder?.title ?? "project place open"}</span>
                </h3>
                {!holder && (
                  <p className="muted area-empty">
                    No project running here.{" "}
                    <button
                      className="inline-link"
                      onClick={() => navigate("board")}
                    >
                      Start one from Up next
                    </button>
                  </p>
                )}
                {rows.map((ticket) => (
                  <TicketRow key={ticket.id} ticket={ticket} />
                ))}
              </section>
            );
          })}
        </section>
        <section className="panel timeline-panel">
          <h2>Today on your calendars</h2>
          <CalendarLegend />
          <DayTimeline date={state.localDate} />
        </section>
      </div>
    </>
  );
}
export function CalendarLegend() {
  return (
    <div className="calendar-legend">
      <span>
        <i className="calendar-key work" />
        Work
      </span>
      <span>
        <i className="calendar-key personal" />
        Personal
      </span>
      <span>
        <i className="calendar-key booked" />
        Booked ticket
      </span>
    </div>
  );
}
export function TicketRow({ ticket }: { ticket: Ticket }) {
  const { state, command, setModal } = useApp();
  const booking = currentBooking(state, ticket);
  const personal = state.connections.find(
    (c) => c.role === "personal" && c.status === "connected",
  );
  return (
    <div className={`ticket-row ${ticket.status === "done" ? "is-done" : ""}`}>
      <label className="ticket-check">
        <input
          type="checkbox"
          checked={ticket.status === "done"}
          aria-label={`Mark ${ticket.title} ${ticket.status === "done" ? "To do" : "done"}`}
          onChange={(e) =>
            safe(
              command("set_ticket_status", {
                ticketId: ticket.id,
                status: e.target.checked ? "done" : "todo",
              }),
            )
          }
        />
        <span className="ticket-copy">
          <span>{ticket.title}</span>
          {ticket.status === "in_progress" && (
            <small className="status-pill">In progress</small>
          )}
        </span>
      </label>
      <div className="ticket-book">
        {booking ? (
          <button
            className="booked-chip"
            onClick={() => setModal({ type: "book", ticket })}
          >
            <Icon name="booked" />
            {timeOf(booking.start)}–{timeOf(booking.end)}
            {booking.syncState !== "synced" && (
              <small> · {booking.syncState}</small>
            )}
          </button>
        ) : (
          ticket.status !== "done" && (
            <Button
              small
              disabled={!personal}
              title={
                !personal
                  ? "Connect your Personal calendar to book time."
                  : undefined
              }
              onClick={() => setModal({ type: "book", ticket })}
            >
              <Icon name="book-time" />
              Book time
            </Button>
          )
        )}
      </div>
    </div>
  );
}
export function Project({ id }: { id: string }) {
  const { state, command, navigate, setModal, start } = useApp();
  const item = state.items.find((i) => i.id === id && i.kind === "project");
  const [newTitle, setNewTitle] = useState("");
  if (!item)
    return (
      <Empty title="Project not found.">
        <Button onClick={() => navigate("board")}>Back to Board</Button>
      </Empty>
    );
  const tickets = state.tickets.filter((t) => t.projectId === id);
  const progress = itemProgress(state, item);
  const readOnly = item.state === "done" || item.state === "archived";
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    await command("create_ticket", { projectId: id, title: newTitle });
    setNewTitle("");
  };
  return (
    <>
      <div className="breadcrumbs">
        <a href="#/board">Board</a>
        <span>›</span>
        <a href="#/board">{areaNames[item.areaId]}</a>
      </div>
      <PageHeader title={item.title}>
        <div className="project-actions">
          {item.state === "active" ? (
            <>
              <Button
                onClick={() => safe(command("pause_item", { itemId: id }))}
              >
                <Icon name="pause" />
                Pause
              </Button>
              <Button
                onClick={() => safe(command("archive_item", { itemId: id }))}
              >
                <Icon name="archive" />
                Archive
              </Button>
              <Button
                primary
                onClick={() => setModal({ type: "finish", item })}
              >
                <Icon name="finish" />
                Mark project done
              </Button>
            </>
          ) : item.state === "queued" ? (
            <Button primary onClick={() => start(item)}>
              Start project
            </Button>
          ) : item.state === "paused" ? (
            <Button
              primary
              disabled={state.items.some(
                (i) =>
                  i.areaId === item.areaId &&
                  i.kind === "project" &&
                  i.state === "active",
              )}
              onClick={() => safe(command("resume_item", { itemId: id }))}
            >
              Resume project
            </Button>
          ) : item.state === "archived" ? (
            <Button
              onClick={() => safe(command("restore_item", { itemId: id }))}
            >
              Restore to Up next
            </Button>
          ) : null}
          {!readOnly && (
            <Button ghost onClick={() => setModal({ type: "edit", item })}>
              Edit
            </Button>
          )}
        </div>
      </PageHeader>
      <div className="project-subtitle">
        <Tile area={item.areaId} large />
        <span>
          <Lamp open={item.state !== "active"} />
          {item.state === "active"
            ? "Active · holds the project place"
            : item.state === "queued"
              ? "Queued in Up next"
              : item.state === "done"
                ? "Done"
                : item.state === "paused"
                  ? "Paused"
                  : "Archived"}
        </span>
        <span>
          {progress.current} of {progress.total} done
        </span>
      </div>
      {item.goal && <p className="project-goal">{item.goal}</p>}
      <div className="project-columns">
        {(["todo", "in_progress", "done"] as TicketStatus[]).map((status) => (
          <section
            className="project-column"
            key={status}
            onDragOver={(e) => {
              if (item.state === "active") e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const ticketId = e.dataTransfer.getData("text/organizer-ticket");
              if (
                tickets.some((t) => t.id === ticketId) &&
                item.state === "active"
              )
                safe(command("set_ticket_status", { ticketId, status }));
            }}
          >
            <header>
              <h2>
                {status === "todo"
                  ? "To do"
                  : status === "in_progress"
                    ? "In progress"
                    : "Done"}
              </h2>
              <small>
                {
                  tickets.filter(
                    (t) =>
                      t.status === status ||
                      (status === "done" && t.status === "closed"),
                  ).length
                }
              </small>
            </header>
            {status === "in_progress" && item.state !== "active" && (
              <div className="queued-lock">
                <Icon name="lock" />
                <strong>No work in progress while {item.state}</strong>
                <p>Start this project when the place is open.</p>
              </div>
            )}
            {tickets
              .filter(
                (t) =>
                  t.status === status ||
                  (status === "done" && t.status === "closed"),
              )
              .sort((a, b) => a.order - b.order)
              .map((ticket) => (
                <ProjectTicket key={ticket.id} ticket={ticket} item={item} />
              ))}
            {status === "todo" && !readOnly && (
              <form className="add-ticket" onSubmit={(e) => safe(create(e))}>
                <input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="+ Add ticket"
                  aria-label="New ticket title"
                  maxLength={500}
                />
                <Button small ghost type="submit" disabled={!newTitle.trim()}>
                  Add
                </Button>
              </form>
            )}
          </section>
        ))}
      </div>
      <LearningList item={item} />
    </>
  );
}
function ProjectTicket({ ticket, item }: { ticket: Ticket; item: Item }) {
  const { state, command, setModal } = useApp();
  const booking = currentBooking(state, ticket);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(ticket.title);
  const active = item.state === "active";
  const editable = ["queued", "active", "paused"].includes(item.state);
  const connected = state.connections.some(
    (c) => c.role === "personal" && c.status === "connected",
  );
  return (
    <article
      className={`project-ticket ${ticket.status === "done" || ticket.status === "closed" ? "is-done" : ""}`}
      draggable={active}
      onDragStart={(e) =>
        e.dataTransfer.setData("text/organizer-ticket", ticket.id)
      }
    >
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            safe(
              command("update_ticket", { ticketId: ticket.id, title }).then(
                () => setEditing(false),
              ),
            );
          }}
        >
          <input
            aria-label="Ticket title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
          <Button small type="submit">
            Save
          </Button>
          <Button small ghost type="button" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <p>{ticket.title}</p>
      )}
      {active && !["done", "closed"].includes(ticket.status) && (
        <button
          className={booking ? "booked-chip" : "text-button book-time-link"}
          disabled={!connected}
          onClick={() => setModal({ type: "book", ticket })}
        >
          <Icon name={booking ? "booked" : "book-time"} />
          {booking
            ? `${dateOf(booking.start) === state.localDate ? "Today" : shortDate(dateOf(booking.start))} ${timeOf(booking.start)}`
            : "Book time"}
        </button>
      )}
      {editable && (
        <div className="ticket-tools">
          {active && (
            <label className="sr-only-label">
              Move to
              <select
                aria-label={`Move ${ticket.title} to`}
                value={ticket.status}
                onChange={(e) =>
                  safe(
                    command("set_ticket_status", {
                      ticketId: ticket.id,
                      status: e.target.value,
                    }),
                  )
                }
              >
                {ticket.status === "closed" && (
                  <option value="closed">Closed</option>
                )}
                <option value="todo">To do</option>
                <option value="in_progress">In progress</option>
                <option value="done">Done</option>
              </select>
            </label>
          )}
          <button className="text-button" onClick={() => setEditing(!editing)}>
            Edit
          </button>
          <button
            className="text-button"
            aria-label={`Move ${ticket.title} to top of column`}
            onClick={() => {
              const first = state.tickets
                .filter(
                  (t) => t.projectId === item.id && t.status === ticket.status,
                )
                .sort((a, b) => a.order - b.order)[0];
              if (first?.id !== ticket.id)
                safe(
                  command("reorder_tickets", {
                    projectId: item.id,
                    ticketId: ticket.id,
                    status: ticket.status,
                    beforeTicketId: first?.id ?? null,
                  }),
                );
            }}
          >
            Move up
          </button>
        </div>
      )}
    </article>
  );
}
export function LearningList({ item }: { item: Item }) {
  const { state } = useApp();
  const rows = state.learnings
    .filter((l) => l.projectId === item.id || l.bookId === item.id)
    .sort((a, b) => b.createdOn.localeCompare(a.createdOn));
  return (
    <section className="panel learnings">
      <h2>Learnings</h2>
      {rows.length ? (
        rows.map((l) => (
          <article key={l.id}>
            <time>{shortDate(l.createdOn)}</time>
            <p>{l.text}</p>
          </article>
        ))
      ) : (
        <p className="muted">
          {item.state === "queued"
            ? "Learnings appear here once this project is running."
            : "Nothing yet. Evening review asks what you learned and saves it here."}
        </p>
      )}
    </section>
  );
}
export function Drawer({ onClose }: { onClose: () => void }) {
  const { state, command, openItem } = useApp();
  const [tab, setTab] = useState("paused");
  const rows = state.items.filter((i) => i.state === tab);
  return (
    <Modal title="Paused & archived" drawer onClose={onClose}>
      <Segment
        label="Item state"
        value={tab}
        onChange={setTab}
        values={[
          {
            id: "paused",
            label: `Paused ${state.items.filter((i) => i.state === "paused").length}`,
          },
          {
            id: "archived",
            label: `Archived ${state.items.filter((i) => i.state === "archived").length}`,
          },
        ]}
      />
      <div className="drawer-items">
        {rows.length ? (
          rows.map((item) => {
            const holder = state.items.find(
              (i) =>
                i.kind === item.kind &&
                i.areaId === item.areaId &&
                i.state === "active",
            );
            return (
              <article className="drawer-item" key={item.id}>
                <Tile area={item.areaId} />
                <div>
                  <button
                    className="text-button item-title"
                    onClick={() => {
                      onClose();
                      openItem(item);
                    }}
                  >
                    {item.title}
                  </button>
                  <p>
                    {areaNames[item.areaId]} ·{" "}
                    {tab === "paused" ? "Paused" : "Archived"}{" "}
                    {shortDate(
                      (
                        item.pausedAt ??
                        item.archivedAt ??
                        item.updatedAt
                      ).slice(0, 10),
                    )}{" "}
                    · {itemProgress(state, item).label}
                  </p>
                  {tab === "paused" ? (
                    <>
                      <Button
                        small
                        disabled={Boolean(holder)}
                        onClick={() =>
                          safe(command("resume_item", { itemId: item.id }))
                        }
                      >
                        ▷ Resume
                      </Button>
                      <span className={holder ? "muted" : "open-label"}>
                        {holder
                          ? `${areaNames[item.areaId]} ${item.kind} place is reserved for “${holder.title}”`
                          : "Place is open"}
                      </span>
                    </>
                  ) : (
                    <Button
                      small
                      onClick={() =>
                        safe(command("restore_item", { itemId: item.id }))
                      }
                    >
                      Restore to Up next
                    </Button>
                  )}
                </div>
              </article>
            );
          })
        ) : (
          <Empty title={`Nothing ${tab}.`}>
            <p>Pausing or archiving from the Board puts items here.</p>
          </Empty>
        )}
      </div>
    </Modal>
  );
}
export function AddDialog({
  areaId,
  start = false,
  onClose,
}: {
  areaId?: string;
  start?: boolean;
  onClose: () => void;
}) {
  const { state, command, refresh, setModal, busy } = useApp();
  const [area, setArea] = useState(areaId ?? "tech");
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [tickets, setTickets] = useState("");
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const before = new Set(state.items.map((i) => i.id));
      const result = await command(
        "queue_project",
        {
          areaId: area,
          title,
          goal: goal || undefined,
          initialTicketTitles: tickets
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean),
        },
        true,
      );
      if (start) {
        const next = await refresh();
        const item = next.items.find(
          (i) => !before.has(i.id) && i.kind === "project",
        );
        if (item) await command("start_item", { itemId: item.id });
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal
      title={start ? "Reserve your first place" : "Add to Up next"}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <Segment
          label="Item type"
          value="project"
          onChange={(v) => {
            if (v === "book") setModal({ type: "find", areaId: area, start });
          }}
          values={[
            { id: "project", label: "Project" },
            { id: "book", label: "Book" },
          ]}
        />
        <Field label="Area">
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            {state.areas.map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project title">
          <input
            autoFocus
            required
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What will you work on?"
          />
        </Field>
        <Field label="Goal (optional)">
          <input
            value={goal}
            maxLength={500}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="What does finished look like?"
          />
        </Field>
        <Field
          label="Initial tickets (optional)"
          hint="One ticket per line. You can add more later."
        >
          <textarea
            rows={4}
            value={tickets}
            onChange={(e) => setTickets(e.target.value)}
          />
        </Field>
        <ErrorText message={error} />
        <div className="form-actions">
          <Button ghost type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button primary disabled={busy} type="submit">
            {start ? "Reserve project place" : "Add to Up next"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function EditDialog({
  item,
  onClose,
}: {
  item: Item;
  onClose: () => void;
}) {
  const { command, busy } = useApp();
  const [title, setTitle] = useState(item.title);
  const [goal, setGoal] = useState(item.goal ?? "");
  const [authors, setAuthors] = useState(item.authors?.join(", ") ?? "");
  const [pages, setPages] = useState(item.pageCount ?? 1);
  const [error, setError] = useState("");
  return (
    <Modal title={`Edit ${item.kind}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          command(
            item.kind === "project" ? "update_project" : "update_book",
            item.kind === "project"
              ? { projectId: item.id, patch: { title, goal } }
              : {
                  bookId: item.id,
                  patch: {
                    title,
                    authors: authors
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    pageCount: pages,
                  },
                },
          )
            .then(onClose)
            .catch((e) => setError(e.message));
        }}
      >
        <Field label="Title">
          <input
            required
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        {item.kind === "project" ? (
          <Field label="Goal">
            <input value={goal} onChange={(e) => setGoal(e.target.value)} />
          </Field>
        ) : (
          <>
            <Field label="Authors" hint="Separate names with commas.">
              <input
                value={authors}
                onChange={(e) => setAuthors(e.target.value)}
              />
            </Field>
            <Field label="Page count">
              <input
                required
                type="number"
                min={1}
                value={pages}
                onChange={(e) => setPages(Number(e.target.value))}
              />
            </Field>
          </>
        )}
        <ErrorText message={error} />
        <div className="form-actions">
          <Button ghost type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button primary disabled={busy}>
            Save details
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function SwapDialog({
  item,
  current,
  onClose,
}: {
  item: Item;
  current: Item;
  onClose: () => void;
}) {
  const { state, command, busy } = useApp();
  const [error, setError] = useState("");
  return (
    <Modal
      title={`To start “${item.title}”, open the ${item.kind} place first`}
      onClose={onClose}
      className="swap-dialog"
    >
      <div className="reserved-ticket">
        <strong>Reserved</strong>
        <small>
          <Tile area={item.areaId} />
          {areaNames[item.areaId]} · {item.kind} place
        </small>
      </div>
      <p>
        Each area keeps one {item.kind} at a time. Decide what happens to the
        current one. There's no way to run both.
      </p>
      <div className={`swap-current ${current.areaId}`}>
        <Icon name={current.kind} />
        <div>
          <strong>{current.title}</strong>
          <small>{itemProgress(state, current).label}</small>
        </div>
      </div>
      <div className="swap-choices">
        {[
          {
            disposition: "finish",
            title: "Finish it",
            copy: "Mark done. Open tickets close with it.",
            icon: "finish",
          },
          {
            disposition: "pause",
            title: "Pause it",
            copy: "Keeps its tickets. Resume when the place opens.",
            icon: "pause",
          },
          {
            disposition: "archive",
            title: "Archive it",
            copy: "Scrap it. Stays readable, can be restored to Up next.",
            icon: "archive",
          },
        ].map((choice) => (
          <button
            disabled={busy}
            key={choice.disposition}
            onClick={() =>
              command("replace_active_item", {
                currentItemId: current.id,
                nextItemId: item.id,
                disposition: choice.disposition,
              })
                .then(onClose)
                .catch((e) => setError(e.message))
            }
          >
            <strong>
              <Icon name={choice.icon} />
              {choice.title}
            </strong>
            <span>{choice.copy}</span>
          </button>
        ))}
      </div>
      <ErrorText message={error} />
      <div className="form-actions">
        <small>
          Then “{item.title}” starts in {areaNames[item.areaId]}.
        </small>
        <Button ghost onClick={onClose}>
          Keep current
        </Button>
      </div>
    </Modal>
  );
}
export function FinishDialog({
  item,
  onClose,
}: {
  item: Item;
  onClose: () => void;
}) {
  const { state, command, busy } = useApp();
  const count = state.tickets.filter(
    (t) =>
      t.projectId === item.id && ["todo", "in_progress"].includes(t.status),
  ).length;
  return (
    <Modal title={`Finish “${item.title}”?`} onClose={onClose}>
      <p>
        {item.kind === "project"
          ? `${count} open tickets will close. Future bookings will be removed from Google Calendar.`
          : "Mark this book as read and open its place."}
      </p>
      <div className="form-actions">
        <Button ghost onClick={onClose}>
          Keep current
        </Button>
        <Button
          primary
          disabled={busy}
          onClick={() =>
            safe(command("finish_item", { itemId: item.id }).then(onClose))
          }
        >
          Mark as done
        </Button>
      </div>
    </Modal>
  );
}
