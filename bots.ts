// Shared bot infrastructure for ding bots

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

// ---- API helpers ----

export async function getAnsweredCids(
  auth: string,
  botUsername: string,
  apiUrl: string,
): Promise<Set<number>> {
  const res = await fetch(
    `${apiUrl}/c?usr=${botUsername}&comments=1&limit=100`,
    { headers: { Accept: "application/json", Authorization: `Basic ${auth}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch answered CIDs: HTTP ${res.status} ${await res.text()}`);
  const replies: { parent_cid: number }[] = await res.json();
  return new Set(replies.map((r) => r.parent_cid));
}

export async function getLastPostAge(
  auth: string,
  botUsername: string,
  apiUrl: string,
): Promise<number> {
  const res = await fetch(`${apiUrl}/c?usr=${botUsername}&limit=1`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch recent posts: HTTP ${res.status} ${await res.text()}`);
  const posts: { created_at: string }[] = await res.json();
  if (!posts.length) return Infinity;
  return Date.now() - new Date(posts[0].created_at).getTime();
}

export async function post(
  auth: string,
  apiUrl: string,
  body: string,
  tags: string,
): Promise<boolean> {
  const formData = new FormData();
  formData.append("body", body);
  formData.append("tags", tags);
  const res = await fetch(`${apiUrl}/c`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: formData,
  });
  if (!res.ok) console.error(`Failed to post: HTTP ${res.status} ${await res.text()}`);
  return res.ok;
}

export async function reply(
  auth: string,
  apiUrl: string,
  parentCid: number,
  body: string,
): Promise<boolean> {
  const formData = new FormData();
  formData.append("body", body);
  const res = await fetch(`${apiUrl}/c/${parentCid}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: formData,
  });
  if (!res.ok) console.error(`Failed to reply to cid=${parentCid}: HTTP ${res.status}`);
  return res.ok;
}

export async function fetchPost(
  auth: string,
  apiUrl: string,
  cid: number,
): Promise<{ cid: number; parent_cid: number | null; body: string; created_by: string; created_at: string } | null> {
  const res = await fetch(`${apiUrl}/c/${cid}`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) return null;
  const items = await res.json();
  return items[0] || null;
}

export function extractImageUrl(body: string): string | null {
  const m = body.match(/https?:\/\/[^\s]+\.(?:jpe?g|png|gif|webp|svg)(?:\?[^\s]*)?/i);
  return m ? m[0] : null;
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
): Promise<string> {
  const endpoint = Deno.env.get("R2_ENDPOINT");
  const accessKey = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const bucket = Deno.env.get("R2_BUCKET");
  const publicUrl = Deno.env.get("R2_PUBLIC_URL");

  if (!endpoint || !accessKey || !secretKey || !bucket || !publicUrl) {
    throw new Error("Missing R2 environment variables (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL)");
  }

  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const region = "auto";
  const service = "s3";

  const key = `bots/${filename}`;
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
  const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${headers[k === "host" ? "Host" : k === "content-type" ? "Content-Type" : k] || headers[k]}\n`).join("");

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
  const sig = await hmacSha256(key, data);
  return hex(new Uint8Array(sig));
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return hex(new Uint8Array(hash));
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

// ---- Syllable counting ----

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

  // Silent e at end (but not "le" after consonant which adds a syllable)
  if (w.endsWith("e") && !w.endsWith("le") && w.length > 3) count--;
  // -ed ending is usually silent unless preceded by t or d
  if (w.endsWith("ed") && w.length > 3 && !w.endsWith("ted") && !w.endsWith("ded")) count--;
  // Handle -es
  if (w.endsWith("es") && w.length > 3 && !("shxz".includes(w[w.length - 3]))) count--;
  // Common suffixes that are their own syllable
  if (w.endsWith("tion") || w.endsWith("sion")) count++; // already counted, but tion is 1 not 2
  // Diphthong corrections - these count as 2 when split across syllables
  const diphthongs = ["ia", "io", "eo", "ua", "uo"];
  for (const d of diphthongs) {
    if (w.includes(d)) count++;
  }

  return Math.max(1, count);
}

export function countSyllablesInLine(text: string): number {
  return text.split(/\s+/).filter(Boolean).reduce((sum, w) => sum + countSyllables(w), 0);
}

// ---- Stress detection ----

const UNSTRESSED_WORDS = new Set([
  "a", "an", "the", "and", "but", "or", "nor", "for", "yet", "so",
  "in", "on", "at", "to", "of", "by", "up", "as", "if", "is", "am",
  "are", "was", "were", "be", "been", "do", "does", "did", "has",
  "have", "had", "may", "can", "will", "shall", "would", "could",
  "should", "might", "must", "it", "its", "he", "she", "we", "they",
  "me", "him", "her", "us", "them", "my", "his", "our", "your",
  "their", "this", "that", "with", "from", "not", "no",
]);

export function guessStress(text: string): ("0" | "1")[] {
  const words = text.toLowerCase().replace(/[^a-z\s'-]/g, "").split(/\s+/).filter(Boolean);
  const pattern: ("0" | "1")[] = [];

  for (const word of words) {
    const syllCount = countSyllables(word);
    if (syllCount === 1) {
      pattern.push(UNSTRESSED_WORDS.has(word) ? "0" : "1");
    } else {
      // Multi-syllable: apply suffix-based stress rules
      const stresses = guessWordStress(word, syllCount);
      pattern.push(...stresses);
    }
  }
  return pattern;
}

function guessWordStress(word: string, syllCount: number): ("0" | "1")[] {
  const result: ("0" | "1")[] = new Array(syllCount).fill("0");

  if (syllCount === 2) {
    // Most 2-syllable English words stress first syllable
    // Exceptions: words starting with common unstressed prefixes
    if (/^(a|be|de|re|in|un|dis|mis|pre|pro|con|com|ex|en|em)/.test(word) && !word.endsWith("ment") && !word.endsWith("ness")) {
      result[1] = "1";
    } else {
      result[0] = "1";
    }
  } else {
    // 3+ syllables: stress rules based on suffixes
    if (word.endsWith("tion") || word.endsWith("sion") || word.endsWith("ic") || word.endsWith("ical")) {
      result[syllCount - 2] = "1"; // penultimate
    } else if (word.endsWith("ity") || word.endsWith("ify")) {
      result[Math.max(0, syllCount - 3)] = "1"; // antepenultimate
    } else if (word.endsWith("ly")) {
      result[Math.max(0, syllCount - 3)] = "1";
    } else {
      // Default: stress antepenultimate for 3+, penultimate for others
      result[Math.max(0, syllCount - 3)] = "1";
    }
  }

  return result;
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
      max_tokens: opts.maxTokens ?? 400,
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
