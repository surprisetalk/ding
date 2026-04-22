import { botInit, firstMatch as m, getPostedUrls, post } from "../bots.ts";

type Channel = { id: string; title: string };
type Item = { link: string; title: string; pubDate: Date; channelTitle: string };

const CHANNELS_PATH = new URL("./data/youtube_channels.txt", import.meta.url);
const FEED_URL = (id: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
const SAMPLE = 50;
const CONCURRENCY = 20;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_POSTS = 3;
const FRESHNESS_MS = 72 * 60 * 60 * 1000;
const UA = "Mozilla/5.0 ding-youtube-bot";

const { apiUrl, auth, botUsername } = botInit("YOUTUBE");

const channelsText = await Deno.readTextFile(CHANNELS_PATH);
const all: Channel[] = channelsText.split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const [id, ...rest] = l.split("\t");
    return { id, title: rest.join("\t").trim() };
  })
  .filter((c) => c.id.startsWith("UC") && c.title);

for (let i = all.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [all[i], all[j]] = [all[j], all[i]];
}
const sample = all.slice(0, SAMPLE);
console.log(`Sampling ${sample.length} of ${all.length} channels`);

const parseEntries = (xml: string, ch: Channel): Item[] => {
  const out: Item[] = [];
  for (const c of xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || []) {
    const title = (m(/<title[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/title>/, c) ||
      m(/<title[^>]*>([\s\S]*?)<\/title>/, c)).trim();
    const linkAttrs = [...c.matchAll(/<link\s+([^>]*?)\/?>/g)].map((x) => x[1])
      .find((a) => !/rel=["']self["']/i.test(a) && /href=/.test(a)) ?? "";
    const link = m(/href=["']([^"']+)["']/, linkAttrs);
    const pub = m(/<published>([\s\S]*?)<\/published>/, c) ||
      m(/<updated>([\s\S]*?)<\/updated>/, c);
    if (!title || !link || !pub) continue;
    const d = new Date(pub);
    if (isNaN(+d)) continue;
    out.push({ link, title, pubDate: d, channelTitle: ch.title });
  }
  return out;
};

const fetchFeed = async (ch: Channel): Promise<Item[]> => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(FEED_URL(ch.id), {
      signal: ac.signal,
      headers: {
        "user-agent": UA,
        accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.5",
      },
      redirect: "follow",
    });
    if (!res.ok) return [];
    return parseEntries(await res.text(), ch);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
};

const cutoff = Date.now() - FRESHNESS_MS;
let idx = 0;
const newestPerChannel: Item[] = [];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (idx < sample.length) {
      const items = await fetchFeed(sample[idx++]);
      const recent = items.filter((i) => +i.pubDate > cutoff);
      recent.sort((a, b) => +b.pubDate - +a.pubDate);
      if (recent[0]) newestPerChannel.push(recent[0]);
    }
  }),
);
console.log(`Found ${newestPerChannel.length} recent videos across sampled channels`);

const posted = await getPostedUrls(auth, apiUrl, botUsername);
const todo = newestPerChannel
  .filter((i) => !posted.has(i.link))
  .sort((a, b) => +b.pubDate - +a.pubDate);
console.log(`${todo.length} items after dedup; posting up to ${MAX_POSTS}`);

for (const it of todo.slice(0, MAX_POSTS)) {
  const body = `${it.title}\n\n${it.link}\n\nvia ${it.channelTitle}`;
  console.log(`Posting: ${body.slice(0, 80)}`);
  await post(auth, apiUrl, body, "#youtube #video #bot");
}
