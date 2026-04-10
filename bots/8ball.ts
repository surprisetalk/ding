// Magic 8-Ball bot for ding
// Responds to posts tagged #8ball with a classic 8-ball answer

const DING_API_URL = Deno.env.get("DING_API_URL") || "https://ding.bar";
const BOT_EMAIL = Deno.env.get("BOT_8BALL_EMAIL") || "";
const BOT_PASSWORD = Deno.env.get("BOT_8BALL_PASSWORD") || "";

const auth = btoa(`${BOT_EMAIL}:${BOT_PASSWORD}`);
const BOT_USERNAME = BOT_EMAIL.split("@")[0].replace(/-/g, "_");

const ANSWERS = [
  "It is certain.",
  "It is decidedly so.",
  "Without a doubt.",
  "Yes, definitely.",
  "You may rely on it.",
  "As I see it, yes.",
  "Most likely.",
  "Outlook good.",
  "Yes.",
  "Signs point to yes.",
  "Reply hazy, try again.",
  "Ask again later.",
  "Better not tell you now.",
  "Cannot predict now.",
  "Concentrate and ask again.",
  "Don't count on it.",
  "My reply is no.",
  "My sources say no.",
  "Outlook not so good.",
  "Very doubtful.",
];

// Deterministic answer based on CID (same question always gets same answer)
function answer(cid: number): string {
  return ANSWERS[cid % ANSWERS.length];
}

async function getAnsweredCids(): Promise<Set<number>> {
  const res = await fetch(
    `${DING_API_URL}/c?usr=${BOT_USERNAME}&comments=1&limit=50`,
    { headers: { Accept: "application/json", Authorization: `Basic ${auth}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch answered CIDs: HTTP ${res.status} ${await res.text()}`);
  const replies: { parent_cid: number }[] = await res.json();
  return new Set(replies.map((r) => r.parent_cid));
}

async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) {
    console.error("Missing BOT_8BALL_EMAIL or BOT_8BALL_PASSWORD");
    Deno.exit(1);
  }

  // Find posts tagged #8ball that the bot hasn't replied to yet
  const answeredCids = await getAnsweredCids();
  console.log(`Already answered ${answeredCids.size} questions`);

  const res = await fetch(`${DING_API_URL}/c?tag=8ball&sort=new&limit=20`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    console.error(`Failed to fetch #8ball posts: ${res.status}`);
    Deno.exit(1);
  }
  const posts: { cid: number; created_by: string; body: string }[] = await res.json();

  const unanswered = posts.filter(
    (p) => p.created_by !== BOT_USERNAME && !answeredCids.has(p.cid),
  );
  console.log(`Found ${unanswered.length} unanswered questions`);

  for (const post of unanswered.slice(0, 10)) {
    const reply = `🎱 ${answer(post.cid)}`;
    console.log(`Answering cid=${post.cid}: ${reply}`);

    const formData = new FormData();
    formData.append("body", reply);

    const r = await fetch(`${DING_API_URL}/c/${post.cid}`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      body: formData,
    });
    if (!r.ok) console.error(`Failed to reply to cid=${post.cid}: HTTP ${r.status}`);
  }
}

main();
