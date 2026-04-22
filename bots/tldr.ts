import { botInit, claude, getAnsweredCids, getJson, reply } from "../bots.ts";

const SYSTEM = "Summarize in 1 short sentence (max 200 chars). " +
  "No preamble, no 'TLDR:' prefix, no sign-off, no hashtags, no quotes.";

const MIN_BODY_LEN = 600;
const MAX_OUTPUT_CHARS = 240;

const isQuoteHeavy = (body: string) => {
  const lines = body.split("\n").filter((l) => l.trim());
  if (lines.length < 3) return false;
  const q = lines.filter((l) => l.trimStart().startsWith(">")).length;
  return q / lines.length >= 0.6;
};

const cleanOutput = (s: string) => {
  let t = s.trim().replace(/\s+/g, " ");
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  t = t.replace(/^(tl;?dr:?\s*|summary:?\s*)/i, "").trim();
  if (t.length <= MAX_OUTPUT_CHARS) return t;
  const cut = t.slice(0, MAX_OUTPUT_CHARS);
  const sent = cut.match(/^.*[.!?](?=\s|$)/);
  return (sent ? sent[0] : cut.replace(/\s+\S*$/, "")).trim() + "…";
};

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
    p.body.replace(/https?:\S+/g, "").trim().length >= MIN_BODY_LEN &&
    !isQuoteHeavy(p.body)
  );

  console.log(`Found ${candidates.length} long-body candidates`);
  for (const p of candidates) {
    const raw = await claude(p.body, { system: SYSTEM, maxTokens: 120, temperature: 0.3 });
    const text = cleanOutput(raw);
    if (text.length < 20) {
      console.error(`skip cid=${p.cid}: output too short (${text.length} chars): ${JSON.stringify(raw)}`);
      continue;
    }
    if (p.body.includes(text)) {
      console.error(`skip cid=${p.cid}: output is substring of original body`);
      continue;
    }
    await reply(auth, apiUrl, p.cid, `tl;dr: ${text}`);
    console.log(`Replied to cid=${p.cid}: ${text.slice(0, 60)}...`);
  }
}

main();
