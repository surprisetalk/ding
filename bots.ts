// Shared bot infrastructure for ding bots

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

// ---- Bot init ----

// Every request a bot makes goes through `fetch` here. Standalone runs get the real
// global fetch; the in-server Deno.cron passes `app.request`, which dispatches in-process
// (Deno Deploy forbids a deployment fetching its own origin — see server.tsx's cron).
export type Api = {
  apiUrl: string;
  auth: string;
  botUsername: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
};

export function botInit(envPrefix: string): Api {
  const apiUrl = Deno.env.get("DING_API_URL") || "https://ding.bar";
  const email = Deno.env.get(`BOT_${envPrefix}_EMAIL`) || "";
  const password = Deno.env.get(`BOT_${envPrefix}_PASSWORD`) || "";
  if (!email || !password) {
    console.error(`Missing BOT_${envPrefix}_EMAIL or BOT_${envPrefix}_PASSWORD`);
    Deno.exit(1);
  }
  return {
    apiUrl,
    auth: btoa(`${email}:${password}`),
    botUsername: email.split("@")[0].replace(/-/g, "_"),
    fetch: (input, init) => fetch(input, init),
  };
}

// ---- Freshness cutoff ----
// Hard 4h limit on candidate content age. Defence-in-depth so a broken dedup
// helper can only re-process up to 4h of content before the cutoff stops it.

export const MAX_AGE_MS = 4 * 60 * 60 * 1000;
export const isFresh = (ts: string | number | Date, max = MAX_AGE_MS) => {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) throw new Error(`isFresh: invalid timestamp ${ts}`);
  return Date.now() - t < max;
};

// ---- HTTP helpers ----

export async function getJson<T = unknown>(api: Api, path: string): Promise<T> {
  const res = await api.fetch(`${api.apiUrl}${path}`, {
    headers: { Accept: "application/json", Authorization: `Basic ${api.auth}` },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function paginate<T>(
  api: Api,
  pathFor: (p: number) => string,
  opts: { until?: (item: T) => boolean; pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 50;
  const out: T[] = [];
  for (let p = 0; p < maxPages; p++) {
    const items = await getJson<T[]>(api, pathFor(p));
    if (!items.length) return out;
    for (const it of items) {
      if (opts.until?.(it)) return out;
      out.push(it);
    }
    if (items.length < pageSize) return out;
  }
  throw new Error(`paginate: hit maxPages=${maxPages} for ${pathFor(0)}`);
}

export async function postForm(
  api: Api,
  path: string,
  fields: Record<string, string>,
): Promise<boolean> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const res = await api.fetch(`${api.apiUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Basic ${api.auth}` },
    body,
  });
  if (!res.ok) console.error(`POST ${path} → ${res.status} ${await res.text()}`);
  return res.ok;
}

export const firstMatch = (re: RegExp, s: string) => s.match(re)?.[1] || "";

export const slugTag = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

export const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

export const shuffle = <T>(arr: T[]): T[] => { // in-place Fisher-Yates; returns arr
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

export const stripUrlsMentions = (b: string) => b.replace(/https?:\/\/\S+/g, "").replace(/@\S+/g, "").trim();

export const dayNumber = () => Math.floor(Date.now() / 86_400_000) - 20818; // daily-challenge day counter

// null on timeout/network error, so feed sweeps can skip dead feeds.
export const fetchTimeout = async (
  url: string,
  ms: number,
  headers: Record<string, string>,
): Promise<Response | null> => {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(ms), headers, redirect: "follow" });
  } catch {
    return null;
  }
};

// Worker-pool sweep over many feeds: fetch each concurrently (bounded), keep each
// feed's newest item inside the freshness window.
// Fetch a syndication feed as text. A body that stalls mid-read skips this feed, not the sweep.
export const fetchFeedText = async (url: string, ua: string, accept: string, timeoutMs: number) => {
  const res = await fetchTimeout(url, timeoutMs, { "user-agent": ua, accept });
  if (!res?.ok) return null;
  return await res.text().catch(() => null);
};

// One bad feed skips itself, never the sweep: these bots read dozens of uncurated public
// feeds, and a single oversized body (parser RangeError) used to take the whole run with it.
export const sweepOne = async <F, T>(f: F, fetchOne: (f: F) => Promise<T[]>): Promise<T[]> => {
  try {
    return await fetchOne(f);
  } catch (err) {
    console.warn(`feed ${String(f)} failed: ${(err as Error).message}`);
    return [];
  }
};

export async function sweepFeeds<F, T>(
  sample: F[],
  concurrency: number,
  fetchOne: (f: F) => Promise<T[]>,
  ts: (item: T) => number,
  cutoff: number,
): Promise<T[]> {
  let idx = 0;
  const newest: T[] = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (idx < sample.length) {
        const fresh = (await sweepOne(sample[idx++], fetchOne)).filter((i) => ts(i) > cutoff);
        fresh.sort((a, b) => ts(b) - ts(a));
        if (fresh[0]) newest.push(fresh[0]);
      }
    }),
  );
  return newest;
}

