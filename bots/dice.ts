// Dice roller bot for ding
// Responds to posts tagged #dice with roll results
// Supports: 2d6, 1d20+5, 4d6kh3, coin, pick X Y Z

const DING_API_URL = Deno.env.get("DING_API_URL") || "https://ding.bar";
const BOT_EMAIL = Deno.env.get("BOT_DICE_EMAIL") || "";
const BOT_PASSWORD = Deno.env.get("BOT_DICE_PASSWORD") || "";

const auth = btoa(`${BOT_EMAIL}:${BOT_PASSWORD}`);
const BOT_USERNAME = BOT_EMAIL.split("@")[0].replace(/-/g, "_");

function rollDice(n: number, sides: number): number[] {
  const rolls: number[] = [];
  for (let i = 0; i < n; i++) rolls.push(Math.floor(Math.random() * sides) + 1);
  return rolls;
}

function parseAndRoll(body: string): string | null {
  const lines: string[] = [];

  // Dice notation: NdS, NdS+M, NdSkh/klN
  const diceRe = /(\d+)d(\d+)(?:(kh|kl)(\d+))?(?:\s*([+-]\s*\d+))?/gi;
  let m;
  while ((m = diceRe.exec(body)) !== null) {
    const n = Math.min(+m[1], 100);
    const sides = Math.min(+m[2], 1000);
    if (n < 1 || sides < 1) continue;
    const keep = m[3]?.toLowerCase();
    const keepN = m[4] ? Math.min(+m[4], n) : n;
    const mod = m[5] ? parseInt(m[5].replace(/\s/g, "")) : 0;

    let rolls = rollDice(n, sides);
    let kept = rolls;
    let dropNote = "";
    if (keep === "kh") {
      kept = [...rolls].sort((a, b) => b - a).slice(0, keepN);
      dropNote = ` (kept highest ${keepN})`;
    } else if (keep === "kl") {
      kept = [...rolls].sort((a, b) => a - b).slice(0, keepN);
      dropNote = ` (kept lowest ${keepN})`;
    }

    const sum = kept.reduce((a, b) => a + b, 0) + mod;
    const modStr = mod > 0 ? ` + ${mod}` : mod < 0 ? ` - ${Math.abs(mod)}` : "";
    lines.push(
      `🎲 ${m[0]}: [${rolls.join(", ")}]${dropNote}${modStr} = ${sum}`,
    );
  }

  // Coin flip
  if (/\bcoin\b/i.test(body)) {
    lines.push(`🪙 ${Math.random() < 0.5 ? "Heads" : "Tails"}`);
  }

  // Pick from options: "pick X, Y, Z" or "pick X Y Z"
  const pickMatch = body.match(/\bpick\s+(.+)/i);
  if (pickMatch) {
    const options = pickMatch[1].split(/[,|]/).map((s) => s.trim()).filter(Boolean);
    if (options.length >= 2) {
      const choice = options[Math.floor(Math.random() * options.length)];
      lines.push(`🎯 ${choice}`);
    }
  }

  return lines.length ? lines.join("\n") : null;
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
    console.error("Missing BOT_DICE_EMAIL or BOT_DICE_PASSWORD");
    Deno.exit(1);
  }

  const answeredCids = await getAnsweredCids();
  console.log(`Already answered ${answeredCids.size} posts`);

  const res = await fetch(`${DING_API_URL}/c?tag=dice&sort=new&limit=20`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    console.error(`Failed to fetch #dice posts: ${res.status}`);
    Deno.exit(1);
  }
  const posts: { cid: number; created_by: string; body: string }[] = await res.json();

  const unanswered = posts.filter(
    (p) => p.created_by !== BOT_USERNAME && !answeredCids.has(p.cid),
  );
  console.log(`Found ${unanswered.length} unanswered dice posts`);

  for (const post of unanswered.slice(0, 10)) {
    const result = parseAndRoll(post.body);
    if (!result) {
      console.log(`No dice notation in cid=${post.cid}, skipping`);
      continue;
    }
    console.log(`Rolling for cid=${post.cid}`);

    const formData = new FormData();
    formData.append("body", result);

    const r = await fetch(`${DING_API_URL}/c/${post.cid}`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      body: formData,
    });
    if (!r.ok) console.error(`Failed to reply to cid=${post.cid}: HTTP ${r.status}`);
  }
}

main();
