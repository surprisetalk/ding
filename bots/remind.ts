// Reminder bot for ding
// Responds to posts tagged #remind with time-delayed reminders
// Usage: tag a post #remind with body like "2h check the deploy" or "1d review PR"

const DING_API_URL = Deno.env.get("DING_API_URL") || "https://ding.bar";
const BOT_EMAIL = Deno.env.get("BOT_REMIND_EMAIL") || "";
const BOT_PASSWORD = Deno.env.get("BOT_REMIND_PASSWORD") || "";

const auth = btoa(`${BOT_EMAIL}:${BOT_PASSWORD}`);
const BOT_USERNAME = BOT_EMAIL.split("@")[0].replace(/-/g, "_");

const DURATION_RE = /(\d+)\s*(m|min|h|hr|hour|d|day|w|week)s?\b/i;
const MAX_MS = 7 * 24 * 3_600_000; // 7 days

function parseDuration(body: string): { ms: number; message: string; label: string } | null {
  const match = body.match(DURATION_RE);
  if (!match) return null;
  const n = parseInt(match[1]);
  const unit = match[2][0].toLowerCase();
  const mult: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const labels: Record<string, string> = { m: "minute", h: "hour", d: "day", w: "week" };
  const rawMs = n * mult[unit];
  const clamped = rawMs > MAX_MS;
  const ms = Math.min(rawMs, MAX_MS);
  const afterMatch = body.slice((match.index || 0) + match[0].length).trim();
  const beforeMatch = body.slice(0, match.index || 0).trim();
  const message = afterMatch || beforeMatch || "reminder";
  const label = clamped ? "7 days (maximum)" : `${n} ${labels[unit]}${n > 1 ? "s" : ""}`;
  return { ms, message, label };
}

async function getBotReplies(): Promise<Map<number, string[]>> {
  const res = await fetch(`${DING_API_URL}/c?usr=${BOT_USERNAME}&comments=1&limit=100`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch bot replies: HTTP ${res.status} ${await res.text()}`);
  const replies: { parent_cid: number; body: string }[] = await res.json();
  const map = new Map<number, string[]>();
  for (const r of replies) {
    const arr = map.get(r.parent_cid) || [];
    arr.push(r.body);
    map.set(r.parent_cid, arr);
  }
  return map;
}

async function reply(parentCid: number, body: string): Promise<boolean> {
  const formData = new FormData();
  formData.append("body", body);
  const res = await fetch(`${DING_API_URL}/c/${parentCid}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: formData,
  });
  return res.ok;
}

async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) {
    console.error("Missing BOT_REMIND_EMAIL or BOT_REMIND_PASSWORD");
    Deno.exit(1);
  }

  const botReplies = await getBotReplies();
  console.log(`Tracking ${botReplies.size} previously replied posts`);

  // Find posts tagged #remind
  const res = await fetch(`${DING_API_URL}/c?tag=remind&sort=new&limit=30`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    console.error(`Failed to fetch #remind posts: ${res.status}`);
    Deno.exit(1);
  }
  const posts: { cid: number; created_by: string; body: string; created_at: string }[] = await res.json();

  const now = Date.now();
  let acks = 0, deliveries = 0;

  for (const post of posts) {
    if (post.created_by === BOT_USERNAME) continue;

    const parsed = parseDuration(post.body);
    if (!parsed) continue;

    const replies = botReplies.get(post.cid) || [];
    const hasAck = replies.some((r) => r.startsWith("Got it"));
    const hasReminder = replies.some((r) => r.includes("Reminder:"));
    const postTime = new Date(post.created_at).getTime();
    const elapsed = now - postTime;

    // Phase 1: Acknowledge
    if (!hasAck) {
      console.log(`Acking cid=${post.cid}: ${parsed.label}`);
      if (!await reply(post.cid, `Got it, I'll remind you in ${parsed.label}.`))
        console.error(`Failed to ack cid=${post.cid}`);
      else acks++;
      continue;
    }

    // Phase 2: Deliver when time is up
    if (!hasReminder && elapsed >= parsed.ms) {
      console.log(`Delivering reminder for cid=${post.cid}`);
      if (!await reply(post.cid, `@${post.created_by} Reminder: ${parsed.message}`))
        console.error(`Failed to deliver reminder for cid=${post.cid}`);
      else deliveries++;
    }
  }

  console.log(`Acked ${acks}, delivered ${deliveries} reminders`);
}

main();
