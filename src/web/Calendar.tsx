import { useEffect, useMemo, useRef, useState } from "react";
import { CALENDAR_SYNC_INTERVAL_MS } from "../domain/retention";
import type { Ticket } from "../shared/types";
import {
  addDays,
  currentBooking,
  dateOf,
  eventsForDay,
  localInstant,
  longDate,
  monday,
  query,
  safe,
  shortDate,
  timeOf,
  zone,
} from "./api";
import { useApp } from "./context";
import {
  areaNames,
  Button,
  Empty,
  ErrorText,
  Field,
  Icon,
  Modal,
  PageHeader,
  Segment,
  Tile,
} from "./ui";
import { CalendarLegend } from "./Core";

const minutes = (instant: string) => {
  const [h, m] = timeOf(instant).split(":").map(Number);
  return h * 60 + m;
};
const timeLabel = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
export function DayTimeline({ date }: { date: string }) {
  const { state, navigate } = useApp();
  const events = eventsForDay(state, date);
  const now = new Date();
  const nowMinute = minutes(now.toISOString());
  return (
    <>
      <div className="day-timeline" style={{ height: 15 * 48 }}>
        {Array.from({ length: 16 }, (_, i) => (
          <div className="day-hour" key={i} style={{ top: i * 48 }}>
            <time>{String(i + 7).padStart(2, "0")}:00</time>
            <span />
          </div>
        ))}
        {events.map((event) => {
          const start = Math.max(
            420,
            dateOf(event.start!) < date ? 420 : minutes(event.start!),
          );
          const end = Math.min(
            1320,
            dateOf(event.end!) > date ? 1320 : minutes(event.end!),
          );
          if (end <= start) return null;
          return (
            <div
              key={event.id}
              className={`day-event calendar-event ${event.booking ? "ticket-event " + (event.areaId ?? "") : event.role} ${event.booking && event.booking.syncState !== "synced" ? event.booking.syncState : ""}`}
              style={{
                top: ((start - 420) / 60) * 48,
                height: Math.max(18, ((end - start) / 60) * 48 - 3),
              }}
            >
              <strong>
                {event.role === "work" && <Icon name="lock" />}
                {event.areaId && <Tile area={event.areaId as any} />}
                {event.title}
              </strong>
              <small>
                {timeOf(event.start!)}–{timeOf(event.end!)} ·{" "}
                {event.booking
                  ? event.booking.syncState === "synced"
                    ? "Booked on Personal"
                    : `Personal · ${event.booking.syncState}`
                  : event.role === "work"
                    ? "Work, read-only"
                    : "Personal"}
              </small>
            </div>
          );
        })}
        {date === dateOf(now) && nowMinute >= 420 && nowMinute <= 1320 && (
          <div
            className="now-line"
            style={{ top: ((nowMinute - 420) / 60) * 48 }}
          >
            <span />
          </div>
        )}
        {events.length === 0 && (
          <div className="timeline-empty">
            <strong>Nothing on either calendar today.</strong>
            <p>
              {state.connections.length
                ? "Your calendars are clear from 07:00 to 22:00. Book your tickets into the day so they don't drift."
                : "Connect your calendars to see your day here."}
            </p>
            <Button
              small
              onClick={() =>
                navigate(state.connections.length ? "calendar" : "settings")
              }
            >
              {state.connections.length
                ? "Plan the day on the week view"
                : "Connect calendars"}
            </Button>
          </div>
        )}
      </div>
      <ConnectionNotes />
    </>
  );
}
export function ConnectionNotes() {
  const { state } = useApp();
  return (
    <div className="connection-notes">
      {(["personal", "work"] as const).map((role) => {
        const connection = state.connections.find((c) => c.role === role);
        if (connection?.status === "connected") {
          const stale =
            connection.lastSyncedAt &&
            Date.now() - Date.parse(connection.lastSyncedAt) >
              CALENDAR_SYNC_INTERVAL_MS;
          return stale ? (
            <p key={role}>
              {role === "personal" ? "Personal" : "Work"} calendar last updated{" "}
              {timeOf(connection.lastSyncedAt!)}. Retrying…
            </p>
          ) : null;
        }
        if (role === "work" && !connection) return null;
        return (
          <p key={role}>
            {role === "personal"
              ? "Personal calendar disconnected. Reconnect to book time."
              : "Work calendar disconnected. Busy times from Work aren't shown."}{" "}
            <a href={`/auth/calendar?role=${role}`}>
              {connection ? "Reconnect" : "Connect Google"}
            </a>
          </p>
        );
      })}
    </div>
  );
}
export function Calendar() {
  const { state, command, setModal, busy, refresh } = useApp();
  const [week, setWeek] = useState(monday(state.localDate));
  const [showPersonal, setShowPersonal] = useState(true);
  const [showWork, setShowWork] = useState(true);
  const [picked, setPicked] = useState<string>();
  const [cursor, setCursor] = useState({ day: 0, slot: 0 });
  const [message, setMessage] = useState("");
  const [dragStart, setDragStart] = useState<{
    id: string;
    y: number;
    end: number;
  }>();
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const sync = () =>
      query("list_calendar_events", {
        start: localInstant(week, "00:00"),
        end: localInstant(addDays(week, 7), "00:00"),
        detail: "titles",
      })
        .then(() => {
          if (active) return refresh();
        })
        .catch((e) => {
          if (active) setMessage(e.message);
        });
    safe(sync());
    window.addEventListener("focus", sync);
    const timer = window.setInterval(sync, CALENDAR_SYNC_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", sync);
    };
  }, [week, refresh]);
  const active = new Set(
    state.items
      .filter((i) => i.kind === "project" && i.state === "active")
      .map((i) => i.id),
  );
  const connected = state.connections.some(
    (c) => c.role === "personal" && c.status === "connected",
  );
  const tickets = state.tickets.filter(
    (t) =>
      active.has(t.projectId) &&
      !["done", "closed"].includes(t.status) &&
      (!currentBooking(state, t) ||
        Date.parse(currentBooking(state, t)!.end) <= Date.now()),
  );
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  async function bookAt(ticketId: string, day: number, slot: number) {
    if (!connected) {
      setMessage("Connect your Personal calendar to book time.");
      return;
    }
    const date = days[day];
    const minute = Math.min(1320, Math.max(420, 420 + slot * 15));
    try {
      await command("book_ticket", {
        ticketId,
        start: localInstant(date, timeLabel(minute)),
        end: localInstant(date, timeLabel(minute + 60)),
        allowOverlap: false,
      });
      setPicked(undefined);
      setMessage(
        `Booked ${shortDate(date)} ${timeLabel(minute)}–${timeLabel(minute + 60)} on Personal calendar.`,
      );
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  const pick = (ticket: Ticket) => {
    if (!connected) {
      setMessage("Connect your Personal calendar to book time.");
      return;
    }
    setPicked(ticket.id);
    setCursor({ day: 0, slot: 0 });
    setMessage(
      "Now tap a free spot on the week to book it. Use arrow keys to move, Enter to book, Escape to cancel.",
    );
    requestAnimationFrame(() => grid.current?.focus());
  };
  async function resize(id: string, end: number) {
    const booking = state.bookings.find((b) => b.id === id);
    if (!booking) return;
    const lower = Math.max(435, minutes(booking.start) + 15);
    const bounded = Math.min(1380, Math.max(lower, end));
    try {
      await command("resize_booking", {
        bookingId: id,
        end: localInstant(dateOf(booking.start), timeLabel(bounded)),
      });
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <>
      <PageHeader
        title={`Week of ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${week}T12:00:00Z`))}`}
        subtitle="Drag a ticket into free time. It lands as a 1 h block; drag its bottom edge to change the length."
      />
      <div className="calendar-toolbar">
        <Button
          small
          aria-pressed={showPersonal}
          onClick={() => setShowPersonal(!showPersonal)}
        >
          <span className="calendar-key personal" />
          Personal · can book
        </Button>
        <Button
          small
          aria-pressed={showWork}
          onClick={() => setShowWork(!showWork)}
        >
          <span className="calendar-key work" />
          Work · read-only
        </Button>
        <div className="week-nav">
          <button
            aria-label="Previous week"
            onClick={() => setWeek(addDays(week, -7))}
          >
            ‹
          </button>
          <button onClick={() => setWeek(monday(state.localDate))}>
            This week
          </button>
          <button
            aria-label="Next week"
            onClick={() => setWeek(addDays(week, 7))}
          >
            ›
          </button>
        </div>
      </div>
      <ConnectionNotes />
      <p role="status" className="calendar-message">
        {message}
      </p>
      <div className="week-layout">
        <aside className="panel unbooked">
          <h2>Not booked yet · {tickets.length}</h2>
          <p className="muted">
            From your active projects. Drag onto the week, or click one and then
            click a free spot.
          </p>
          <div className="unbooked-list">
            {tickets.map((ticket) => {
              const item = state.items.find((i) => i.id === ticket.projectId)!;
              return (
                <div
                  key={ticket.id}
                  className={`unbooked-ticket ${item.areaId}`}
                  draggable={connected}
                  onDragStart={(e) =>
                    e.dataTransfer.setData("text/organizer-ticket", ticket.id)
                  }
                >
                  <button
                    aria-pressed={picked === ticket.id}
                    onClick={() => pick(ticket)}
                  >
                    <span aria-hidden="true" className="drag-grip">
                      ⠿
                    </span>
                    <strong>{ticket.title}</strong>
                    <small>
                      <Tile area={item.areaId} />
                      {item.title}
                    </small>
                  </button>
                  <button
                    className="text-button"
                    disabled={!connected}
                    onClick={() => setModal({ type: "book", ticket })}
                  >
                    Book time
                  </button>
                </div>
              );
            })}
            {!tickets.length && (
              <p className="muted">
                No unbooked tickets. Add a ticket to an active project on the
                Board.
              </p>
            )}
          </div>
        </aside>
        <div className="week-scroll" aria-label="Scrollable week">
          <div className="week-canvas">
            <div className="week-head">
              <span />
              {days.map((date) => (
                <div
                  className={date === state.localDate ? "is-today" : ""}
                  key={date}
                >
                  <span>
                    {new Intl.DateTimeFormat("en-GB", {
                      weekday: "short",
                      timeZone: "UTC",
                    }).format(new Date(`${date}T12:00:00Z`))}
                  </span>
                  <strong>{Number(date.slice(-2))}</strong>
                </div>
              ))}
            </div>
            <div className="all-day-strip">
              <small>All day</small>
              {days.map((date) => (
                <div key={date}>
                  {state.events
                    .filter(
                      (e) =>
                        e.allDay &&
                        e.startDate &&
                        e.endDate &&
                        e.startDate <= date &&
                        e.endDate > date &&
                        (e.role === "work" ? showWork : showPersonal),
                    )
                    .map((e) => (
                      <span title={e.title} key={e.id}>
                        {e.title}
                      </span>
                    ))}
                </div>
              ))}
            </div>
            <div
              className="week-grid"
              ref={grid}
              tabIndex={0}
              role="grid"
              aria-label={
                picked
                  ? `Place selected ticket. ${shortDate(days[cursor.day])} ${timeLabel(420 + cursor.slot * 15)}`
                  : "Week calendar. Pick a ticket to book it."
              }
              onKeyDown={(e) => {
                if (!picked) return;
                if (
                  [
                    "ArrowUp",
                    "ArrowDown",
                    "ArrowLeft",
                    "ArrowRight",
                    "Enter",
                    "Escape",
                  ].includes(e.key)
                )
                  e.preventDefault();
                if (e.key === "Escape") {
                  setPicked(undefined);
                  setMessage("Booking cancelled.");
                } else if (e.key === "Enter")
                  safe(bookAt(picked, cursor.day, cursor.slot));
                else if (e.key === "ArrowLeft")
                  setCursor((c) => ({ ...c, day: Math.max(0, c.day - 1) }));
                else if (e.key === "ArrowRight")
                  setCursor((c) => ({ ...c, day: Math.min(6, c.day + 1) }));
                else if (e.key === "ArrowUp")
                  setCursor((c) => ({ ...c, slot: Math.max(0, c.slot - 1) }));
                else if (e.key === "ArrowDown")
                  setCursor((c) => ({ ...c, slot: Math.min(60, c.slot + 1) }));
              }}
            >
              <div className="week-hours">
                {Array.from({ length: 17 }, (_, i) => (
                  <time style={{ top: i * 44 }} key={i}>
                    {String(i + 7).padStart(2, "0")}:00
                  </time>
                ))}
              </div>
              {days.map((date, day) => (
                <div
                  className={`week-day ${date === state.localDate ? "is-today" : ""}`}
                  key={date}
                  role="row"
                  onDragOver={(e) => {
                    if (connected) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const ticket = e.dataTransfer.getData(
                      "text/organizer-ticket",
                    );
                    const bounds = e.currentTarget.getBoundingClientRect();
                    const slot = Math.round((e.clientY - bounds.top) / 11);
                    if (tickets.some((t) => t.id === ticket))
                      safe(bookAt(ticket, day, slot));
                  }}
                  onClick={(e) => {
                    if (picked && e.target === e.currentTarget) {
                      const bounds = e.currentTarget.getBoundingClientRect();
                      safe(
                        bookAt(
                          picked,
                          day,
                          Math.round((e.clientY - bounds.top) / 11),
                        ),
                      );
                    }
                  }}
                >
                  {eventsForDay(state, date)
                    .filter((e) =>
                      e.role === "work" ? showWork : showPersonal,
                    )
                    .map((event) => {
                      const start = Math.max(
                        420,
                        dateOf(event.start!) < date
                          ? 420
                          : minutes(event.start!),
                      );
                      const end = Math.min(
                        1380,
                        dateOf(event.end!) > date ? 1380 : minutes(event.end!),
                      );
                      if (end <= start) return null;
                      const ticket = state.tickets.find(
                        (t) => t.id === event.booking?.ticketId,
                      );
                      const current =
                        event.booking &&
                        ticket?.currentBookingId === event.booking.id &&
                        Date.parse(event.booking.end) > Date.now();
                      return (
                        <div
                          key={event.id}
                          className={`week-event calendar-event ${event.booking ? `ticket-event ${event.areaId ?? ""} ${event.booking.syncState}` : event.role}`}
                          style={{
                            top: ((start - 420) / 60) * 44,
                            height: Math.max(18, ((end - start) / 60) * 44 - 3),
                          }}
                        >
                          <button
                            className="event-content"
                            disabled={!current}
                            onClick={() => {
                              if (ticket && current)
                                setModal({ type: "book", ticket });
                            }}
                            aria-label={`${event.title}, ${timeOf(event.start!)} to ${timeOf(event.end!)}${event.booking ? `, ${event.booking.syncState}` : `, ${event.role}`}`}
                          >
                            <strong>
                              {event.role === "work" && <Icon name="lock" />}
                              {event.title}
                            </strong>
                            <small>
                              {timeOf(event.start!)}–{timeOf(event.end!)}
                            </small>
                          </button>
                          {current && (
                            <div
                              className="resize-grip"
                              role="slider"
                              tabIndex={0}
                              aria-label={`End time for ${event.title}`}
                              aria-valuemin={minutes(event.start!) + 15}
                              aria-valuemax={1380}
                              aria-valuenow={minutes(event.end!)}
                              aria-valuetext={timeOf(event.end!)}
                              onKeyDown={(e) => {
                                if (
                                  e.key === "ArrowUp" ||
                                  e.key === "ArrowDown"
                                ) {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  safe(
                                    resize(
                                      event.booking!.id,
                                      minutes(event.end!) +
                                        (e.key === "ArrowUp" ? -15 : 15),
                                    ),
                                  );
                                }
                              }}
                              onPointerDown={(e) => {
                                e.preventDefault();
                                e.currentTarget.setPointerCapture(e.pointerId);
                                setDragStart({
                                  id: event.booking!.id,
                                  y: e.clientY,
                                  end: minutes(event.end!),
                                });
                              }}
                              onPointerUp={(e) => {
                                if (dragStart?.id === event.booking!.id) {
                                  const end =
                                    dragStart.end +
                                    Math.round((e.clientY - dragStart.y) / 11) *
                                      15;
                                  setDragStart(undefined);
                                  safe(resize(event.booking!.id, end));
                                }
                              }}
                            >
                              <span />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  {picked && cursor.day === day && (
                    <div
                      className="booking-cursor"
                      style={{ top: cursor.slot * 11 }}
                      role="gridcell"
                    >
                      {timeLabel(420 + cursor.slot * 15)} · 1 h
                    </div>
                  )}
                  {date === state.localDate &&
                    minutes(new Date().toISOString()) >= 420 &&
                    minutes(new Date().toISOString()) <= 1380 && (
                      <div
                        className="now-line"
                        style={{
                          top:
                            ((minutes(new Date().toISOString()) - 420) / 60) *
                            44,
                        }}
                      />
                    )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
export function BookTime({
  ticket,
  date: initialDate,
  time: initialTime,
  onStage,
  onClose,
}: {
  ticket: Ticket;
  date?: string;
  time?: string;
  onStage?: (value: {
    start: string;
    end: string;
    allowOverlap: boolean;
  }) => void;
  onClose: () => void;
}) {
  const { state, command, busy, refresh } = useApp();
  const booking = currentBooking(state, ticket);
  const current =
    booking && Date.parse(booking.end) > Date.now() ? booking : undefined;
  const afterCutoff = timeOf(new Date()) >= "21:45";
  const [date, setDate] = useState(
    initialDate ??
      (current
        ? dateOf(current.start)
        : afterCutoff
          ? addDays(state.localDate, 1)
          : state.localDate),
  );
  const [start, setStart] = useState(
    initialTime ?? (current ? timeOf(current.start) : "07:00"),
  );
  const [length, setLength] = useState(
    current
      ? Math.round(
          (Date.parse(current.end) - Date.parse(current.start)) / 60000,
        )
      : 60,
  );
  const [customEnd, setCustomEnd] = useState("");
  const [error, setError] = useState("");
  const [acceptIncomplete, setAcceptIncomplete] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [userTime, setUserTime] = useState(Boolean(initialTime || current));
  const connected = state.connections.some(
    (c) => c.role === "personal" && c.status === "connected",
  );
  const incomplete = state.connections.some(
    (c) =>
      c.status !== "connected" ||
      !c.lastSyncedAt ||
      Date.now() - Date.parse(c.lastSyncedAt) > CALENDAR_SYNC_INTERVAL_MS,
  );
  const startMinutes =
    Number(start.split(":")[0]) * 60 + Number(start.split(":")[1]);
  const endMinutes = customEnd
    ? Number(customEnd.split(":")[0]) * 60 + Number(customEnd.split(":")[1])
    : startMinutes + length;
  const end = timeLabel(Math.min(1380, endMinutes));
  const conflicts = eventsForDay(state, date).filter(
    (e) =>
      e.isBusy &&
      e.booking?.id !== current?.id &&
      e.start &&
      e.end &&
      minutes(e.start) < endMinutes &&
      minutes(e.end) > startMinutes,
  );
  useEffect(() => {
    if (!connected) return;
    let active = true;
    query<any>("find_free_starts", {
      date,
      lengthMinutes: customEnd
        ? Math.max(15, endMinutes - startMinutes)
        : length,
      ...(current ? { excludeBookingId: current.id } : {}),
    })
      .then(async (value) => {
        if (!active) return;
        await refresh();
        if (!active) return;
        const raw = value.starts ?? value.freeStarts ?? value.suggestions ?? [];
        const values = raw
          .map((s: any) => (typeof s === "string" ? s : s.start))
          .filter(Boolean)
          .map((s: string) => (s.includes("T") ? timeOf(s) : s))
          .slice(0, 4);
        setSuggestions(values);
        if (!userTime && values.length) setStart(values[0]);
      })
      .catch(() => {
        if (active) setSuggestions([]);
      });
    return () => {
      active = false;
    };
  }, [date, length, connected, current?.id]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      if (endMinutes <= startMinutes || endMinutes > 1380 || startMinutes < 420)
        throw new Error(
          "Choose a time between 07:00 and 23:00, with the end after the start.",
        );
      const value = {
        start: localInstant(date, start),
        end: localInstant(date, timeLabel(endMinutes)),
        allowOverlap: conflicts.length > 0,
      };
      if (onStage) {
        onStage(value);
        onClose();
        return;
      }
      await command(current ? "move_booking" : "book_ticket", {
        ...(current ? { bookingId: current.id } : { ticketId: ticket.id }),
        ...value,
        acceptIncompleteAvailability: acceptIncomplete,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal
      title={`Book time for “${ticket.title}”`}
      onClose={onClose}
      className="book-time-dialog"
    >
      <form onSubmit={submit}>
        <Segment
          label="Booking day"
          value={
            date === state.localDate
              ? "today"
              : date === addDays(state.localDate, 1)
                ? "tomorrow"
                : "other"
          }
          values={[
            { id: "today", label: "Today" },
            { id: "tomorrow", label: "Tomorrow" },
          ]}
          onChange={(v) => {
            setDate(
              v === "today" ? state.localDate : addDays(state.localDate, 1),
            );
            setUserTime(false);
          }}
        />
        <Field label="Date">
          <input
            type="date"
            value={date}
            required
            onChange={(e) => {
              setDate(e.target.value);
              setUserTime(false);
            }}
          />
        </Field>
        <fieldset>
          <legend>Start</legend>
          {suggestions.length > 0 && (
            <div className="time-chips">
              {suggestions.map((time) => (
                <Button
                  small
                  key={time}
                  type="button"
                  aria-pressed={start === time}
                  onClick={() => {
                    setStart(time);
                    setUserTime(true);
                  }}
                >
                  {time}
                </Button>
              ))}
            </div>
          )}
          <label className="inline-field">
            {suggestions.length ? "or" : "Start time"}
            <input
              aria-label="Start time"
              type="time"
              step={900}
              min="07:00"
              max="22:45"
              required
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                setUserTime(true);
              }}
            />
          </label>
        </fieldset>
        <fieldset>
          <legend>Length</legend>
          <div className="time-chips">
            {[30, 60, 120].map((value) => (
              <Button
                small
                type="button"
                key={value}
                aria-pressed={!customEnd && length === value}
                onClick={() => {
                  setLength(value);
                  setCustomEnd("");
                }}
              >
                {value === 30 ? "30 min" : `${value / 60} h`}
              </Button>
            ))}
          </div>
          <label className="inline-field">
            or ends at
            <input
              aria-label="Custom end time"
              type="time"
              step={900}
              min={start}
              max="23:00"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
            />
          </label>
        </fieldset>
        <p
          className={`fit-line ${conflicts.length ? "conflict" : ""}`}
          aria-live="polite"
        >
          {conflicts.length
            ? `⚠ Overlaps “${conflicts[0].title}” ${timeOf(conflicts[0].start!)}–${timeOf(conflicts[0].end!)}`
            : `Free for this ${endMinutes - startMinutes} minute block${suggestions.length ? "" : " in the available calendar data"}.`}
        </p>
        {incomplete && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={acceptIncomplete}
              onChange={(e) => setAcceptIncomplete(e.target.checked)}
            />
            Book using incomplete or stale calendar availability
          </label>
        )}
        {!connected && (
          <p className="error-text">
            Personal calendar disconnected.{" "}
            <a href="/auth/calendar?role=personal">Reconnect to book time.</a>
          </p>
        )}
        <ErrorText message={error} />
        <Button
          primary
          className="full-width"
          disabled={busy || !connected}
          type="submit"
        >
          <Icon name="book-time" />
          {onStage
            ? "Use this time"
            : current
              ? "Move to"
              : conflicts.length
                ? "Book anyway"
                : "Book"}{" "}
          {date === state.localDate
            ? "today"
            : date === addDays(state.localDate, 1)
              ? "tomorrow"
              : shortDate(date)}{" "}
          {start}–{end}
        </Button>
        <p className="booking-footnote">
          <Icon name="lock" />
          {onStage
            ? "Staged for review. Nothing is booked until Save review."
            : "Creates an event on your Personal Google calendar. Work stays read-only."}
        </p>
        {current && !onStage && (
          <Button
            ghost
            small
            className="full-width"
            type="button"
            onClick={() =>
              safe(
                command("remove_booking", { bookingId: current.id }).then(
                  onClose,
                ),
              )
            }
          >
            Remove booking
          </Button>
        )}
      </form>
    </Modal>
  );
}