// Atom <entry>: title (CDATA or plain) + the non-rel=self link href.
export const atomTitleLink = (entry: string) => ({
  title: (firstMatch(/<title[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/title>/, entry) ||
    firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/, entry)).trim(),
  link: firstMatch(
    /href=["']([^"']+)["']/,
    [...entry.matchAll(/<link\s+([^>]*?)\/?>/g)].map((x) => x[1])
      .find((a) => !/rel=["']self["']/i.test(a) && /href=/.test(a)) ?? "",
  ),
});

// Feeds double-encode (&amp;#39;), so decode to a fixpoint rather than once.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decodeEntities = (s: string) => {
  for (let i = 0; i < 3; i++) {
    const next = s
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&([a-zA-Z]+);/g, (m, n) => ENTITIES[n] ?? m);
    if (next === s) return s;
    s = next;
  }
  return s;
};

// RSS <item>: title (CDATA or plain) + <link> + <comments>.
export const parseTitleLinkComments = (itemXml: string) => ({
  title: firstMatch(/<title><!\[CDATA\[(.*?)\]\]><\/title>/, itemXml) || firstMatch(/<title>(.*?)<\/title>/, itemXml),
  link: firstMatch(/<link>(.*?)<\/link>/, itemXml),
  comments: firstMatch(/<comments>(.*?)<\/comments>/, itemXml),
});

// ---- SVG glitch (clipart / emojiglitch) ----

type GlitchSvgOpts = {
  pathProb: number;
  pathAmp: number;
  hexProb: number;
  hexShift: number;
  decorate: (out: string, rng: () => number) => string; // extra elements injected before </svg>
};

// Jitter path coordinates + scramble hex colors, then append the caller's decorations.
// RNG call order is stable, so seeded (per-day deterministic) output stays reproducible.
export function glitchSvg(svg: string, rng: () => number, o: GlitchSvgOpts): string {
  let out = svg.replace(
    /\bd="([^"]+)"/g,
    (_m, d: string) =>
      `d="${
        d.replace(/-?\d+\.?\d*/g, (n) => rng() < o.pathProb ? String(parseFloat(n) + (rng() - 0.5) * o.pathAmp) : n)
      }"`,
  );
  out = out.replace(
    /#([0-9a-fA-F]{6})/g,
    (_m, hex: string) =>
      rng() < o.hexProb
        ? "#" +
          hex.split("").map((c) => ((parseInt(c, 16) + Math.floor(rng() * o.hexShift)) % 16).toString(16)).join("")
        : `#${hex}`,
  );
  const i = out.lastIndexOf("</svg>");
  return i === -1 ? out : out.slice(0, i) + o.decorate(out, rng) + out.slice(i);
}

// Fetch a twemoji SVG, glitch it, upload to R2; returns the public URL + source link.
// The two glitch bots decorate with the same two primitives: ghosted copies of the glyph
// path, and random colour-noise rects.
export const dupeLayers = (
  out: string,
  rng: () => number,
  o: { count: number; jitter: number; rotate: number; scale?: boolean },
) => {
  const path = out.match(/<path[^>]*\/>/)?.[0] ?? "";
  let extras = "";
  for (let i = 0; i < o.count; i++) {
    const tx = ((rng() - 0.5) * o.jitter).toFixed(1), ty = ((rng() - 0.5) * o.jitter).toFixed(1);
    const rot = Math.floor(rng() * o.rotate * 2 - o.rotate);
    const scale = o.scale ? ` scale(${(0.8 + rng() * 0.3).toFixed(2)})` : "";
    extras += `<g transform="translate(${tx},${ty}) rotate(${rot})${scale}" opacity="${
      (0.1 + rng() * 0.2).toFixed(2)
    }">${path}</g>`;
  }
  return extras;
};

export const noiseRects = (
  rng: () => number,
  o: { count: number; w: () => number; h: () => number; x?: () => number; opacity: () => number },
) => {
  let extras = "";
  for (let i = 0; i < o.count; i++) {
    // Draw order is load-bearing: clipart seeds its rng, so reordering changes the artwork.
    const x = o.x?.() ?? 0, y = Math.floor(rng() * 36), w = o.w(), h = o.h();
    const rgb = [0, 0, 0].map(() => Math.floor(rng() * 256)).join(",");
    extras += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgb(${rgb})" opacity="${
      o.opacity().toFixed(2)
    }"/>`;
  }
  return extras;
};

export async function glitchTwemojiToR2(cp: string, rng: () => number, prefix: string, o: GlitchSvgOpts) {
  const res = await fetch(`https://raw.githubusercontent.com/twitter/twemoji/master/assets/svg/${cp}.svg`);
  if (!res.ok) throw new Error(`Failed to fetch twemoji ${cp}: HTTP ${res.status}`);
  const glitched = glitchSvg(await res.text(), rng, o);
  const date = new Date().toISOString().slice(0, 10);
  const r2Url = await uploadToR2(new TextEncoder().encode(glitched), `${prefix}-${date}.svg`, "image/svg+xml");
  return { r2Url, src: `https://github.com/twitter/twemoji/blob/master/assets/svg/${cp}.svg` };
}

