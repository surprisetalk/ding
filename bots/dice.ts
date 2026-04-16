// Dice roller bot — responds to posts tagged #dice. Supports NdS, NdSkhX, coin, pick X Y Z.

import { botInit, getAnsweredCids, getJson, reply } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("DICE");

const rollDice = (n: number, sides: number) => Array.from({ length: n }, () => Math.floor(Math.random() * sides) + 1);

function parseAndRoll(body: string): string | null {
  const lines: string[] = [];
  const diceRe = /(\d+)d(\d+)(?:(kh|kl)(\d+))?(?:\s*([+-]\s*\d+))?/gi;
  let m;
  while ((m = diceRe.exec(body)) !== null) {
    const n = Math.min(+m[1], 100);
    const sides = Math.min(+m[2], 1000);
    if (n < 1 || sides < 1) continue;
    const keep = m[3]?.toLowerCase();
    const keepN = m[4] ? Math.min(+m[4], n) : n;
    const mod = m[5] ? parseInt(m[5].replace(/\s/g, "")) : 0;

    const rolls = rollDice(n, sides);
    let kept = rolls, dropNote = "";
    if (keep === "kh") {
      kept = [...rolls].sort((a, b) => b - a).slice(0, keepN);
      dropNote = ` (kept highest ${keepN})`;
    } else if (keep === "kl") {
      kept = [...rolls].sort((a, b) => a - b).slice(0, keepN);
      dropNote = ` (kept lowest ${keepN})`;
    }

    const sum = kept.reduce((a, b) => a + b, 0) + mod;
    const modStr = mod > 0 ? ` + ${mod}` : mod < 0 ? ` - ${Math.abs(mod)}` : "";
    lines.push(`🎲 ${m[0]}: [${rolls.join(", ")}]${dropNote}${modStr} = ${sum}`);
  }

  if (/\bcoin\b/i.test(body)) lines.push(`🪙 ${Math.random() < 0.5 ? "Heads" : "Tails"}`);

  const pick = body.match(/\bpick\s+(.+)/i);
  if (pick) {
    const opts = pick[1].split(/[,|]/).map((s) => s.trim()).filter(Boolean);
    if (opts.length >= 2) lines.push(`🎯 ${opts[Math.floor(Math.random() * opts.length)]}`);
  }

  return lines.length ? lines.join("\n") : null;
}

async function main() {
  const answered = await getAnsweredCids(auth, botUsername, apiUrl);
  console.log(`Already answered ${answered.size} posts`);

  const posts = await getJson<{ cid: number; created_by: string; body: string }[]>(
    `/c?tag=dice&sort=new&limit=20`,
    auth,
    apiUrl,
  );
  const todo = posts.filter((p) => p.created_by !== botUsername && !answered.has(p.cid));
  console.log(`Found ${todo.length} unanswered dice posts`);

  for (const post of todo.slice(0, 10)) {
    const result = parseAndRoll(post.body);
    if (!result) {
      console.log(`No dice notation in cid=${post.cid}, skipping`);
      continue;
    }
    console.log(`Rolling for cid=${post.cid}`);
    await reply(auth, apiUrl, post.cid, result);
  }
}

main();
