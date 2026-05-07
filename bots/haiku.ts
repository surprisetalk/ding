import { botInit, countSyllables, getAnsweredCids, getJson, isFresh, MAX_AGE_MS, reply } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("HAIKU");

const clean = (b: string) => b.replace(/https?:\/\/\S+/g, "").replace(/@\S+/g, "").trim();

function findHaiku(text: string): [string, string, string] | null {
  const words = text.split(/\s+/).filter(Boolean);
  const target = [5, 7, 5];
  const lines: string[][] = [[], [], []];
  let lineIdx = 0, syllables = 0;

  for (const word of words) {
    if (lineIdx > 2) return null;
    syllables += countSyllables(word);
    lines[lineIdx].push(word);
    if (syllables === target[lineIdx]) {
      lineIdx++;
      syllables = 0;
    } else if (syllables > target[lineIdx]) { return null; }
  }

  if (lineIdx !== 3) return null;
  return [lines[0].join(" "), lines[1].join(" "), lines[2].join(" ")];
}

async function main() {
  const answered = await getAnsweredCids(auth, botUsername, apiUrl, { since: Date.now() - MAX_AGE_MS });
  console.log(`Already answered ${answered.size} posts in last 4h`);

  const posts = await getJson<{ cid: number; created_by: string; body: string; created_at: string }[]>(
    `/c?sort=new&limit=50`,
    auth,
    apiUrl,
  );

  let replies = 0;
  for (const post of posts) {
    if (replies >= 3) break;
    if (post.created_by.startsWith("bot_") || answered.has(post.cid) || !isFresh(post.created_at)) continue;
    const haiku = findHaiku(clean(post.body));
    if (!haiku) continue;
    const body = `a haiku, perhaps?\n\n${haiku[0]}\n${haiku[1]}\n${haiku[2]}`;
    console.log(`Replying to cid=${post.cid}: ${haiku.join(" / ")}`);
    if (await reply(auth, apiUrl, post.cid, body)) replies++;
  }

  console.log(`Replied to ${replies} posts`);
}

main();