// ---- Reddit ----

export const unescXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

// Reddit throttles aggressively; descriptive UA + single retry on 429 is polite enough.
export async function redditFetch(url: string, timeoutMs = 15_000): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "ding-bot/1.0 (+https://ding.bar; contact: taylor@ding.bar)",
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
      },
    });
    if (res.status !== 429 || attempt === 1) return res;
    const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10);
    console.warn(`Reddit 429, sleeping ${retryAfter}s then retrying`);
    await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
  }
  throw new Error("unreachable");
}

export const extractRedditImage = (html: string): string | null => {
  const u = unescXml(html);
  const raw = u.match(/https:\/\/i\.redd\.it\/[^\s"'<>]+/)?.[0] ??
    u.match(/https:\/\/i\.imgur\.com\/[^\s"'<>]+/)?.[0] ??
    u.match(/<img[^>]+src="([^"]+)"/)?.[1] ??
    null;
  return raw ? unescXml(raw) : null;
};

export type RedditItem = { title: string; link: string; imageUrl: string | null; author: string; published: number };

export const parseRedditEntries = (xml: string): RedditItem[] => {
  const items: RedditItem[] = [];
  for (const entry of xml.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
    const title = unescXml(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").trim();
    const link = entry.match(/<link[^>]+href="([^"]+)"/)?.[1] || "";
    const content = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || "";
    const author = entry.match(/<author>[\s\S]*?<name>([^<]+)<\/name>/)?.[1]?.trim() || "";
    const pubStr = entry.match(/<published>([^<]+)<\/published>/)?.[1] ??
      entry.match(/<updated>([^<]+)<\/updated>/)?.[1] ?? "";
    const published = pubStr ? +new Date(pubStr) : 0;
    if (title && link) items.push({ title, link, imageUrl: extractRedditImage(content), author, published });
  }
  return items;
};

// ---- API helpers ----

// How far back dedup looks. Unbounded history does not scale: a bot with >5000 posts walks
// straight past paginate's maxPages cap and throws, which silently killed bot_hn and
// bot_smallweb for months. Every feed these bots read is a "recent items" feed and the item
// freshness cutoff is 4–24h, so 30 days is a wide margin against a URL resurfacing.
export const DEDUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// My own recent rows, newest-first, back to `since`. filter selects the kind:
// "&comments=1" -> char_length(body) > 1, "&reactions=1" -> single-grapheme votes, "" -> all.
const myRecent = <T>(api: Api, filter: string, since: number) =>
  paginate<T & { created_at: string }>(
    api,
    (p) => `/c?usr=${api.botUsername}${filter}&sort=new&limit=100&p=${p}`,
    { until: (r) => new Date(r.created_at).getTime() < since },
  );

const cidsOf = async (api: Api, filter: string, since?: number) =>
  new Set(
    (await myRecent<{ parent_cid: number }>(api, filter, since ?? Date.now() - DEDUP_WINDOW_MS))
      .map((r) => r.parent_cid),
  );

export const getAnsweredCids = (api: Api, opts: { since?: number } = {}) => cidsOf(api, "&comments=1", opts.since);

// Dedup for voting bots. `comments=1` filters char_length(body) > 1, so single-grapheme
// votes are invisible to getAnsweredCids — a voter that only checks it re-judges the same
// posts every tick and toggles its own votes off (the bug that plagued bot_critic).
export const getReactedCids = (api: Api, opts: { since?: number } = {}) => cidsOf(api, "&reactions=1", opts.since);

export async function getLastPostAge(api: Api, opts: { replies?: boolean } = {}): Promise<number> {
  const qs = opts.replies ? "&comments=1" : "";
  // sort=new is load-bearing: the default hot sort returns the hottest post, whose age
  // reads as stale and defeats every gap-based throttle built on this probe.
  const posts = await getJson<{ created_at: string }[]>(api, `/c?usr=${api.botUsername}&sort=new&limit=1${qs}`);
  if (!posts.length) return Infinity;
  return Date.now() - new Date(posts[0].created_at).getTime();
}

export async function getPostedUrls(api: Api, opts: { since?: number } = {}): Promise<Set<string>> {
  const posts = await myRecent<{ body: string }>(api, "", opts.since ?? Date.now() - DEDUP_WINDOW_MS);
  const urls = new Set<string>();
  for (const p of posts) for (const u of p.body.match(/https?:\/\/[^\s]+/g) || []) urls.add(u);
  return urls;
}

export type FeedItem = { link: string; commentsUrl?: string; body: string; tags: string };

const PUBDATE_RE = /<(?:pubDate|published|updated|dc:date)>([\s\S]*?)<\/(?:pubDate|published|updated|dc:date)>/i;

export const extractPubDate = (itemXml: string): string | null => {
  const m = itemXml.match(PUBDATE_RE);
  return m ? m[1].trim() : null;
};

export async function rssBot(api: Api, opts: {
  feedUrl: string;
  itemRe?: RegExp;
  parseItem: (xml: string) => FeedItem | null;
  max?: number;
}) {
  // Dedup spans full bot history (paginated). Feed-item 4h cutoff is the safety net
  // against runaway re-posts, but a stale URL can still resurface with a fresh pubDate
  // (HN front-page churn, etc.) so dedup must be wider than the cutoff.
  const posted = await getPostedUrls(api);
  console.log(`Found ${posted.size} previously posted URLs`);
  const res = await fetch(opts.feedUrl);
  if (!res.ok) throw new Error(`Feed fetch failed: HTTP ${res.status}`);
  const xml = await res.text();
  const rawItems = xml.match(opts.itemRe ?? /<item>[\s\S]*?<\/item>/g) || [];
  let stale = 0, undated = 0;
  const items: FeedItem[] = [];
  for (const itemXml of rawItems) {
    const pubDate = extractPubDate(itemXml);
    if (!pubDate) {
      undated++;
      continue;
    }
    if (!isFresh(pubDate)) {
      stale++;
      continue;
    }
    const parsed = opts.parseItem(itemXml);
    if (parsed) items.push(parsed);
  }
  if (stale || undated) console.log(`Filtered ${stale} stale, ${undated} undated items`);
  const todo = items.filter((i) => !posted.has(i.link) && !(i.commentsUrl && posted.has(i.commentsUrl)));
  console.log(`Found ${todo.length} new items to post`);
  for (const it of todo.slice(0, opts.max ?? 10)) {
    console.log(`Posting: ${it.body.slice(0, 60)}`);
    await post(api, it.body, it.tags);
  }
}

export const post = (api: Api, body: string, tags: string) => postForm(api, `/c`, { body, tags });

export const reply = (api: Api, parentCid: number, body: string) => postForm(api, `/c/${parentCid}`, { body });

export type Post = { cid: number; parent_cid: number | null; body: string; created_by: string; created_at: string };

async function fetchPost(api: Api, cid: number): Promise<Post | null> {
  const items = await getJson<Post[]>(api, `/c/${cid}`).catch(() => [] as Post[]);
  return items[0] || null;
}

export function firstLink(body: string): string | null {
  return body.match(/https?:\/\/[^\s)]+/)?.[0] ?? null;
}

export function isLinkPost(body: string, threshold = 140): boolean {
  if (!/https?:\/\//.test(body)) return false;
  return body.replace(/https?:\S+/g, "").trim().length < threshold;
}

export async function extractArticle(
  url: string,
): Promise<{ title: string; text: string } | null> {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 ding-reader" },
    redirect: "follow",
  });
  if (!res.ok) return null;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("html")) return null;
  const html = await res.text();
  const doc = parseHTML(html).document as unknown as Document;
  const article = new Readability(doc).parse();
  if (!article?.content) return null;
  const cdoc = parseHTML(`<div id=__r>${article.content}</div>`).document as unknown as Document;
  const paras: string[] = [];
  cdoc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, pre").forEach((el: Element) => {
    const t = (el.textContent || "").replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
    if (!t) return;
    const tag = el.tagName.toLowerCase();
    if (tag === "li") paras.push(`- ${t}`);
    else if (/^h[1-6]$/.test(tag)) paras.push(`${tag === "h1" ? "#" : "##"} ${t}`);
    else paras.push(t);
  });
  const text = paras.join("\n\n").trim();
  if (text.length < 100) return null;
  return { title: (article.title ?? "").trim(), text };
}

