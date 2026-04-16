import { botInit, getAnsweredCids, getJson, reply } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("8BALL");

const ANSWERS = [
  "It is certain.", "It is decidedly so.", "Without a doubt.", "Yes, definitely.",
  "You may rely on it.", "As I see it, yes.", "Most likely.", "Outlook good.",
  "Yes.", "Signs point to yes.", "Reply hazy, try again.", "Ask again later.",
  "Better not tell you now.", "Cannot predict now.", "Concentrate and ask again.",
  "Don't count on it.", "My reply is no.", "My sources say no.",
  "Outlook not so good.", "Very doubtful.",
];

async function main() {
  const answered = await getAnsweredCids(auth, botUsername, apiUrl);
  console.log(`Already answered ${answered.size} questions`);

  const posts = await getJson<{ cid: number; created_by: string }[]>(
    `/c?tag=8ball&sort=new&limit=20`,
    auth,
    apiUrl,
  );
  const todo = posts.filter((p) => p.created_by !== botUsername && !answered.has(p.cid));
  console.log(`Found ${todo.length} unanswered questions`);

  for (const post of todo.slice(0, 10)) {
    const body = `🎱 ${ANSWERS[post.cid % ANSWERS.length]}`;
    console.log(`Answering cid=${post.cid}: ${body}`);
    await reply(auth, apiUrl, post.cid, body);
  }
}

main();
