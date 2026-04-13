// BestOf bot for ding
// Daily/weekly/monthly/yearly digests + monthly prediction threads

const DING_API_URL = Deno.env.get("DING_API_URL") || "https://ding.bar";
const BOT_EMAIL = Deno.env.get("BOT_BESTOF_EMAIL") || "";
const BOT_PASSWORD = Deno.env.get("BOT_BESTOF_PASSWORD") || "";

const auth = btoa(`${BOT_EMAIL}:${BOT_PASSWORD}`);
const BOT_USERNAME = BOT_EMAIL.split("@")[0].replace(/-/g, "_");

type Post = {
  cid: number;
  body: string;
  created_by: string;
  created_at: string;
  reaction_count: number;
  tags: string[];
};

const DAY = 86_400_000;

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${DING_API_URL}${path}`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function postForm(path: string, fields: Record<string, string>): Promise<void> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const res = await fetch(`${DING_API_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body,
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
}

const isBotUser = (name: string) => /^bot[-_]/.test(name);

async function fetchRecent(windowMs: number, maxPages: number): Promise<Post[]> {
  const cutoff = Date.now() - windowMs;
  const out: Post[] = [];
  for (let p = 0; p < maxPages; p++) {
    const page: Post[] = await getJson(`/c?sort=new&limit=100&p=${p}`);
    if (page.length === 0) return out;
    for (const item of page) {
      if (new Date(item.created_at).getTime() < cutoff) return out;
      out.push(item);
    }
    if (page.length < 100) return out;
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
  {
    tag: "daily",
    windowMs: DAY,
    minGapMs: 20 * 3_600_000,
    maxPages: 2,
    label: (d) => d.toLocaleString("en-US", { month: "short", day: "numeric" }),
  },
  {
    tag: "weekly",
    windowMs: 7 * DAY,
    minGapMs: 6 * DAY,
    maxPages: 5,
    label: (d) => `week of ${d.toLocaleString("en-US", { month: "short", day: "numeric" })}`,
  },
  {
    tag: "monthly",
    windowMs: 30 * DAY,
    minGapMs: 28 * DAY,
    maxPages: 15,
    label: (d) => d.toLocaleString("en-US", { month: "long", year: "numeric" }),
  },
  {
    tag: "yearly",
    windowMs: 365 * DAY,
    minGapMs: 360 * DAY,
    maxPages: 50,
    label: (d) => String(d.getFullYear()),
  },
];

const EXCLUDED_TAGS = new Set(["bot", "bestof", "daily", "weekly", "monthly", "yearly"]);

function topBy(
  posts: Post[],
  key: (p: Post) => string[],
  filter: (v: string) => boolean = () => true,
  n = 10,
) {
  const agg = new Map<string, { reactions: number; count: number }>();
  for (const p of posts) {
    for (const v of key(p)) {
      if (!filter(v)) continue;
      const a = agg.get(v) || { reactions: 0, count: 0 };
      a.reactions += p.reaction_count;
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
  const prior: Post[] = await getJson(`/c?usr=${BOT_USERNAME}&tag=${period.tag}&limit=1`);
  const lastAge = prior[0] ? Date.now() - new Date(prior[0].created_at).getTime() : Infinity;
  if (lastAge < period.minGapMs) {
    console.log(`[${period.tag}] last was ${(lastAge / DAY).toFixed(1)}d ago, skipping`);
    return;
  }

  const posts = (await fetchRecent(period.windowMs, period.maxPages))
    .filter((p) => !isBotUser(p.created_by));

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
  await postForm("/c", { body, tags: `#bestof #bot #${period.tag}` });
}

async function monthlyPredictions() {
  const now = new Date();
  if (now.getDate() > 3) return;

  const posts: Post[] = await getJson(`/c?usr=${BOT_USERNAME}&tag=predictions&limit=5`);
  const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const currentMonth = ym(now);

  if (posts.some((p) => ym(new Date(p.created_at)) === currentMonth)) {
    console.log("Already posted predictions for this month");
    return;
  }

  const lastPrediction = posts[0];
  if (lastPrediction) {
    const lastMonth = new Date(lastPrediction.created_at);
    const isLastMonth = lastMonth.getMonth() === (now.getMonth() - 1 + 12) % 12;
    if (isLastMonth) {
      console.log(`Following up on last month's predictions (cid=${lastPrediction.cid})`);
      await postForm(`/c/${lastPrediction.cid}`, {
        body: `Time's up! How did we do?\n\nReply to your original prediction with how it turned out.`,
      });
    }
  }

  const monthName = now.toLocaleString("en-US", { month: "long", year: "numeric" });
  let body = `Predictions for ${monthName}\n\nWhat do you think will happen this month in tech, science, or the world?\nReply with your predictions. We'll check back next month!`;
  if (lastPrediction) body += `\n\nLast month's predictions: /c/${lastPrediction.cid}`;

  console.log(`Posting predictions thread for ${monthName}`);
  await postForm("/c", { body, tags: "#predictions #bot" });
}

async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) throw new Error("Missing BOT_BESTOF_EMAIL or BOT_BESTOF_PASSWORD");
  for (const period of PERIODS) await digest(period);
  await monthlyPredictions();
}

main();