export function extractImageUrl(body: string): string | null {
  return body.match(/https?:\/\/[^\s]+\.(?:jpe?g|png|gif|webp|svg)(?:\?[^\s]*)?/i)?.[0] ?? null;
}

export async function resolveImageUrl(
  api: Api,
  comment: { cid: number; parent_cid: number | null; body: string },
): Promise<string | null> {
  const url = extractImageUrl(comment.body);
  if (url) return url;
  if (comment.parent_cid) {
    const parent = await fetchPost(api, comment.parent_cid);
    if (parent) return extractImageUrl(parent.body);
  }
  return null;
}

export async function resolveTextContent(
  api: Api,
  comment: { cid: number; parent_cid: number | null; body: string },
): Promise<string> {
  const cleaned = comment.body.replace(/@\S+/g, "").trim();
  if (cleaned.length > 5) return cleaned;
  if (comment.parent_cid) {
    const parent = await fetchPost(api, comment.parent_cid);
    if (parent) return parent.body;
  }
  return comment.body;
}

// ---- R2 upload ----

export async function uploadToR2(
  data: Uint8Array,
  filename: string,
  contentType: string,
  keyPrefix = "bots/",
): Promise<string> {
  const endpoint = Deno.env.get("R2_ENDPOINT");
  const accessKey = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const bucket = Deno.env.get("R2_BUCKET");
  const publicUrl = Deno.env.get("R2_PUBLIC_URL");

  if (!endpoint || !accessKey || !secretKey || !bucket || !publicUrl) {
    throw new Error(
      "Missing R2 environment variables (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL)",
    );
  }

  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const region = "auto";
  const service = "s3";

  const key = `${keyPrefix}${filename}`;
  const url = `${endpoint}/${bucket}/${key}`;

  const payloadHash = await sha256Hex(data);

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Host": new URL(endpoint).host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  const signedHeaderKeys = Object.keys(headers).sort().map((k) => k.toLowerCase());
  const signedHeaders = signedHeaderKeys.join(";");

  const canonicalRequest = [
    "PUT",
    `/${bucket}/${key}`,
    "",
    ...signedHeaderKeys.map((k) => {
      const val = k === "host" ? headers["Host"] : k === "content-type" ? headers["Content-Type"] : headers[k];
      return `${k}:${val}`;
    }),
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");

  const signingKey = await getSignatureKey(secretKey, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  headers["Authorization"] =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, { method: "PUT", headers, body: data as unknown as BodyInit });
  if (!res.ok) throw new Error(`R2 upload failed: HTTP ${res.status} ${await res.text()}`);

  return `${publicUrl}/${key}`;
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string | Uint8Array): Promise<ArrayBuffer> {
  const rawKey = key instanceof Uint8Array ? key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encoded = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return crypto.subtle.sign("HMAC", cryptoKey, new Uint8Array(encoded) as unknown as BufferSource);
}

async function hmacHex(key: ArrayBuffer, data: string): Promise<string> {
  return hex(new Uint8Array(await hmacSha256(key, data)));
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)));
}

