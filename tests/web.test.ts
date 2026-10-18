import { describe, expect, it } from "vitest";
import {
  addDays,
  eventsForDay,
  localInstant,
  todayTickets,
} from "../src/web/api";
import type { Snapshot } from "../src/shared/types";

describe("browser calendar dates", () => {
  it("uses consecutive Ljubljana midnights across DST", () => {
    expect(
      Date.parse(localInstant("2026-10-26", "00:00")) -
        Date.parse(localInstant("2026-10-25", "00:00")),
    ).toBe(25 * 3600000);
    expect(localInstant("2026-10-26", "07:00")).toBe(
      "2026-10-26T06:00:00.000Z",
    );
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
  });
  it("excludes events and bookings ending at the next day’s midnight", () => {
    const state = {
      localDate: "2026-10-19",
      items: [{ id: "p", kind: "project", state: "active", areaId: "tech" }],
      tickets: [{ id: "t", projectId: "p", status: "todo" }],
      bookings: [
        {
          id: "b",
          ticketId: "t",
          accountId: "a",
          calendarId: "c",
          googleEventId: "g",
          desiredPresence: "present",
          start: "2026-10-18T20:00:00Z",
          end: "2026-10-18T22:00:00Z",
        },
      ],
      events: [
        {
          id: "g",
          accountId: "a",
          calendarId: "c",
          googleEventId: "g",
          start: "2026-10-18T20:00:00Z",
          end: "2026-10-18T22:00:00Z",
          allDay: false,
        },
      ],
    } as unknown as Snapshot;
    expect(todayTickets(state)).toEqual([]);
    expect(eventsForDay(state, "2026-10-19")).toEqual([]);
    expect(eventsForDay(state, "2026-10-18")).toHaveLength(1);
  });
});
