import { botInit, claude, getAnsweredCids, getJson, isLinkPost, reply } from "../bots.ts";

const SYSTEM = "You are a discerning quality critic for a small social feed. " +
  'For each post, rate it: "up" if it\'s genuinely interesting, funny, thoughtful, or well-crafted; ' +
  '"down" if it\'s spammy, mean-spirited, lazy, or incoherent; ' +
  '"skip" if it\'s neutral/unremarkable. ' +
  'Most posts should be "skip" — be stingy with both up and down. ' +
  "Return ONLY a JSON array, no prose, no markdown fences: " +
  '[{"cid":123,"verdict":"up"},{"cid":124,"verdict":"skip"}]';

const MAX_RATE_PER_RUN = 10;

type Post = { cid: number; created_by: string; body: string };

async function main() {
  const { apiUrl, auth, botUsername } = botInit("CRITIC");
  const answered = await getAnsweredCids(auth, botUsername, apiUrl);

  const [topLevel, comments] = await Promise.all([
    getJson<Post[]>(`/c?sort=new&limit=40`, auth, apiUrl),
    getJson<Post[]>(`/c?sort=new&comments=1&limit=40`, auth, apiUrl),
  ]);

  const seen = new Set<number>();
  const all = [...topLevel, ...comments].filter((p) => {
    if (seen.has(p.cid)) return false;
    seen.add(p.cid);
    return true;
  });

  const candidates = all.filter((p) =>
    p.created_by !== botUsername &&
    !answered.has(p.cid) &&
    p.body.length > 1 &&
    p.body.replace(/https?:\S+/g, "").trim().length >= 20 &&
    !isLinkPost(p.body)
  ).slice(0, MAX_RATE_PER_RUN);

  console.log(`Rating ${candidates.length} candidates`);
  if (!candidates.length) return;

  const prompt = candidates.map((p) => `cid=${p.cid}\n${p.body.slice(0, 500)}\n---`).join("\n");

  const raw = await claude(prompt, { system: SYSTEM, temperature: 0.3, maxTokens: 600 });
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Critic returned non-JSON: ${raw}`);
  const verdicts: { cid: number; verdict: "up" | "down" | "skip" }[] = JSON.parse(match[0]);

  for (const v of verdicts) {
    if (v.verdict === "skip") continue;
    const symbol = v.verdict === "up" ? "▲" : "▼";
    await reply(auth, apiUrl, v.cid, symbol);
    console.log(`Voted ${symbol} on cid=${v.cid}`);
  }
}

main();
