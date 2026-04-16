import { botInit, claude, getAnsweredCids, getJson, reply } from "../bots.ts";

const SYSTEM = "Summarize the post in 1–2 short sentences. " +
  "No preamble, no 'TLDR:' prefix, no sign-off, no hashtags.";

const MIN_BODY_LEN = 600;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("TLDR");
  const answered = await getAnsweredCids(auth, botUsername, apiUrl);

  type PostLite = { cid: number; body: string; created_by: string };
  const [top, comments] = await Promise.all([
    getJson<PostLite[]>(`/c?sort=new&limit=50`, auth, apiUrl).catch(() => [] as PostLite[]),
    getJson<PostLite[]>(`/c?sort=new&comments=1&limit=50`, auth, apiUrl).catch(() => [] as PostLite[]),
  ]);
  const seen = new Set<number>();
  const posts = [...top, ...comments]
    .filter((p) => !seen.has(p.cid) && !!seen.add(p.cid));

  const candidates = posts.filter((p) =>
    p.created_by !== botUsername && !answered.has(p.cid) &&
    p.body.replace(/https?:\S+/g, "").trim().length >= MIN_BODY_LEN
  );

  console.log(`Found ${candidates.length} long-body candidates`);
  for (const p of candidates) {
    const text = await claude(p.body, { system: SYSTEM, maxTokens: 150, temperature: 0.3 });
    await reply(auth, apiUrl, p.cid, `tl;dr: ${text}`);
    console.log(`Replied to cid=${p.cid}: ${text.slice(0, 60)}...`);
  }
}

main();
