/** Canonical audiobook length is whole minutes. 999h 59m matches the books CHECK. */
export const MAX_AUDIO_MINUTES = 999 * 60 + 59;

/** Floor, so the value reaches 100 only when current is the whole total. */
export function progressPercent(current: number, total: number): number {
  if (total <= 0) return 0;
  const clamped = Math.min(Math.max(current, 0), total);
  if (clamped >= total) return 100;
  return Math.floor((clamped / total) * 100);
}

export function splitDuration(totalMinutes: number): {
  hours: number;
  minutes: number;
} {
  const safe = Math.max(0, Math.trunc(totalMinutes));
  return { hours: Math.floor(safe / 60), minutes: safe % 60 };
}

/** Always includes hours, including zero: `5h 20m`, `0h 45m`. */
export function formatDuration(totalMinutes: number): string {
  const { hours, minutes } = splitDuration(totalMinutes);
  return `${hours}h ${minutes}m`;
}

export function formatAudiobookProgress(
  positionMinutes: number,
  durationMinutes: number,
): string {
  return `${formatDuration(positionMinutes)} / ${formatDuration(durationMinutes)} (${progressPercent(positionMinutes, durationMinutes)}%)`;
}

export function isAudiobook(item: { progressUnit?: string | null }): boolean {
  return item.progressUnit === "time";
}
