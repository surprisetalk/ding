import {
  type Api,
  atomTitleLink,
  fetchTimeout,
  firstMatch as m,
  getPostedUrls,
  post,
  shuffle,
  slugTag,
  sweepFeeds,
} from "../bots.ts";

type Channel = { id: string; title: string };
type Item = { link: string; videoId: string; title: string; pubDate: Date; channelTitle: string };

const CHANNELS_PATH = new URL("./data/youtube_channels.txt", import.meta.url);
const FEED_URL = (id: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
const SAMPLE = 50;
const CONCURRENCY = 20;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_POSTS = 3;
const MAX_PROBES = 10;
const FRESHNESS_MS = 24 * 60 * 60 * 1000;
const UA = "Mozilla/5.0 ding-youtube-bot";

export default async (api: Api) => {
  const channelsText = await Deno.readTextFile(CHANNELS_PATH);
  const all: Channel[] = channelsText.split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, ...rest] = l.split("\t");
      return { id, title: rest.join("\t").trim() };
    })
    .filter((c) => c.id.startsWith("UC") && c.title);

  shuffle(all);
  const sample = all.slice(0, SAMPLE);
  console.log(`Sampling ${sample.length} of ${all.length} channels`);

  const parseEntries = (xml: string, ch: Channel): Item[] => {
    const out: Item[] = [];
    for (const c of xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || []) {
      const { title, link } = atomTitleLink(c);
      const videoId = m(/<yt:videoId>([^<]+)<\/yt:videoId>/, c) ||
        m(/[?&]v=([A-Za-z0-9_-]{6,})/, link);
      const pub = m(/<published>([\s\S]*?)<\/published>/, c) ||
        m(/<updated>([\s\S]*?)<\/updated>/, c);
      if (!title || !link || !videoId || !pub) continue;
      const d = new Date(pub);
      if (isNaN(+d)) continue;
      out.push({ link, videoId, title, pubDate: d, channelTitle: ch.title });
    }
    return out;
  };

  const fetchFeed = async (ch: Channel): Promise<Item[]> => {
    const res = await fetchTimeout(FEED_URL(ch.id), FETCH_TIMEOUT_MS, {
      "user-agent": UA,
      accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.5",
    });
    if (!res?.ok) return [];
    try {
      return parseEntries(await res.text(), ch); // a body that stalls mid-read skips this feed, not the sweep
    } catch {
      return [];
    }
  };

  // Real shorts return 200 at /shorts/{id}; regular videos return 303 to /watch?v=...
  const isShort = async (videoId: string): Promise<boolean> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
        method: "HEAD",
        redirect: "manual",
        signal: ac.signal,
        headers: { "user-agent": UA },
      });
      return res.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  };

  const cutoff = Date.now() - FRESHNESS_MS;
  const newestPerChannel = await sweepFeeds(sample, CONCURRENCY, fetchFeed, (i) => +i.pubDate, cutoff);
  console.log(`Found ${newestPerChannel.length} recent videos across sampled channels`);

  const posted = await getPostedUrls(api);
  const todo = newestPerChannel
    .filter((i) => !posted.has(i.link) && !i.link.includes("/shorts/"))
    .sort((a, b) => +b.pubDate - +a.pubDate);
  console.log(`${todo.length} items after dedup; posting up to ${MAX_POSTS}`);

  let posts = 0;
  let probes = 0;
  for (const it of todo) {
    if (posts >= MAX_POSTS || probes >= MAX_PROBES) break;
    probes++;
    if (await isShort(it.videoId)) {
      console.log(`Skipping short: ${it.title.slice(0, 60)}`);
      continue;
    }
    const thumb = `https://i.ytimg.com/vi/${it.videoId}/hqdefault.jpg`;
    const body = `${it.title}\n\n${thumb}\n\n${it.link}\n\nvia ${it.channelTitle}`;
    const channelTag = slugTag(it.channelTitle);
    const tags = `#youtube #video #bot${channelTag ? ` #${channelTag}` : ""}`;
    console.log(`Posting: ${body.slice(0, 80)}`);
    await post(api, body, tags);
    posts++;
  }
};
