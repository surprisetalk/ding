// Shared bot infrastructure for ding bots

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

// ---- Bot init ----

export function botInit(envPrefix: string) {
  const apiUrl = Deno.env.get("DING_API_URL") || "https://ding.bar";
  const email = Deno.env.get(`BOT_${envPrefix}_EMAIL`) || "";
  const password = Deno.env.get(`BOT_${envPrefix}_PASSWORD`) || "";
  if (!email || !password) {
    console.error(`Missing BOT_${envPrefix}_EMAIL or BOT_${envPrefix}_PASSWORD`);
    Deno.exit(1);
  }
  const auth = btoa(`${email}:${password}`);
  const botUsername = email.split("@")[0].replace(/-/g, "_");
  return { apiUrl, auth, botUsername };
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

export async function getJson<T = unknown>(path: string, auth: string, apiUrl: string): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function paginate<T>(
  pathFor: (p: number) => string,
  auth: string,
  apiUrl: string,
  opts: { until?: (item: T) => boolean; pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 50;
  const out: T[] = [];
  for (let p = 0; p < maxPages; p++) {
    const items = await getJson<T[]>(pathFor(p), auth, apiUrl);
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
  path: string,
  fields: Record<string, string>,
  auth: string,
  apiUrl: string,
): Promise<boolean> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const res = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body,
  });
  if (!res.ok) console.error(`POST ${path} → ${res.status} ${await res.text()}`);
  return res.ok;
}

export const firstMatch = (re: RegExp, s: string) => s.match(re)?.[1] || "";

export const slugTag = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

// ---- API helpers ----

export async function getAnsweredCids(
  auth: string,
  botUsername: string,
  apiUrl: string,
  opts: { since?: number } = {},
): Promise<Set<number>> {
  const replies = await paginate<{ parent_cid: number; created_at: string }>(
    (p) => `/c?usr=${botUsername}&comments=1&sort=new&limit=100&p=${p}`,
    auth,
    apiUrl,
    opts.since !== undefined ? { until: (r) => new Date(r.created_at).getTime() < opts.since! } : {},
  );
  return new Set(replies.map((r) => r.parent_cid));
}

export async function getLastPostAge(
  auth: string,
  botUsername: string,
  apiUrl: string,
  opts: { replies?: boolean } = {},
): Promise<number> {
  const qs = opts.replies ? "&comments=1" : "";
  const posts = await getJson<{ created_at: string }[]>(
    `/c?usr=${botUsername}&limit=1${qs}`,
    auth,
    apiUrl,
  );
  if (!posts.length) return Infinity;
  return Date.now() - new Date(posts[0].created_at).getTime();
}

export async function getPostedUrls(
  auth: string,
  apiUrl: string,
  botUsername: string,
  opts: { since?: number } = {},
): Promise<Set<string>> {
  const posts = await paginate<{ body: string; created_at: string }>(
    (p) => `/c?usr=${botUsername}&sort=new&limit=100&p=${p}`,
    auth,
    apiUrl,
    opts.since !== undefined ? { until: (r) => new Date(r.created_at).getTime() < opts.since! } : {},
  );
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

export async function rssBot(opts: {
  envPrefix: string;
  feedUrl: string;
  itemRe?: RegExp;
  parseItem: (xml: string) => FeedItem | null;
  max?: number;
}) {
  const { apiUrl, auth, botUsername } = botInit(opts.envPrefix);
  // Dedup spans full bot history (paginated). Feed-item 4h cutoff is the safety net
  // against runaway re-posts, but a stale URL can still resurface with a fresh pubDate
  // (HN front-page churn, etc.) so dedup must be wider than the cutoff.
  const posted = await getPostedUrls(auth, apiUrl, botUsername);
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
    await post(auth, apiUrl, it.body, it.tags);
  }
}

export const post = (auth: string, apiUrl: string, body: string, tags: string) =>
  postForm(`/c`, { body, tags }, auth, apiUrl);

export const reply = (auth: string, apiUrl: string, parentCid: number, body: string) =>
  postForm(`/c/${parentCid}`, { body }, auth, apiUrl);

