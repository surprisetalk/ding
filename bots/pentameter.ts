import { botInit, getAnsweredCids, reply, countSyllablesInLine, guessStress } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("PENTAMETER");

function cleanText(body: string): string {
  return body.replace(/https?:\/\/\S+/g, "").replace(/@\S+/g, "").trim();
}

function isIambicPentameter(text: string): boolean {
  const syllables = countSyllablesInLine(text);
  if (syllables < 9 || syllables > 11) return false;

  const stress = guessStress(text);
  if (stress.length < 10) return false;

  const ideal = "0101010101";
  let correct = 0;
  for (let i = 0; i < 10; i++) {
    if (stress[i] === ideal[i]) correct++;
  }
  return correct >= 7;
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
    if (!isIambicPentameter(cleaned)) continue;

    const body = `methinks this be iambic pentameter!\n\n"${cleaned}"\n\nda-DUM da-DUM da-DUM da-DUM da-DUM`;
    console.log(`Replying to cid=${post.cid}: "${cleaned}"`);
    if (await reply(auth, apiUrl, post.cid, body)) replies++;
  }

  console.log(`Replied to ${replies} posts`);
}

main();
