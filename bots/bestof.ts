// BestOf bot for ding
// Weekly digest of popular content + monthly prediction threads

const DING_API_URL = Deno.env.get("DING_API_URL") || "https://ding.bar";
const BOT_EMAIL = Deno.env.get("BOT_BESTOF_EMAIL") || "";
const BOT_PASSWORD = Deno.env.get("BOT_BESTOF_PASSWORD") || "";

const auth = btoa(`${BOT_EMAIL}:${BOT_PASSWORD}`);
const BOT_USERNAME = BOT_EMAIL.split("@")[0].replace(/-/g, "_");

async function getBotPosts(tag?: string, limit = 10): Promise<any[]> {
  const url = `${DING_API_URL}/c?usr=${BOT_USERNAME}${tag ? `&tag=${tag}` : ""}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch bot posts: HTTP ${res.status} ${await res.text()}`);
  return await res.json();
}

async function post(body: string, tags: string): Promise<boolean> {
  const formData = new FormData();
  formData.append("body", body);
  formData.append("tags", tags);

  const res = await fetch(`${DING_API_URL}/c`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: formData,
  });
  if (!res.ok) {
    console.error(`Failed to post: HTTP ${res.status}`);
    return false;
  }
  return true;
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

async function weeklyDigest() {
  const posts = await getBotPosts("bestof", 5);
  const lastPost = posts[0];
  const lastAge = lastPost ? Date.now() - new Date(lastPost.created_at).getTime() : Infinity;

  if (lastAge < 6 * 24 * 3_600_000) {
    console.log(`Last bestof was ${(lastAge / 86_400_000).toFixed(1)} days ago, skipping`);
    return;
  }

  // Fetch top posts from the past week
  const res = await fetch(`${DING_API_URL}/c?sort=top&limit=25`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    console.error(`Failed to fetch top posts: ${res.status}`);
    return;
  }
  const allPosts: any[] = await res.json();

  const weekAgo = Date.now() - 7 * 24 * 3_600_000;
  const recentTop = allPosts.filter(
    (p: any) => new Date(p.created_at).getTime() > weekAgo,
  );

  if (recentTop.length < 3) {
    console.log("Not enough top posts this week, skipping digest");
    return;
  }

  const now = new Date();
  const weekOf = `${now.toLocaleString("en-US", { month: "short" })} ${now.getDate()}`;

  const items = recentTop.slice(0, 10).map((p: any, i: number) => {
    const title = p.body.trim().split("\n")[0].slice(0, 80);
    const reactions = p.reaction_count || 0;
    return `${i + 1}. ${title} (${reactions} ▲) — /c/${p.cid}`;
  });

  const body = `Weekly BestOf — week of ${weekOf}\n\n${items.join("\n")}\n\n${recentTop.length > 10 ? `...and ${recentTop.length - 10} more popular posts this week.` : ""}`;

  console.log("Posting weekly digest");
  if (!await post(body, "#bestof #bot")) {
    console.error("Failed to post weekly digest");
    Deno.exit(1);
  }
}

async function monthlyPredictions() {
  const now = new Date();
  if (now.getDate() > 3) return; // Only run in first 3 days of month

  const posts = await getBotPosts("predictions", 5);
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Check if we already posted this month's prediction thread
  const hasCurrentMonth = posts.some((p: any) => {
    const d = new Date(p.created_at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` === currentMonth;
  });

  if (hasCurrentMonth) {
    console.log("Already posted predictions for this month");
    return;
  }

  // Follow up on last month's predictions
  const lastPrediction = posts[0];
  if (lastPrediction) {
    const lastMonth = new Date(lastPrediction.created_at);
    const isLastMonth = lastMonth.getMonth() === (now.getMonth() - 1 + 12) % 12;
    if (isLastMonth) {
      console.log(`Following up on last month's predictions (cid=${lastPrediction.cid})`);
      if (!await reply(
        lastPrediction.cid,
        `Time's up! How did we do?\n\nReply to your original prediction with how it turned out.`,
      )) console.error(`Failed to follow up on cid=${lastPrediction.cid}`);
    }
  }

  // Post new prediction thread
  const monthName = now.toLocaleString("en-US", { month: "long", year: "numeric" });
  let body = `Predictions for ${monthName}\n\nWhat do you think will happen this month in tech, science, or the world?\nReply with your predictions. We'll check back next month!`;
  if (lastPrediction) {
    body += `\n\nLast month's predictions: /c/${lastPrediction.cid}`;
  }

  console.log(`Posting predictions thread for ${monthName}`);
  if (!await post(body, "#predictions #bot")) {
    console.error("Failed to post predictions thread");
    Deno.exit(1);
  }
}

async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) {
    console.error("Missing BOT_BESTOF_EMAIL or BOT_BESTOF_PASSWORD");
    Deno.exit(1);
  }

  await weeklyDigest();
  await monthlyPredictions();
}

main();