function hex(buf: Uint8Array): string {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getSignatureKey(key: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  let k = await hmacSha256(new TextEncoder().encode("AWS4" + key), dateStamp);
  k = await hmacSha256(k, region);
  k = await hmacSha256(k, service);
  k = await hmacSha256(k, "aws4_request");
  return k;
}

// ---- Syllables ----

export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 2) return 1;

  let count = 0;
  let prevVowel = false;
  const vowels = "aeiouy";

  for (let i = 0; i < w.length; i++) {
    const isVowel = vowels.includes(w[i]);
    if (isVowel && !prevVowel) count++;
    prevVowel = isVowel;
  }

  if (w.endsWith("e") && !w.endsWith("le") && w.length > 3) count--;
  if (w.endsWith("ed") && w.length > 3 && !w.endsWith("ted") && !w.endsWith("ded")) count--;
  if (w.endsWith("es") && w.length > 3 && !("shxz".includes(w[w.length - 3]))) count--;
  if (w.endsWith("tion") || w.endsWith("sion")) count++;
  for (const d of ["ia", "io", "eo", "ua", "uo"]) if (w.includes(d)) count++;

  return Math.max(1, count);
}

// ---- Seeded RNG ----

export function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function todaySeed(): number {
  return Math.floor(Date.now() / 86_400_000);
}

// ---- Candidate picking ----

// Latest top-level posts + comments, merged and deduped by cid.
export async function fetchFreshPosts<T extends { cid: number } = Post>(api: Api, limit = 50): Promise<T[]> {
  const [top, comments] = await Promise.all([
    getJson<T[]>(api, `/c?sort=new&limit=${limit}`),
    getJson<T[]>(api, `/c?sort=new&comments=1&limit=${limit}`),
  ]);
  const seen = new Set<number>();
  return [...top, ...comments].filter((p) => !seen.has(p.cid) && !!seen.add(p.cid));
}

type Candidate = {
  cid: number;
  parent_cid: number | null;
  body: string;
  created_by: string;
  created_at: string;
  c_comments: number;
};

// Fetches top-level posts + comments, filters bot's own posts + already-answered + stale,
// ranks: prefer posts with fewer replies (spreads bots across threads), random tiebreak.
// The shared "worth replying to" filter: not mine, not already handled, fresh, and with
// enough prose left once URLs are stripped. Four bots each had their own copy of this.
export async function pickCandidates(
  api: Api,
  answered: Set<number>,
  opts: {
    pool?: number;
    minBodyLen?: number;
    excludeLinkPosts?: boolean;
    excludeBots?: boolean;
    reacted?: Set<number>;
    extra?: (p: Candidate) => boolean;
  } = {},
): Promise<Candidate[]> {
  const all = await fetchFreshPosts<Candidate>(api, opts.pool ?? 50);
  return all
    .filter((p) =>
      p.created_by !== api.botUsername &&
      !answered.has(p.cid) &&
      !opts.reacted?.has(p.cid) &&
      !(opts.excludeBots && p.created_by?.startsWith("bot_")) &&
      isFresh(p.created_at) &&
      p.body.length > 1 &&
      p.body.replace(/https?:\S+/g, "").trim().length >= (opts.minBodyLen ?? 30) &&
      (opts.excludeLinkPosts === false || !isLinkPost(p.body)) &&
      (opts.extra?.(p) ?? true)
    )
    .map((p) => ({ p, c: Number(p.c_comments ?? 0), r: Math.random() }))
    .sort((a, b) => a.c - b.c || a.r - b.r)
    .map(({ p }) => p);
}

