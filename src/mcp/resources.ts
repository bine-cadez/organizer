import { dayBounds } from "../domain/time";
import { executeTool, type McpContext } from "./dispatch";
import { effectiveScopes } from "./registry";

export const resourceDefinitions = [
  {
    name: "Organizer rules",
    uri: "organizer://rules",
    description:
      "Fixed areas, guarded place rules, timezone and review policy.",
  },
  {
    name: "Today",
    uri: "organizer://today/{date}",
    description: "One Ljubljana civil day of authorized planning context.",
  },
  {
    name: "Board",
    uri: "organizer://board",
    description: "Eight places and ordered Up next.",
  },
  {
    name: "Project",
    uri: "organizer://projects/{id}",
    description: "One project and only its attached learnings.",
  },
  {
    name: "Book",
    uri: "organizer://books/{id}",
    description:
      "One book, automatic cover, progress and its attached learnings.",
  },
  {
    name: "Calendar",
    uri: "organizer://calendar/{startDate}/{endDate}",
    description:
      "Authorized calendar window, start date inclusive and end date exclusive, maximum 31 days.",
  },
  {
    name: "Review",
    uri: "organizer://reviews/{date}",
    description: "Eligible unsaved review or a saved immutable final receipt.",
  },
  {
    name: "Integration status",
    uri: "organizer://integrations/status",
    description:
      "Calendar connection and synchronization status; no credentials.",
  },
] as const;

export async function readResource(uri: string, context: McpContext) {
  if (!effectiveScopes(context.actor.scopes).has("organizer:read"))
    throw new Error("Organizer read authorization is required.");
  const url = new URL(uri);
  if (
    url.protocol !== "organizer:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error("Unknown Organizer resource.");
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  let tool: string;
  let args: Record<string, unknown> = {};
  let expectedKind: "project" | "book" | undefined;
  switch (url.hostname) {
    case "rules":
      if (segments.length) throw new Error("Unknown Organizer resource.");
      tool = "get_context";
      break;
    case "board":
      if (segments.length) throw new Error("Unknown Organizer resource.");
      tool = "get_board";
      break;
    case "today":
      if (segments.length !== 1)
        throw new Error("A Today resource requires a date.");
      tool = "get_today";
      args = { date: segments[0] };
      break;
    case "projects":
    case "books":
      if (segments.length !== 1)
        throw new Error("An item resource requires an ID.");
      tool = "get_item";
      args = { itemId: segments[0] };
      expectedKind = url.hostname === "projects" ? "project" : "book";
      break;
    case "calendar": {
      if (
        segments.length !== 2 ||
        !segments.every((date) => {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
          const parsed = new Date(`${date}T12:00:00Z`);
          return (
            !Number.isNaN(parsed.getTime()) &&
            parsed.toISOString().slice(0, 10) === date
          );
        })
      )
        throw new Error("A calendar resource requires valid start/end dates.");
      tool = "list_calendar_events";
      args = {
        start: new Date(dayBounds(segments[0])[0]).toISOString(),
        end: new Date(dayBounds(segments[1])[0]).toISOString(),
        detail: effectiveScopes(context.actor.scopes).has(
          "calendar:details:read",
        )
          ? "titles"
          : "busy",
      };
      break;
    }
    case "reviews":
      if (segments.length !== 1)
        throw new Error("A review resource requires a date.");
      tool = "get_review";
      args = { date: segments[0] };
      break;
    case "integrations":
      if (segments.length !== 1 || segments[0] !== "status")
        throw new Error("Unknown Organizer resource.");
      tool = "get_calendar_sync";
      break;
    default:
      throw new Error("Unknown Organizer resource.");
  }
  const result = await executeTool(tool, args, context);
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  let payload = result.structuredContent;
  const data = payload.data as Record<string, unknown> | undefined;
  if (
    expectedKind &&
    (data?.item as { kind?: string } | undefined)?.kind !== expectedKind
  )
    throw new Error("Item not found in this resource collection.");
  if (url.hostname === "rules") {
    payload = {
      ...payload,
      data: {
        contractVersion: data?.contractVersion,
        timezone: data?.timezone,
        localDate: data?.localDate,
        reviewDate: data?.reviewDate,
        reviewCutoff: data?.reviewCutoff,
        areas: data?.areas,
        rules: data?.rules,
        limits: data?.limits,
      },
    };
  }
  return {
    contents: [
      { uri, mimeType: "application/json", text: JSON.stringify(payload) },
    ],
  };
}
