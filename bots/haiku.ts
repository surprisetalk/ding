import { botInit, getAnsweredCids, reply, countSyllables } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("HAIKU");

function cleanText(body: string): string {
  return body.replace(/https?:\/\/\S+/g, "").replace(/@\S+/g, "").trim();
}

function findHaiku(text: string): [string, string, string] | null {
  const words = text.split(/\s+/).filter(Boolean);
  const target = [5, 7, 5];
  const lines: string[][] = [[], [], []];
  let lineIdx = 0;
  let syllables = 0;

  for (const word of words) {
    if (lineIdx > 2) return null;
    syllables += countSyllables(word);
    lines[lineIdx].push(word);
    if (syllables === target[lineIdx]) {
      lineIdx++;
      syllables = 0;
    } else if (syllables > target[lineIdx]) {
      return null;
    }
  }

  if (lineIdx !== 3) return null;
  return [lines[0].join(" "), lines[1].join(" "), lines[2].join(" ")];
}

async function main() {
  const answeredCids = await getAnsweredCids(auth, botUsername, apiUrl);
  console.log(`Already answered ${answeredCids.size} posts`);

  const res = await fetch(`${apiUrl}/c?sort=new&limit=50`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    console.error(`Failed to fetch posts: ${res.status}`);
    Deno.exit(1);
  }
  const posts: { cid: number; created_by: string; body: string }[] = await res.json();

  let replies = 0;
  for (const post of posts) {
    if (replies >= 3) break;
    if (post.created_by.startsWith("bot_")) continue;
    if (answeredCids.has(post.cid)) continue;

    const cleaned = cleanText(post.body);
    const haiku = findHaiku(cleaned);
    if (!haiku) continue;

    const body = `a haiku, perhaps?\n\n${haiku[0]}\n${haiku[1]}\n${haiku[2]}`;
    console.log(`Replying to cid=${post.cid}: ${haiku.join(" / ")}`);
    if (await reply(auth, apiUrl, post.cid, body)) replies++;
  }

  console.log(`Replied to ${replies} posts`);
}

main();
