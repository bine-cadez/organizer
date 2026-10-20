import { OrganizerStore } from "../../src/storage/organizer";

export { OrganizerStore };

export default {
  async fetch(request: Request, env: Env) {
    const stub = env.ORGANIZER.get(env.ORGANIZER.idFromName("owner"));
    if (new URL(request.url).pathname === "/snapshot")
      return Response.json(await stub.snapshot());
    return new Response("ok");
  },
};