export type Post = { cid: number; parent_cid: number | null; body: string; created_by: string; created_at: string };

export async function fetchPost(
  auth: string,
  apiUrl: string,
  cid: number,
): Promise<Post | null> {
  const items = await getJson<Post[]>(`/c/${cid}`, auth, apiUrl).catch(() => [] as Post[]);
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
  auth: string,
  apiUrl: string,
  comment: { cid: number; parent_cid: number | null; body: string },
): Promise<string | null> {
  const url = extractImageUrl(comment.body);
  if (url) return url;
  if (comment.parent_cid) {
    const parent = await fetchPost(auth, apiUrl, comment.parent_cid);
    if (parent) return extractImageUrl(parent.body);
  }
  return null;
}

export async function resolveTextContent(
  auth: string,
  apiUrl: string,
  comment: { cid: number; parent_cid: number | null; body: string },
): Promise<string> {
  const cleaned = comment.body.replace(/@\S+/g, "").trim();
  if (cleaned.length > 5) return cleaned;
  if (comment.parent_cid) {
    const parent = await fetchPost(auth, apiUrl, comment.parent_cid);
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

export type Candidate = {
  cid: number;
  parent_cid: number | null;
  body: string;
  created_by: string;
  created_at: string;
  c_comments: number;
};

// Fetches top-level posts + comments, filters bot's own posts + already-answered + stale,
// ranks: prefer posts with fewer replies (spreads bots across threads), random tiebreak.
export async function pickCandidates(
  auth: string,
  apiUrl: string,
  botUsername: string,
  answered: Set<number>,
  opts: { pool?: number; minBodyLen?: number; excludeLinkPosts?: boolean } = {},
): Promise<Candidate[]> {
  const pool = opts.pool ?? 50;
  const minBodyLen = opts.minBodyLen ?? 30;
  const excludeLinkPosts = opts.excludeLinkPosts ?? true;
  const [top, comments] = await Promise.all([
    getJson<Candidate[]>(`/c?sort=new&limit=${pool}`, auth, apiUrl).catch(() => [] as Candidate[]),
    getJson<Candidate[]>(`/c?sort=new&comments=1&limit=${pool}`, auth, apiUrl).catch(() => [] as Candidate[]),
  ]);
  const seen = new Set<number>();
  const all = [...top, ...comments].filter((p) => {
    if (seen.has(p.cid)) return false;
    seen.add(p.cid);
    return true;
  });
  return all
    .filter((p) =>
      p.created_by !== botUsername &&
      !answered.has(p.cid) &&
      isFresh(p.created_at) &&
      p.body.length > 1 &&
      p.body.replace(/https?:\S+/g, "").trim().length >= minBodyLen &&
      (!excludeLinkPosts || !isLinkPost(p.body))
    )
    .map((p) => ({ p, c: Number(p.c_comments ?? 0), r: Math.random() }))
    .sort((a, b) => a.c - b.c || a.r - b.r)
    .map(({ p }) => p);
}

export async function personaBot(opts: {
  envPrefix: string;
  system: string;
  maxTokens?: number;
  minGapMin?: number;
  maxReplies?: number;
}) {
  const { apiUrl, auth, botUsername } = botInit(opts.envPrefix);
  const ageMin = (await getLastPostAge(auth, botUsername, apiUrl, { replies: true })) / 60_000;
  if (ageMin < (opts.minGapMin ?? 240)) {
    console.log(`Last reply ${Math.round(ageMin)}min ago, skipping`);
    return;
  }
  const answered = await getAnsweredCids(auth, botUsername, apiUrl);
  const candidates = await pickCandidates(auth, apiUrl, botUsername, answered);
  console.log(`Found ${candidates.length} candidates`);
  for (const p of candidates.slice(0, opts.maxReplies ?? 1)) {
    const text = await claude(p.body, { system: opts.system, maxTokens: opts.maxTokens ?? 50 });
    await reply(auth, apiUrl, p.cid, text);
    console.log(`Replied to cid=${p.cid}: ${text.slice(0, 60)}...`);
  }
}

type BotCtx = { apiUrl: string; auth: string; botUsername: string };

// Replies to fresh unanswered posts under #tag. respond returns the reply body,
// or null to skip a post. Counts successful replies up to max.
export async function tagResponderBot(opts: {
  envPrefix: string;
  tag: string;
  max?: number;
  respond: (post: Post, ctx: BotCtx) => string | null | Promise<string | null>;
}) {
  const ctx = botInit(opts.envPrefix);
  const { apiUrl, auth, botUsername } = ctx;
  const answered = await getAnsweredCids(auth, botUsername, apiUrl, { since: Date.now() - MAX_AGE_MS });
  console.log(`Already answered ${answered.size} posts in last 4h`);
  const posts = await getJson<Post[]>(`/c?tag=${opts.tag}&sort=new&limit=20`, auth, apiUrl);
  const todo = posts.filter((p) => p.created_by !== botUsername && !answered.has(p.cid) && isFresh(p.created_at));
  console.log(`Found ${todo.length} unanswered #${opts.tag} posts`);
  let replies = 0;
  for (const p of todo) {
    if (replies >= (opts.max ?? 10)) break;
    const body = await opts.respond(p, ctx);
    if (!body) {
      console.log(`cid=${p.cid}: nothing to say, skipping`);
      continue;
    }
    console.log(`Replying to cid=${p.cid}`);
    if (await reply(auth, apiUrl, p.cid, body)) replies++;
  }
  console.log(`Replied to ${replies} posts`);
}

// Answers @mentions that carry (or reply to) an image: fetch the image bytes, run
// transform, reply with its text — or upload {bytes,ext,contentType} to R2 and reply
// with the public URL.
export async function imageMentionBot(opts: {
  envPrefix: string;
  max?: number;
  transform: (
    imageBytes: Uint8Array,
    post: Post,
  ) => Promise<string | { bytes: Uint8Array; ext: string; contentType: string }>;
}) {
  const { apiUrl, auth, botUsername } = botInit(opts.envPrefix);
  const answered = await getAnsweredCids(auth, botUsername, apiUrl, { since: Date.now() - MAX_AGE_MS });
  console.log(`Already answered ${answered.size} posts in last 4h`);
  const posts = await getJson<Post[]>(`/c?mention=${botUsername}&comments=1&sort=new&limit=20`, auth, apiUrl);
  const unanswered = posts.filter((p) => p.created_by !== botUsername && !answered.has(p.cid) && isFresh(p.created_at));
  console.log(`Found ${unanswered.length} unanswered mentions`);
  for (const post of unanswered.slice(0, opts.max ?? 5)) {
    const imageUrl = await resolveImageUrl(auth, apiUrl, post);
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
        `${opts.envPrefix.toLowerCase()}-${post.cid}-${Date.now()}.${out.ext}`,
        out.contentType,
      );
      console.log(`cid=${post.cid}: uploaded ${body}`);
    }
    await reply(auth, apiUrl, post.cid, body);
  }
}

// One post per run, gated on time since the bot's last post. make returns the body
// (or null to skip today); a failed post exits 1 so the runner records the failure.
export async function dailyPostBot(opts: {
  envPrefix: string;
  tags: string;
  minGapMs?: number;
  make: (ctx: BotCtx) => string | null | Promise<string | null>;
}) {
  const ctx = botInit(opts.envPrefix);
  const { apiUrl, auth, botUsername } = ctx;
  const ageMs = await getLastPostAge(auth, botUsername, apiUrl);
  console.log(`Last post was ${(ageMs / 3_600_000).toFixed(1)}h ago`);
  if (ageMs < (opts.minGapMs ?? 72_000_000)) {
    console.log("Too soon, skipping");
    return;
  }
  const body = await opts.make(ctx);
  if (body == null) return;
  console.log(`Posting: ${body.split("\n")[0].slice(0, 80)}`);
  if (!(await post(auth, apiUrl, body, opts.tags))) Deno.exit(1);
  console.log("Posted!");
}

// ---- Claude ----

const CLAUDE_MODEL = "claude-3-haiku-20240307";

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
