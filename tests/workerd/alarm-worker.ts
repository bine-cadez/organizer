import { OrganizerStore as Store } from "../../src/storage/organizer";
import type { AppEnv } from "../../src/worker/env";

export class OrganizerStore extends Store {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS alarm_marker(note TEXT PRIMARY KEY)",
    );
  }
  armAlarm() {
    return this.ctx.storage.setAlarm(Date.now() + 50);
  }
  override async alarm() {
    await super.alarm();
    this.ctx.storage.sql.exec(
      "INSERT INTO alarm_marker(note) VALUES('ran')",
    );
  }
}

type AlarmEnv = { ORGANIZER: DurableObjectNamespace<OrganizerStore> };

export default {
  async fetch(request: Request, env: AlarmEnv) {
    const stub = env.ORGANIZER.get(env.ORGANIZER.idFromName("owner"));
    if (new URL(request.url).pathname === "/arm") {
      await stub.armAlarm();
      return new Response("armed");
    }
    return new Response("ok");
  },
};