export async function personaBot(api: Api, opts: {
  system: string;
  maxTokens?: number;
  minGapMin?: number;
  maxReplies?: number;
}) {
  const ageMin = (await getLastPostAge(api, { replies: true })) / 60_000;
  if (ageMin < (opts.minGapMin ?? 240)) {
    console.log(`Last reply ${Math.round(ageMin)}min ago, skipping`);
    return;
  }
  const answered = await getAnsweredCids(api);
  const candidates = await pickCandidates(api, answered);
  console.log(`Found ${candidates.length} candidates`);
  for (const p of candidates.slice(0, opts.maxReplies ?? 1)) {
    const text = await claude(p.body, { system: opts.system, maxTokens: opts.maxTokens ?? 50 });
    await reply(api, p.cid, text);
    console.log(`Replied to cid=${p.cid}: ${text.slice(0, 60)}...`);
  }
}

// One claude() call judges a batch of fresh posts; each verdict name maps to an action.
// Used by critic and the janky crew. Dedup spans replies AND single-grapheme votes.
// Action contract: null/undefined = declined by design, no POST attempted;
// false = POST attempted and failed (postForm logged the status); else = landed.
export async function verdictBot(api: Api, opts: {
  system: string; // must demand ONLY a JSON array: [{"cid":123,"verdict":"...","note":"..."}]
  verdicts: Record<string, (api: Api, p: Post, note?: string) => unknown>;
  maxActions?: number; // keep POSTs-per-verdict × maxActions under POST_RATE_MAX (10/min)
  temperature?: number;
  minBodyLen?: number;
}) {
  const since = Date.now() - MAX_AGE_MS;
  const [answered, reacted] = await Promise.all([
    getAnsweredCids(api, { since }),
    getReactedCids(api, { since }),
  ]);
  // bot_% authors excluded: verdict bots reacting to each other's replies would chain
  // one Haiku call per bot per 5-min tick with no terminating condition.
  const candidates = (await pickCandidates(api, answered, {
    pool: 40,
    minBodyLen: opts.minBodyLen ?? 20,
    excludeBots: true,
    reacted,
  })).slice(0, 10);
  console.log(`Judging ${candidates.length} candidates`);
  if (!candidates.length) return;
  const prompt = candidates.map((p) => `cid=${p.cid}\n${p.body.slice(0, 500)}\n---`).join("\n");
  const raw = await claude(prompt, { system: opts.system, temperature: opts.temperature ?? 1, maxTokens: 800 });
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`verdictBot: non-JSON verdicts: ${raw.slice(0, 200)}`);
  let verdicts: { cid: number | string; verdict: string; note?: string }[];
  try {
    verdicts = JSON.parse(m[0]);
  } catch (e) {
    throw new Error(`verdictBot: unparseable verdicts (${e}): ${m[0].slice(0, 200)}`);
  }
  const max = opts.maxActions ?? 8;
  const byCid = new Map(candidates.map((p) => [p.cid, p]));
  let acted = 0, attempted = 0, landed = 0, declined = 0, skipped = 0;
  for (const v of verdicts) {
    const act = opts.verdicts[v.verdict], p = byCid.get(Number(v.cid));
    if (!act || !p) {
      skipped++;
      continue;
    }
    byCid.delete(p.cid); // a duplicate verdict for the same cid would toggle the vote back off
    if (++acted > max) {
      console.log(`Capped at ${max} actions, dropped the rest`);
      break;
    }
    const r = await act(api, p, v.note);
    if (r == null) {
      declined++;
      continue;
    }
    attempted++;
    if (r === false) continue;
    landed++;
    console.log(`${v.verdict} on cid=${p.cid}`);
  }
  console.log(`Landed ${landed}/${attempted} POSTs (${declined} declined, ${skipped} skipped/unknown)`);
  if (attempted && !landed)
    throw new Error(`verdictBot: ${attempted} POSTs attempted, none landed (rate limit? bad creds?)`);
}

// A category-carrying link-aggregator RSS feed (lobste.rs, tildes.net): item tags come from
// <category> elements, body is title / link / "<Label>: <comments url>".
export const categoryRssBot = (
  api: Api,
  o: { feedUrl: string; label: string; prefixTags?: string; slugSpaces?: boolean },
) =>
  rssBot(api, {
    feedUrl: o.feedUrl,
    parseItem: (x) => {
      const { title, link, comments } = parseTitleLinkComments(x);
      if (!title || !link) return null;
      const cats = (x.match(/<category>(.*?)<\/category>/g) || [])
        .map((t) => {
          const c = t.replace(/<\/?category>/g, "").toLowerCase();
          return o.slugSpaces ? c.replace(/\s+/g, "-") : c;
        });
      return {
        link,
        commentsUrl: comments,
        body: `${title}\n\n${link}${comments ? `\n\n${o.label}: ${comments}` : ""}`,
        tags: `${o.prefixTags ? o.prefixTags + " " : ""}${cats.map((t) => `#${t}`).join(" ")} #bot`.trim(),
      };
    },
  });

