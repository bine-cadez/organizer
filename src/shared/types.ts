export type AreaId = "tech" | "sales" | "ship" | "self";
export type ItemKind = "project" | "book";
export type ItemState = "queued" | "active" | "paused" | "archived" | "done";
export type TicketStatus = "todo" | "in_progress" | "done" | "closed";
export type CalendarRole = "personal" | "work";
export interface Actor {
  id: string;
  type: "human" | "agent" | "system";
  scopes: string[];
}
export interface Area {
  id: AreaId;
  code: string;
  name: string;
  fullName: string;
}
export interface Item {
  id: string;
  kind: ItemKind;
  areaId: AreaId;
  title: string;
  state: ItemState;
  version: string;
  goal?: string;
  authors?: string[];
  pageCount?: number;
  pageCountSource?: string;
  currentPage?: number;
  coverUrl?: string;
  workId?: string;
  editionId?: string;
  isbn?: string;
  order?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  pausedAt?: string;
  archivedAt?: string;
  doneAt?: string;
}
export interface Ticket {
  id: string;
  projectId: string;
  title: string;
  status: TicketStatus;
  plannedFor?: string;
  order: number;
  currentBookingId?: string;
  doneAt?: string;
  version: string;
}
export interface Learning {
  id: string;
  text: string;
  createdOn: string;
  projectId?: string;
  bookId?: string;
  sourceKind: "review" | "direct";
  reviewId?: string;
  version: string;
  createdBy?: string;
}
export interface Booking {
  id: string;
  ticketId: string;
  accountId: string;
  start: string;
  end: string;
  googleEventId: string;
  calendarId: string;
  syncState: "pending" | "synced" | "failed";
  desiredPresence: "present" | "absent";
  retiredAt?: string;
  version: string;
  remoteStart?: string;
  remoteEnd?: string;
}
export interface Connection {
  id: string;
  role: CalendarRole;
  email: string;
  status: "connected" | "needs_reconnect" | "error";
  lastSyncedAt?: string;
  calendarIds: string[];
  writeCalendarId?: string;
  version: string;
}
export interface CalendarEvent {
  id: string;
  accountId: string;
  role: CalendarRole;
  calendarId: string;
  googleEventId: string;
  title: string;
  start?: string;
  end?: string;
  allDay: boolean;
  isBusy: boolean;
  startDate?: string;
  endDate?: string;
  etag?: string;
}
export interface Operation {
  id: string;
  bookingId?: string;
  action: string;
  status:
    | "pending"
    | "running"
    | "waiting_retry"
    | "needs_reconnect"
    | "succeeded"
    | "failed"
    | "superseded";
  attempts: number;
  nextAttemptAt?: string;
  error?: string;
  version: string;
}
export type SlippedDestination =
  | { kind: "tomorrow_unbooked" }
  | { kind: "back_to_todo" }
  | { kind: "book"; start: string; end: string; allowOverlap: boolean };
export interface ReviewDraft {
  completedTicketIds: string[];
  slippedDestinations: { ticketId: string; destination: SlippedDestination }[];
  bookPages: { bookId: string; currentPage: number }[];
  markReadBookIds: string[];
  learning: null | { text: string; target: { kind: ItemKind; id: string } };
}
export interface Review {
  id: string;
  date: string;
  version: string;
  draft?: ReviewDraft;
  saved?: ReviewDraft;
  savedAt?: string;
  summary?: Record<string, unknown>;
}
export interface Snapshot {
  areas: Area[];
  items: Item[];
  tickets: Ticket[];
  learnings: Learning[];
  bookings: Booking[];
  connections: Connection[];
  events: CalendarEvent[];
  operations: Operation[];
  reviews: Review[];
  versions: Record<string, string>;
  ownerRevision: string;
  timezone: string;
  localDate: string;
  reviewDate: string;
  setupSkipped: boolean;
}
export interface BookCandidate {
  editionId: string;
  workId?: string;
  title: string;
  authors: string[];
  pageCount?: number;
  pageCountSource?: string;
  coverUrl?: string;
  coverId?: number;
  isbn?: string;
  year?: number;
}
export const ALL_SCOPES = [
  "organizer:read",
  "organizer:write",
  "calendar:busy:read",
  "calendar:details:read",
  "calendar:book",
  "lifecycle:write",
  "review:write",
  "audit:read",
];
