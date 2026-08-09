import {
  type Api,
  extractArticle,
  extractImageUrl,
  firstLink,
  getAnsweredCids,
  MAX_AGE_MS,
  pickCandidates,
  reply,
} from "../bots.ts";

const MAX_CHARS = 3500;
const MIN_TEXT_LEN = 400;
const MIN_SENTENCES = 2;

const trimBoilerplate = (text: string) => {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const l = lines[i].trim();
    if (!l) {
      i++;
      continue;
    }
    if (l.length < 40 && !/[.!?]$/.test(l)) {
      i++;
      continue;
    }
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

export default async (api: Api) => {
  const answered = await getAnsweredCids(api, { since: Date.now() - MAX_AGE_MS });

  const candidates = await pickCandidates(api, answered, {
    minBodyLen: 0,
    excludeLinkPosts: false,
    extra: (p) => {
      const url = firstLink(p.body);
      if (!url || extractImageUrl(p.body)) return false;
      try {
        const h = new URL(url).hostname;
        return !/(^|\.)ding\.bar$/.test(h) && !/(^|\.)youtube\.com$/.test(h) && h !== "youtu.be";
      } catch {
        return false;
      }
    },
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
    await reply(api, p.cid, body);
    console.log(`Replied to cid=${p.cid} (${url})`);
  }
};
