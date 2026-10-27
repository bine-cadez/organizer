import { ALARM_ENSURE_INTERVAL_MS } from "../domain/retention";

const nextTouchAt = new Map<string, number>();

/**
 * Wake the owner's Durable Object often enough that a dropped alarm is
 * restored, without calling it on every MCP message. The object reads SQL
 * when getAlarm() is missing or no longer a live schedule.
 */
export async function touchOrganizerAlarm(
  ownerSub: string,
  ensure: () => Promise<void>,
  now = Date.now(),
): Promise<void> {
  if (now < (nextTouchAt.get(ownerSub) ?? 0)) return;
  nextTouchAt.set(ownerSub, now + ALARM_ENSURE_INTERVAL_MS);
  try {
    await ensure();
  } catch (error) {
    nextTouchAt.delete(ownerSub);
    console.error(
      "organizer alarm ensure failed",
      error instanceof Error ? error.message : error,
    );
  }
}

export function resetOrganizerAlarmTouchesForTests(): void {
  nextTouchAt.clear();
}
