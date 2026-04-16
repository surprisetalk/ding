// Responds to posts tagged #remind with time-delayed reminders.
// Usage: tag a post #remind with body like "2h check the deploy".

import { botInit, getJson, reply } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("REMIND");

const DURATION_RE = /(\d+)\s*(m|min|h|hr|hour|d|day|w|week)s?\b/i;
const MAX_MS = 7 * 86_400_000;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const UNIT_NAME: Record<string, string> = { m: "minute", h: "hour", d: "day", w: "week" };

function parseDuration(body: string): { ms: number; message: string; label: string } | null {
  const match = body.match(DURATION_RE);
  if (!match) return null;
  const n = parseInt(match[1]);
  const unit = match[2][0].toLowerCase();
  const raw = n * UNIT_MS[unit];
  const clamped = raw > MAX_MS;
  const ms = Math.min(raw, MAX_MS);
  const after = body.slice((match.index || 0) + match[0].length).trim();
  const before = body.slice(0, match.index || 0).trim();
  return {
    ms,
    message: after || before || "reminder",
    label: clamped ? "7 days (maximum)" : `${n} ${UNIT_NAME[unit]}${n > 1 ? "s" : ""}`,
  };
}

async function main() {
  const replies = await getJson<{ parent_cid: number; body: string }[]>(
    `/c?usr=${botUsername}&comments=1&limit=100`,
    auth,
    apiUrl,
  );
  const byParent = new Map<number, string[]>();
  for (const r of replies) {
    const arr = byParent.get(r.parent_cid) || [];
    arr.push(r.body);
    byParent.set(r.parent_cid, arr);
  }
  console.log(`Tracking ${byParent.size} previously replied posts`);

  const posts = await getJson<{ cid: number; created_by: string; body: string; created_at: string }[]>(
    `/c?tag=remind&sort=new&limit=30`,
    auth,
    apiUrl,
  );

  const now = Date.now();
  let acks = 0, deliveries = 0;

  for (const post of posts) {
    if (post.created_by === botUsername) continue;
    const parsed = parseDuration(post.body);
    if (!parsed) continue;

    const prior = byParent.get(post.cid) || [];
    const hasAck = prior.some((r) => r.startsWith("Got it"));
    const hasReminder = prior.some((r) => r.includes("Reminder:"));
    const elapsed = now - new Date(post.created_at).getTime();

    if (!hasAck) {
      console.log(`Acking cid=${post.cid}: ${parsed.label}`);
      if (await reply(auth, apiUrl, post.cid, `Got it, I'll remind you in ${parsed.label}.`)) acks++;
      continue;
    }

    if (!hasReminder && elapsed >= parsed.ms) {
      console.log(`Delivering reminder for cid=${post.cid}`);
      if (await reply(auth, apiUrl, post.cid, `@${post.created_by} Reminder: ${parsed.message}`)) deliveries++;
    }
  }

  console.log(`Acked ${acks}, delivered ${deliveries} reminders`);
}

main();