// Sample subreddits and post up to `maxPosts` fresh unseen entries.
// `perFeed: "newest"` (bot_reddit) keeps only each sub's newest item, so one loud sub can't
// take every slot. `perFeed: "all"` (bot_hmmm, one sub) keeps the whole fresh list, so a run
// whose newest item is already posted falls through to the next one instead of posting nothing.
export async function redditBot(api: Api, opts: {
  subs: string[];
  sample?: number;
  concurrency?: number;
  maxPosts?: number;
  freshnessMs?: number;
  perFeed?: "newest" | "all";
  selftext?: boolean;
  tags?: (sub: string) => string;
}) {
  const UA = "ding-bot/1.0 (+https://ding.bar; contact: taylor@ding.bar)";
  const TIMEOUT = 15_000;
  const sample = shuffle([...opts.subs]).slice(0, opts.sample ?? opts.subs.length);
  console.log(`Sampling ${sample.length} of ${opts.subs.length} subreddits: ${sample.join(", ")}`);

  const cutoff = Date.now() - (opts.freshnessMs ?? 24 * 60 * 60 * 1000);
  const fetchSub = async (sub: string) => {
    try {
      const res = await redditFetch(`https://www.reddit.com/r/${sub}/.rss`, TIMEOUT);
      if (!res.ok) return console.warn(`r/${sub} fetch failed: ${res.status}`), [];
      return parseRedditEntries(await res.text()).map((i) => ({ sub, ...i }));
    } catch (err) {
      console.warn(`r/${sub} fetch error: ${(err as Error).message}`);
      return [];
    }
  };
  const fresh = opts.perFeed === "all"
    ? (await Promise.all(sample.map((sub) => sweepOne(sub, fetchSub)))).flat().filter((i) => i.published > cutoff)
    : await sweepFeeds(sample, opts.concurrency ?? 4, fetchSub, (i) => i.published, cutoff);
  console.log(`Fetched ${fresh.length} fresh entries`);

  const posted = await getPostedUrls(api);
  const todo = fresh.filter((i) => !posted.has(i.link)).sort((a, b) => b.published - a.published);
  const max = opts.maxPosts ?? 3;
  console.log(`${todo.length} new items after dedup; posting up to ${max}`);

  for (const it of todo.slice(0, max)) {
    const lines = [it.title];
    if (opts.selftext !== false) {
      // A body that stalls mid-read costs this post its selftext, not the whole sweep.
      const selftext = await fetch(it.link.replace(/\/?$/, "/") + ".json", {
        signal: AbortSignal.timeout(TIMEOUT),
        headers: { "User-Agent": UA, "Accept": "application/json" },
      })
        .then(async (r) =>
          r.ok
            ? ((await r.json())?.[0]?.data?.children?.[0]?.data?.selftext ?? "").trim()
            : (console.warn(`selftext fetch failed for ${it.link}: ${r.status}`), "")
        )
        .catch((err) => (console.warn(`selftext fetch error for ${it.link}: ${err.message}`), ""));
      if (selftext) lines.push("", selftext);
    }
    lines.push("", it.link);
    if (it.imageUrl) lines.push("", it.imageUrl);
    lines.push("", `via ${it.author} on r/${it.sub}`);
    console.log(`Posting: ${it.title.slice(0, 60)}... (r/${it.sub})`);
    if (!await post(api, lines.join("\n"), opts.tags?.(it.sub) ?? `#reddit #${slugTag(it.sub)} #bot`))
      console.error(`Failed to post: ${it.title}`);
  }
}

// Scan the fresh public feed and reply where `match` recognises something. The scan/filter/
// cap/log shell is identical across bots; only the recogniser and the reply copy differ.
export async function scanBot(
  api: Api,
  opts: { max?: number; match: (text: string, post: Post) => string | null },
) {
  const answered = await getAnsweredCids(api, { since: Date.now() - MAX_AGE_MS });
  console.log(`Already answered ${answered.size} posts in last 4h`);
  const posts = await getJson<Post[]>(api, `/c?sort=new&limit=50`);
  let replies = 0;
  for (const post of posts) {
    if (replies >= (opts.max ?? 3)) break;
    if (post.created_by.startsWith("bot_") || answered.has(post.cid) || !isFresh(post.created_at)) continue;
    const body = opts.match(stripUrlsMentions(post.body), post);
    if (!body) continue;
    console.log(`Replying to cid=${post.cid}`);
    if (await reply(api, post.cid, body)) replies++;
  }
  console.log(`Replied to ${replies} posts`);
}

