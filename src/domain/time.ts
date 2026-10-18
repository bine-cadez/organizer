export const TIMEZONE = "Europe/Ljubljana";
const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
export function localParts(at: number) {
  const p = Object.fromEntries(
    partsFormatter.formatToParts(new Date(at)).map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date + "T12:00:00Z") + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function reviewDate(at: number): string {
  const p = localParts(at);
  return p.hour < 4 ? addDays(p.date, -1) : p.date;
}
export function localInstant(date: string, minutes: number): number {
  const wall = Date.parse(date + "T00:00:00Z") + minutes * 60000;
  // Iterate the timezone offset; dates around DST are checked against the requested wall time.
  let result = wall;
  for (let i = 0; i < 4; i++) {
    const p = localParts(result);
    const seen =
      Date.parse(p.date + "T00:00:00Z") +
      (p.hour * 60 + p.minute) * 60000 +
      p.second * 1000;
    result += wall - seen;
  }
  const p = localParts(result);
  if (p.date !== date || p.hour * 60 + p.minute !== minutes)
    throw new Error("Nonexistent local time");
  return result;
}
export function dayBounds(date: string): [number, number] {
  return [localInstant(date, 0), localInstant(addDays(date, 1), 0)];
}
export function iso(at: number | null | undefined): string | undefined {
  return at == null ? undefined : new Date(at).toISOString();
}
