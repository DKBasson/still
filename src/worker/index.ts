import { app } from "./app";
import type { Env } from "./env";
import { purgeRemovedContent } from "./purge";

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(purgeRemovedContent(env));
  },
};
