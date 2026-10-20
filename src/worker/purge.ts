import { LIMITS } from "../shared/domain";
import type { Env } from "./env";

export async function purgeRemovedContent(env: Env, now = Date.now()) {
  const cutoff = new Date(now - LIMITS.removalRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const removed = await env.DB.prepare("SELECT id, imageKey FROM posts WHERE removedAt IS NOT NULL AND removedAt < ?")
    .bind(cutoff)
    .all<{ id: string; imageKey: string }>();
  for (const post of removed.results) {
    await env.IMAGES.delete(post.imageKey);
    await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(post.id).run();
  }
  return removed.results.length;
}
