import { botInit, extractArticle, extractImageUrl, firstLink, getAnsweredCids, reply } from "../bots.ts";

const MAX_CHARS = 1500;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("READER");
  const answered = await getAnsweredCids(auth, botUsername, apiUrl);

  const [top, comments] = await Promise.all([
    fetch(`${apiUrl}/c?sort=new&limit=50`, {
      headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
    }).then((r) => r.ok ? r.json() : []),
    fetch(`${apiUrl}/c?sort=new&comments=1&limit=50`, {
      headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
    }).then((r) => r.ok ? r.json() : []),
  ]);
  const seen = new Set<number>();
  const posts: { cid: number; body: string; created_by: string }[] = [...top, ...comments]
    .filter((p: { cid: number }) => !seen.has(p.cid) && seen.add(p.cid));

  const candidates = posts.filter((p) => {
    if (p.created_by === botUsername || answered.has(p.cid)) return false;
    const url = firstLink(p.body);
    if (!url) return false;
    if (extractImageUrl(p.body)) return false;
    return true;
  });

  console.log(`Found ${candidates.length} link candidates`);
  for (const p of candidates) {
    const url = firstLink(p.body)!;
    const article = await extractArticle(url).catch((e) => {
      console.error(`extract failed for ${url}: ${e.message}`);
      return null;
    });
    if (!article) continue;
    const text = article.text.length > MAX_CHARS
      ? article.text.slice(0, MAX_CHARS).trimEnd() + "…"
      : article.text;
    const raw = article.title ? `**${article.title}**\n\n${text}` : text;
    const body = raw.split("\n").map((l) => `> ${l}`).join("\n");
    await reply(auth, apiUrl, p.cid, body);
    console.log(`Replied to cid=${p.cid} (${url})`);
  }
}

main();
