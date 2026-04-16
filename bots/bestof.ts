// Daily/weekly/monthly/yearly digests + monthly prediction threads

import { botInit, getJson, postForm } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("BESTOF");

type Post = {
  cid: number;
  body: string;
  created_by: string;
  created_at: string;
  reaction_count: number;
  tags: string[];
};

const DAY = 86_400_000;
const isBot = (name: string) => /^bot[-_]/.test(name);
const g = <T>(path: string) => getJson<T>(path, auth, apiUrl);
const p = (path: string, fields: Record<string, string>) => postForm(path, fields, auth, apiUrl);

async function fetchRecent(windowMs: number, maxPages: number): Promise<Post[]> {
  const cutoff = Date.now() - windowMs;
  const out: Post[] = [];
  for (let page = 0; page < maxPages; page++) {
    const items = await g<Post[]>(`/c?sort=new&limit=100&p=${page}`);
    if (!items.length) return out;
    for (const item of items) {
      if (new Date(item.created_at).getTime() < cutoff) return out;
      out.push(item);
    }
    if (items.length < 100) return out;
  }
  throw new Error(`fetchRecent hit maxPages=${maxPages} before reaching cutoff ${new Date(cutoff).toISOString()} — digest would be truncated`);
}

type Period = {
  tag: string;
  windowMs: number;
  minGapMs: number;
  maxPages: number;
  label: (now: Date) => string;
};

const PERIODS: Period[] = [
  { tag: "daily", windowMs: DAY, minGapMs: 20 * 3_600_000, maxPages: 2,
    label: (d) => d.toLocaleString("en-US", { month: "short", day: "numeric" }) },
  { tag: "weekly", windowMs: 7 * DAY, minGapMs: 6 * DAY, maxPages: 5,
    label: (d) => `week of ${d.toLocaleString("en-US", { month: "short", day: "numeric" })}` },
  { tag: "monthly", windowMs: 30 * DAY, minGapMs: 28 * DAY, maxPages: 15,
    label: (d) => d.toLocaleString("en-US", { month: "long", year: "numeric" }) },
  { tag: "yearly", windowMs: 365 * DAY, minGapMs: 360 * DAY, maxPages: 50,
    label: (d) => String(d.getFullYear()) },
];

const EXCLUDED_TAGS = new Set(["bot", "bestof", "daily", "weekly", "monthly", "yearly"]);

function topBy(posts: Post[], key: (p: Post) => string[], filter: (v: string) => boolean = () => true, n = 10) {
  const agg = new Map<string, { reactions: number; count: number }>();
  for (const post of posts) {
    for (const v of key(post)) {
      if (!filter(v)) continue;
      const a = agg.get(v) || { reactions: 0, count: 0 };
      a.reactions += post.reaction_count;
      a.count += 1;
      agg.set(v, a);
    }
  }
  return [...agg.entries()]
    .map(([k, a]) => ({ k, ...a }))
    .sort((a, b) => b.reactions - a.reactions || b.count - a.count)
    .slice(0, n);
}

async function digest(period: Period) {
  const prior = await g<Post[]>(`/c?usr=${botUsername}&tag=${period.tag}&limit=1`);
  const lastAge = prior[0] ? Date.now() - new Date(prior[0].created_at).getTime() : Infinity;
  if (lastAge < period.minGapMs) {
    console.log(`[${period.tag}] last was ${(lastAge / DAY).toFixed(1)}d ago, skipping`);
    return;
  }

  const posts = (await fetchRecent(period.windowMs, period.maxPages)).filter((p) => !isBot(p.created_by));
  if (posts.length < 3) {
    console.log(`[${period.tag}] only ${posts.length} human posts in window, skipping`);
    return;
  }

  const ps = [...posts].sort((a, b) => b.reaction_count - a.reaction_count).slice(0, 10);
  const ts = topBy(posts, (p) => p.tags, (t) => !EXCLUDED_TAGS.has(t));
  const us = topBy(posts, (p) => [p.created_by]);

  const sections: string[] = [];
  if (ps.length) sections.push("Top posts\n" + ps.map((p, i) =>
    `${i + 1}. ${p.body.trim().split("\n")[0].slice(0, 80)} (${p.reaction_count} ▲) — /c/${p.cid}`
  ).join("\n"));
  if (ts.length) sections.push("Top tags\n" + ts.map((t, i) =>
    `${i + 1}. #${t.k} (${t.reactions} ▲ across ${t.count} posts)`
  ).join("\n"));
  if (us.length) sections.push("Top users\n" + us.map((u, i) =>
    `${i + 1}. @${u.k} (${u.reactions} ▲ across ${u.count} posts)`
  ).join("\n"));

  const body = `BestOf — ${period.label(new Date())}\n\n${sections.join("\n\n")}`;
  console.log(`[${period.tag}] posting digest (${posts.length} posts in window)`);
  await p("/c", { body, tags: `#bestof #bot #${period.tag}` });
}

async function monthlyPredictions() {
  const now = new Date();
  if (now.getDate() > 3) return;

  const posts = await g<Post[]>(`/c?usr=${botUsername}&tag=predictions&limit=5`);
  const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const currentMonth = ym(now);

  if (posts.some((p) => ym(new Date(p.created_at)) === currentMonth)) {
    console.log("Already posted predictions for this month");
    return;
  }

  const last = posts[0];
  if (last) {
    const lastMonth = new Date(last.created_at);
    if (lastMonth.getMonth() === (now.getMonth() - 1 + 12) % 12) {
      console.log(`Following up on last month's predictions (cid=${last.cid})`);
      await p(`/c/${last.cid}`, { body: `Time's up! How did we do?\n\nReply to your original prediction with how it turned out.` });
    }
  }

  const monthName = now.toLocaleString("en-US", { month: "long", year: "numeric" });
  let body = `Predictions for ${monthName}\n\nWhat do you think will happen this month in tech, science, or the world?\nReply with your predictions. We'll check back next month!`;
  if (last) body += `\n\nLast month's predictions: /c/${last.cid}`;

  console.log(`Posting predictions thread for ${monthName}`);
  await p("/c", { body, tags: "#predictions #bot" });
}

async function main() {
  for (const period of PERIODS) await digest(period);
  await monthlyPredictions();
}

main();
