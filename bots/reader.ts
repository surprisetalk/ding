import { botInit, extractArticle, extractImageUrl, firstLink, getAnsweredCids, getJson, reply } from "../bots.ts";

const MAX_CHARS = 3500;
const MIN_TEXT_LEN = 400;
const MIN_SENTENCES = 2;

const trimBoilerplate = (text: string) => {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const l = lines[i].trim();
    if (!l) { i++; continue; }
    if (l.length < 40 && !/[.!?]$/.test(l)) { i++; continue; }
    break;
  }
  return lines.slice(i).join("\n").trimStart();
};

const smartTruncate = (text: string, max: number) => {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const para = slice.lastIndexOf("\n\n");
  if (para > max * 0.5) return text.slice(0, para).trimEnd() + "\n\n…";
  const sent = slice.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (sent && sent[0].length > max * 0.5) return sent[0].trimEnd() + " …";
  return slice.replace(/\s+\S*$/, "").trimEnd() + "…";
};

async function main() {
  const { apiUrl, auth, botUsername } = botInit("READER");
  const answered = await getAnsweredCids(auth, botUsername, apiUrl);

  type PostLite = { cid: number; body: string; created_by: string };
  const [top, comments] = await Promise.all([
    getJson<PostLite[]>(`/c?sort=new&limit=50`, auth, apiUrl).catch(() => [] as PostLite[]),
    getJson<PostLite[]>(`/c?sort=new&comments=1&limit=50`, auth, apiUrl).catch(() => [] as PostLite[]),
  ]);
  const seen = new Set<number>();
  const posts = [...top, ...comments]
    .filter((p) => !seen.has(p.cid) && !!seen.add(p.cid));

  const candidates = posts.filter((p) => {
    if (p.created_by === botUsername || answered.has(p.cid)) return false;
    const url = firstLink(p.body);
    if (!url) return false;
    try {
      const h = new URL(url).hostname;
      if (h === "ding.bar" || h.endsWith(".ding.bar")) return false;
      if (h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be") return false;
    } catch {
      return false;
    }
    if (extractImageUrl(p.body)) return false;
    return true;
  });

  console.log(`Found ${candidates.length} link candidates`);
  for (const p of candidates) {
    const url = firstLink(p.body)!;
    const article = await extractArticle(url).catch((e) => {
      console.error(`extract failed for cid=${p.cid} ${url}: ${e.message}`);
      return null;
    });
    if (!article) continue;

    const text = trimBoilerplate(article.text);
    if (text.length < MIN_TEXT_LEN) {
      console.error(`skip cid=${p.cid} ${url}: text too short (${text.length} chars, likely paywall or JS-only)`);
      continue;
    }
    const sentences = (text.match(/[.!?](\s|$)/g) || []).length;
    if (sentences < MIN_SENTENCES) {
      console.error(`skip cid=${p.cid} ${url}: too few sentences (${sentences}, likely nav dump)`);
      continue;
    }

    const truncated = smartTruncate(text, MAX_CHARS);
    const header = article.title ? `# [${article.title}](${url})\n\n` : `[${url}](${url})\n\n`;
    const body = (header + truncated).split("\n").map((l) => l ? `> ${l}` : ">").join("\n");
    await reply(auth, apiUrl, p.cid, body);
    console.log(`Replied to cid=${p.cid} (${url})`);
  }
}

main();