// Fresh, unanswered posts and comments that @-mention this bot. The single source of
// the mention query — every mention-driven harness below builds on it.
// TWO fetches on purpose: `/c`'s `comments=1` selects `parent_cid is not null`, i.e.
// comments INSTEAD OF roots, not in addition to them. One query can't see both, and a bot
// summoned from a brand-new post is the common case.
export async function unansweredMentions<T extends Post>(api: Api): Promise<T[]> {
  const answered = await getAnsweredCids(api, { since: Date.now() - MAX_AGE_MS });
  console.log(`Already answered ${answered.size} posts in last 4h`);
  const q = `/c?mention=${api.botUsername}&sort=new&limit=20`;
  const posts = (await Promise.all([getJson<T[]>(api, q), getJson<T[]>(api, `${q}&comments=1`)])).flat();
  const todo = posts.filter((p) => p.created_by !== api.botUsername && !answered.has(p.cid) && isFresh(p.created_at));
  console.log(`Found ${todo.length} unanswered @${api.botUsername} posts`);
  return todo;
}

// Replies to fresh unanswered @mentions. respond returns the reply body, or null to skip a
// post — decide that CHEAPLY: a skipped mention is never marked answered, so it comes back
// on every tick for the full MAX_AGE_MS window. Counts successful replies up to max.
export async function mentionResponderBot(api: Api, opts: {
  max?: number;
  respond: (post: Post, ctx: Api) => string | null | Promise<string | null>;
}) {
  let replies = 0, attempts = 0;
  for (const p of await unansweredMentions(api)) {
    if (replies >= (opts.max ?? 10)) break;
    const body = await opts.respond(p, api);
    if (!body) {
      console.log(`cid=${p.cid}: nothing to say, skipping`);
      continue;
    }
    console.log(`Replying to cid=${p.cid}`);
    attempts++;
    if (await reply(api, p.cid, body)) replies++;
  }
  console.log(`Replied to ${replies} posts`);
  // Every reply bounced (rate limit, deleted parent, 5xx). `max` bounds successes, not work,
  // so staying quiet here would burn a full run's worth of respond() calls per tick and still
  // report a green run to the fleet.
  if (attempts && !replies) throw new Error(`@${api.botUsername}: ${attempts} replies attempted, none landed`);
}

// Answers @mentions that carry (or reply to) an image: fetch the image bytes, run
// transform, reply with its text — or upload {bytes,ext,contentType} to R2 and reply
// with the public URL.
export async function imageMentionBot(api: Api, opts: {
  max?: number;
  transform: (
    imageBytes: Uint8Array,
    post: Post,
  ) => Promise<string | { bytes: Uint8Array; ext: string; contentType: string }>;
}) {
  for (const post of (await unansweredMentions(api)).slice(0, opts.max ?? 5)) {
    const imageUrl = await resolveImageUrl(api, post);
    if (!imageUrl) {
      console.log(`cid=${post.cid}: no image found, skipping`);
      continue;
    }
    console.log(`cid=${post.cid}: processing ${imageUrl}`);
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      console.error(`Failed to fetch image: HTTP ${imgRes.status}`);
      continue;
    }
    const out = await opts.transform(new Uint8Array(await imgRes.arrayBuffer()), post);
    let body: string;
    if (typeof out === "string") body = out;
    else {
      body = await uploadToR2(
        out.bytes,
        `${api.botUsername}-${post.cid}-${Date.now()}.${out.ext}`,
        out.contentType,
      );
      console.log(`cid=${post.cid}: uploaded ${body}`);
    }
    await reply(api, post.cid, body);
  }
}

// One post per run, gated on time since the bot's last post. make returns the body
// (or null to skip today); a failed post throws so the runner records the failure.
export async function dailyPostBot(api: Api, opts: {
  tags: string;
  minGapMs?: number;
  make: (ctx: Api) => string | null | Promise<string | null>;
}) {
  const ageMs = await getLastPostAge(api);
  console.log(`Last post was ${(ageMs / 3_600_000).toFixed(1)}h ago`);
  if (ageMs < (opts.minGapMs ?? 72_000_000)) {
    console.log("Too soon, skipping");
    return;
  }
  const body = await opts.make(api);
  if (body == null) return;
  console.log(`Posting: ${body.split("\n")[0].slice(0, 80)}`);
  // Throw, never Deno.exit — under the in-server cron an exit would kill the whole isolate.
  if (!(await post(api, body, opts.tags))) throw new Error(`${api.botUsername}: POST /c rejected the post`);
  console.log("Posted!");
}

// ---- Claude ----

// claude-3-haiku-20240307 retired 2026-04-19 and now 404s. Haiku 4.5 is the replacement;
// sampling params (temperature) are still accepted on this tier, unlike Opus 4.7+.
const CLAUDE_MODEL = "claude-haiku-4-5";

export async function claude(
  prompt: string,
  opts: { system?: string; maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: opts.maxTokens ?? 250,
      temperature: opts.temperature ?? 1,
      system: opts.system,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.content?.[0]?.text;
  if (!text) throw new Error(`Claude returned no text: ${JSON.stringify(data)}`);
  return text.trim();
}
