//// IMPORTS ///////////////////////////////////////////////////////////////////

import { Context, Hono } from "@hono/hono";
import { Fragment } from "@hono/hono/jsx";
import { HTTPException } from "@hono/hono/http-exception";
import { some } from "@hono/hono/combine";
import { createMiddleware } from "@hono/hono/factory";
import { logger } from "@hono/hono/logger";
import { basicAuth } from "@hono/hono/basic-auth";
import { html, raw } from "@hono/hono/html";
import { deleteCookie, getSignedCookie, setSignedCookie } from "@hono/hono/cookie";
import { serveStatic } from "@hono/hono/deno";
import type { HtmlEscapedString } from "@hono/hono/utils/html";
import pg from "postgres";
import { Resend } from "resend";
export const resend = new Resend(Deno.env.get("RESEND_API_KEY") ?? "");
import Stripe from "stripe";

declare module "@hono/hono" {
  interface ContextRenderer {
    (
      content: string | HtmlEscapedString | Promise<string | HtmlEscapedString>,
      props?: { title?: string },
    ): Response | Promise<Response>;
  }
}

//// TYPES /////////////////////////////////////////////////////////////////////

export type Usr = {
  name: string;
  email: string;
  password: string | null;
  bio: string;
  email_verified_at: Date | null;
  invited_by: string;
  orgs_r: string[];
  orgs_w: string[];
  last_seen_at: Date;
  created_at: Date;
  ok?: boolean;
  post_count?: number;
};

export type Org = {
  name: string;
  created_by: string;
  stripe_sub_id: string | null;
  created_at: Date;
};

export type ChildCom = {
  cid: number;
  parent_cid: number | null;
  body: string;
  created_by: string;
  created_at: string;
  tags?: string[];
  orgs?: string[];
  usrs?: string[];
  c_flags: number;
  comments: number;
  reaction_counts: Record<string, number>;
  user_reactions: string[];
  child_comments?: ChildCom[];
};

export type Com = {
  cid: number;
  parent_cid: number | null;
  created_by: string;
  tags: string[];
  orgs: string[];
  usrs: string[];
  mentions: string[];
  body: string;
  links: number[];
  thumb: string | null;
  created_at: string;
  c_comments: number;
  c_reactions: Record<string, string>;
  c_flags: number;
  flaggers: string[];
  domains: string[];
  score: string;
  comments?: number;
  reaction_count?: number;
  reaction_counts?: Record<string, number>;
  user_reactions?: string[];
  child_comments?: ChildCom[];
  unread?: boolean;
  kind?: "mention" | "reply";
};

//// CONSTANTS & HELPERS ///////////////////////////////////////////////////////

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[m]!));
const extractFirstUrl = (b: string) => b.match(/https?:\/\/[^\s]+/)?.[0] || null;
export const extractLinks = (b: string) => [...b.matchAll(/https:\/\/ding\.bar\/c\/(\d+)/g)].map((m) => parseInt(m[1]));
export const extractMentions = (
  b: string,
) => [...new Set([...b.matchAll(/@([0-9a-zA-Z_]{4,32})/g)].map((m) => m[1].toLowerCase()))];
export const extractImageUrl = (b: string) =>
  b.match(/https?:\/\/[^\s]+\.(?:jpe?g|png|gif|webp|svg)(?:\?[^\s]*)?/i)?.[0] || null;

export const extractDomains = (b: string): string[] => {
  const out = new Set<string>();
  for (const m of b.matchAll(/https?:\/\/[^\s]+/g)) {
    try {
      out.add(new URL(m[0]).hostname.toLowerCase().replace(/^www\./, ""));
    } catch { /**/ }
  }
  return [...out];
};

const refreshScores = async (pid: string | number) => {
  await sql`select refresh_score(array(
    select cid from com where cid = ${pid} or ${pid}::int = any(links)
  ))`;
};

const FLAG_THRESHOLD = 3;

const resolveThumbnail = async (url: string) => {
  if (/\.(?:jpe?g|png|gif|webp|svg)(?:\?|$)/i.test(url)) return url;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "ding/1.0" }, signal: AbortSignal.timeout(3000) });
    const og = (await res.text()).match(/<meta[^>]+(?:property="og:image"|name="twitter:image")[^>]+content="([^"]+)"/i)
      ?.[1];
    if (og) return new URL(og, url).href;
  } catch { /* ignore */ }
  return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=128`;
};

//// LABEL PARSING /////////////////////////////////////////////////////////////

export type Labels = { tag: string[]; org: string[]; usr: string[]; www: string[]; text: string };

const PFX: Record<string, keyof Labels> = { "#": "tag", "*": "org", "@": "usr", "~": "www" };
const SYM: Record<string, string> = { tag: "#", org: "*", usr: "@", www: "~" };

export const parseLabels = (input: string): Labels => {
  const labels: Labels = { tag: [], org: [], usr: [], www: [], text: "" };
  input.split(/\s+/).filter(Boolean).forEach((t) => {
    const k = PFX[t[0]];
    if (k) (labels[k] as string[]).push(k === "usr" ? t.slice(1) : t.slice(1).toLowerCase());
    else labels.text = labels.text ? labels.text + " " + t : t;
  });
  return labels;
};

export const encodeLabels = (l: Labels) => {
  const p = new URLSearchParams();
  Object.entries(l).forEach(([k, v]) => (Array.isArray(v) ? v.forEach((x) => p.append(k, x)) : v && p.set("q", v)));
  return p;
};

export const decodeLabels = (p: URLSearchParams) => {
  const res: string[] = [];
  Object.entries(PFX).forEach(([sym, k]) => p.getAll(k).forEach((v) => res.push(sym + v)));
  p.getAll("mention").forEach((v) => res.push(`mention:${v}`));
  ["replies_to", "reactions", "comments", "q"].forEach((k) => {
    const v = p.get(k);
    if (v) res.push(k === "q" ? v : (k === "reactions" || k === "comments") ? (v === "1" ? k : "") : `${k}:${v}`);
  });
  return res.filter(Boolean).join(" ");
};

export const formatLabels = (c: { tags?: string[]; orgs?: string[]; usrs?: string[]; domains?: string[] }) => [
  ...(c.tags || []).map((t) => `#${t}`),
  ...(c.orgs || []).map((t) => `*${t}`),
  ...(c.usrs || []).map((t) => `@${t}`),
  ...(c.domains || []).map((t) => `~${t}`),
];

const buildFilterTitle = (p: URLSearchParams) =>
  Object.entries(PFX).filter(([_, k]) => k !== "www").flatMap(([sym, k]) => p.getAll(k).map((v) => sym + v)).join(" ");

const buildAdditiveLink = (p: URLSearchParams | undefined, k: string, v: string) => {
  const n = new URLSearchParams(p);
  if (!n.getAll(k).includes(v)) n.append(k, v);
  n.delete("p");
  return `/?${n}`;
};

//// EMAIL TOKEN ///////////////////////////////////////////////////////////////

const SECRET = Deno.env.get("EMAIL_TOKEN_SECRET") ?? (() => {
  throw new Error("EMAIL_TOKEN_SECRET required");
})();

export const emailToken = async (ts: Date, email: string) => {
  const epoch = Math.floor(ts.getTime() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${epoch}:${email}`));
  return `${epoch}:${
    Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)
  }`;
};

const validateEmailToken = async (token: string, email: string, maxAge = 172800000) => {
  const [epoch] = token.split(":"), ts = parseInt(epoch) * 1000;
  return ts && (Date.now() - ts < maxAge) && token === (await emailToken(new Date(ts), email));
};

//// POSTGRES //////////////////////////////////////////////////////////////////

type Sql = ReturnType<typeof pg>;
export let sql: Sql = pg(Deno.env.get(`DATABASE_URL`)?.replace(/flycast/, "internal")!, { database: "ding" });
export const setSql = (s: Sql) => (sql = s);

//// RESEND ///////////////////////////////////////////////////////////////////

if (!Deno.env.get(`RESEND_API_KEY`))
  console.warn("RESEND_API_KEY is missing. Verification + password reset emails will fail.");

const resendErrBody = (err: unknown) => {
  const r = (err as { response?: { body?: unknown } })?.response;
  return r?.body ?? err;
};

const sendVerify = async (email: string) => {
  if (!Deno.env.get(`RESEND_API_KEY`))
    throw new Error(`RESEND_API_KEY missing — cannot send verification email to ${email}`);
  const token = await emailToken(new Date(), email);
  const { error } = await resend.emails.send({
    to: email,
    from: Deno.env.get("RESEND_FROM_EMAIL") ?? "noreply@ding.bar",
    subject: "Verify your email",
    text: `Welcome to ding.\n\nPlease verify your email: https://ding.bar/password?email=${
      encodeURIComponent(email)
    }&token=${encodeURIComponent(token)}`,
  });
  if (error) {
    console.error(`Could not send verification email to ${email}:`, error);
    throw new Error(`resend send failed: ${error.message}`);
  }
};

//// STRIPE ////////////////////////////////////////////////////////////////////

const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const isStripeConfigured = stripeKey.startsWith("sk_");

if (!isStripeConfigured)
  console.warn("STRIPE_SECRET_KEY is missing, invalid, or still a placeholder. org features will fail.");

export const stripe = new Stripe(isStripeConfigured ? stripeKey : "sk_test_placeholder", {
  httpClient: Stripe.createFetchHttpClient(),
});

//// COMPONENTS ////////////////////////////////////////////////////////////////

const User = (u: Usr, viewerName?: string) => {
  const isOwner = viewerName && viewerName == u.name;
  return (
    <section class="user">
      <h2>@{u.name}</h2>
      <div class="user-links">
        {u.name !== u.invited_by || <a href={`/u/${u.invited_by}`}>invited by @{u.invited_by}</a>}
        <a href={`/c?usr=${u.name}`}>posts</a>
        <a href={`/c?usr=${u.name}&comments=1`}>comments</a>
        {isOwner && (
          <>
            <a href={`/c?mention=${u.name}`}>mentions</a>
            <a href={`/c?replies_to=${u.name}`}>replies</a>
            <a href={`/c?usr=${u.name}&reactions=1`}>reactions</a>
            <a href="/o/new">org</a>
          </>
        )}
      </div>
      <pre>{u.bio}</pre>
    </section>
  );
};

const isReaction = (body: string): boolean => !!body && [...body].length === 1; // Single grapheme (handles emoji)

const SortToggle = ({ sort, baseHref, title }: { sort: string; baseHref: string; title: string }) => {
  const base = new URL(baseHref, "http://x");
  const href = (s: string) => {
    const p = new URLSearchParams(base.search);
    s === "hot" ? p.delete("sort") : p.set("sort", s);
    p.delete("p");
    return `${base.pathname}?${p}`;
  };
  return (
    <nav class="sort-toggle" aria-label="sort">
      <span>{title}</span>
      <span class="sort-toggle__options">
        {["hot", "new", "top"].map((s, i) => (
          <Fragment key={s}>{i > 0 && " • "}{sort === s ? s : <a href={href(s)}>{s}</a>}</Fragment>
        ))}
      </span>
    </nav>
  );
};

const ActiveFilters = ({ params, basePath = "/c" }: { params: URLSearchParams; basePath?: string }) => {
  const f: { label: string; param: string; value: string }[] = [];
  ["tag", "org", "usr", "www", "mention"].forEach((k) =>
    params.getAll(k).forEach((v) => f.push({ label: (SYM[k] ?? `${k}:`) + v, param: k, value: v }))
  );
  ["replies_to", "reactions", "comments"].forEach((k) =>
    params.get(k) &&
    f.push({
      label: k === "reactions" || k === "comments" ? k : `${k}:${params.get(k)}`,
      param: k,
      value: params.get(k)!,
    })
  );

  return f.length > 0
    ? (
      <div class="active-filters">
        {f.map((x) => {
          const n = new URLSearchParams(params);
          n.delete(x.param);
          params.getAll(x.param).filter((v) => v !== x.value).forEach((v) => n.append(x.param, v));
          n.delete("p");
          return <a key={`${x.param}:${x.value}`} href={`${basePath}?${n}`} class="filter-pill">{x.label} x</a>;
        })}
      </div>
    )
    : <div class="active-filters" />;
};

const reactName = (k: string) => k === "▲" ? "upvote" : k === "▼" ? "downvote" : `react ${k}`;

const Reactions = (c: Com | ChildCom) =>
  Object.entries({ "▲": 0, "▼": 0, ...(c.reaction_counts || {}) }).map(([k, v]) => (
    <form
      key={k}
      method="post"
      action={`/c/${c.cid}`}
      class={`reaction${(c.user_reactions || []).includes(k) ? " reacted" : ""}`}
    >
      <input type="hidden" name="body" value={k} />
      <button type="submit" aria-label={reactName(k)}>{k} {v}</button>
    </form>
  ));

// deno-lint-ignore no-explicit-any
type BodyNode = any;

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^\n*]+\*\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/(?:[^\s<()]+|\([^\s<()]*\))+)/g;

const isImageUrl = (u: string) => /\.(?:jpe?g|png|gif|webp|svg)(?:\?[^\s]*)?$/i.test(u);

const inlineFmt = (s: string): BodyNode[] => {
  const out: BodyNode[] = [];
  let i = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    const idx = m.index!;
    if (idx > i) out.push(s.slice(i, idx));
    const [full, code, bold, italic, link, url, bareUrl] = m;
    if (code) out.push(<code>{code}</code>);
    else if (bold) out.push(<strong>**{inlineFmt(bold.slice(2, -2))}**</strong>);
    else if (italic) out.push(<em>_{inlineFmt(italic.slice(1, -1))}_</em>);
    else if (link) {
      out.push(<a href={url}>{link}</a>);
      if (isImageUrl(url)) out.push(<img class="pre-img" src={url} loading="lazy" />);
    } else if (bareUrl) {
      const trail = bareUrl.match(/[.,!?;:]+$/)?.[0] ?? "";
      const clean = trail ? bareUrl.slice(0, -trail.length) : bareUrl;
      out.push(<a href={clean}>{clean}</a>);
      if (trail) out.push(trail);
      if (isImageUrl(clean)) out.push(<img class="pre-img" src={clean} loading="lazy" />);
    }
    i = idx + full.length;
  }
  if (i < s.length) out.push(s.slice(i));
  return out;
};

const heading = (level: number, children: BodyNode[]) =>
  level === 1 ? <h3>{children}</h3> : level === 2 ? <h4>{children}</h4> : <h5>{children}</h5>;

export const formatBody = (body: string): BodyNode[] => {
  const out: BodyNode[] = [];
  const parts = body.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    if (part.startsWith("```") && part.endsWith("```") && part.length >= 6) {
      out.push(<pre>{part}</pre>);
      continue;
    }
    const lines = part.split("\n");
    let i = 0;
    while (i < lines.length) {
      const ln = lines[i];
      if (/^(?:    |\t)/.test(ln)) {
        const block: string[] = [];
        while (i < lines.length && (/^(?:    |\t)/.test(lines[i]) || lines[i] === "")) {
          block.push(lines[i]);
          i++;
        }
        while (block.length && block[block.length - 1] === "") block.pop();
        out.push(<pre>{block.join("\n")}</pre>);
        continue;
      }
      if (/^\s*(?:[-*]|\d+\.)\s+/.test(ln)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i]);
          i++;
        }
        out.push(<ul class="body-list">{items.map((it) => <li>{inlineFmt(it)}</li>)}</ul>);
        continue;
      }
      if (/^>\s?/.test(ln)) {
        const qs: string[] = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          qs.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        out.push(<blockquote>{formatBody(qs.join("\n"))}</blockquote>);
        continue;
      }
      const hm = ln.match(/^(#{1,6})\s+/);
      if (hm) {
        out.push(heading(Math.min(hm[1].length, 3), inlineFmt(ln)));
        i++;
        continue;
      }
      const para: string[] = [];
      while (
        i < lines.length && lines[i] !== "" &&
        !/^(?:    |\t)/.test(lines[i]) &&
        !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^#{1,6}\s+/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) {
        out.push(<p>{inlineFmt(para.join("\n"))}</p>);
      }
      if (i < lines.length && lines[i] === "") i++;
    }
  }
  return out;
};

const Meta = (c: Com | ChildCom, user?: string, labelHref?: (l: string) => string) => {
  const lh = labelHref ?? ((l: string) => `/c?${PFX[l[0]] ?? "tag"}=${l.slice(1)}`);
  return (
    <div class="meta">
      {c.created_at && <a class="meta-date" href={`/c/${c.cid}`}>{new Date(c.created_at).toLocaleDateString()}</a>}
      <span class="reactions-group">
        <span class="reaction">
          <a href={`/c/${c.cid}`}>» {c.comments || 0}</a>
        </span>
        {Reactions(c)}
      </span>
      {c.parent_cid && <a href={`/c/${c.parent_cid}`}>parent</a>}
      <a href={`/u/${c.created_by}`}>@{c.created_by || "unknown"}</a>
      {c.body && user == c.created_by && <a href={`/c/${c.cid}/delete`}>delete</a>}
      <a href={`/c/${c.cid}`}>reply</a>
      {formatLabels(c).map((l) => <a key={l} href={lh(l)}>{l}</a>)}
    </div>
  );
};

const Comment = (c: Com | ChildCom, user?: string, asPost?: boolean) => {
  const flagged = c.c_flags >= FLAG_THRESHOLD && user !== c.created_by;
  let title: BodyNode[] | null = null;
  let rest = c.body;
  if (asPost && rest && !flagged) {
    const nl = rest.indexOf("\n");
    const firstLine = (nl >= 0 ? rest.slice(0, nl) : rest).trim();
    if (firstLine) {
      title = inlineFmt(firstLine);
      rest = nl >= 0 ? rest.slice(nl + 1).replace(/^\n+/, "") : "";
    }
  }
  return (
    <div key={c.cid} class="comment" id={String(c.cid)}>
      {Meta(c, user)}
      {title && <h1 class="post-title">{title}</h1>}
      <div class="body">
        {flagged ? "[flagged]" : c.body ? rest ? formatBody(rest) : null : "[deleted by author]"}
      </div>
      <div class="children">
        {(c as Com).child_comments?.map((ch) => Comment(ch, user))}
      </div>
    </div>
  );
};

const defaultThumb =
  "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 1 1%27%3E%3Crect fill=%27%23333%27 width=%271%27 height=%271%27/%3E%3C/svg%3E";

const Post = (c: Com, user?: string, p?: URLSearchParams) => {
  const linkUrl = (c.body && extractFirstUrl(c.body)) || null;
  const labelHref = (l: string) => buildAdditiveLink(p, PFX[l[0]] ?? "tag", l.slice(1));
  return (
    <>
      <a href={linkUrl ?? `/c/${c.cid}`} class="thumb" {...(linkUrl ? { target: "_blank", rel: "noopener" } : {})}>
        <img
          src={c.thumb ? `/img?url=${encodeURIComponent(c.thumb)}` : defaultThumb}
          loading="lazy"
          onerror={`this.onerror=null;this.src='${defaultThumb}'`}
        />
      </a>
      <div class="post-content">
        <a href={`/c/${c.cid}`}>
          {c.body
            ? c.body.trim().split("\n")[0].slice(0, 60) + (c.body.length > 60 ? "…" : "")
            : "[deleted by author]"}
        </a>
        {Meta(c, user, labelHref)}
      </div>
    </>
  );
};

//// HONO //////////////////////////////////////////////////////////////////////

const cookieSecret = Deno.env.get("COOKIE_SECRET") ?? Math.random().toString();
const notFound = () => {
  throw new HTTPException(404, { message: "Not found." });
};
const form = async (c: Context) => {
  const ct = c.req.header("content-type") || "";
  if (!ct.includes("form") && !ct.includes("multipart"))
    throw new HTTPException(400, { message: `Expected form content-type, got "${ct || "none"}"` });
  return Object.fromEntries([...(await c.req.formData()).entries()].map(([k, v]) => [k, v.toString()]));
};
const host = (c: Context) => {
  const h = c.req.header("host")?.match(/^(?:https?:\/\/)?(?:www\.)?([^\/]+)\.([^\/]+)\./)?.[1];
  if (h) return h;
  const a = c.req.header("accept") || "", t = c.req.header("content-type") || "";
  if (a.includes("json") || t.includes("json")) return "api";
  if (a.includes("html")) return undefined;
  if (a.includes("xml")) return "rss";
  return undefined;
};
const ok = (c: Context) => host(c) === "api" ? c.body(null, 204) : c.redirect("/u");

const basicAuthName = async (c: Context): Promise<string | null> => {
  const a = c.req.header("Authorization");
  if (!a?.startsWith("Basic ")) return null;
  try {
    const [u, ...rest] = atob(a.slice(6)).split(":");
    const [usr] = await sql`select name from usr where (email=${u} or name=${u}) and password=crypt(${
      rest.join(":")
    }, password)`;
    return usr?.name ?? null;
  } catch {
    return null;
  }
};

const authed = some(
  createMiddleware<{ Variables: { name: string } }>(async (c, next) => {
    const n = await getSignedCookie(c, cookieSecret, "name");
    if (!n) throw new HTTPException(401);
    c.set("name", n);
    await next();
  }),
  basicAuth({
    verifyUser: async (u, p, c) => {
      const [usr] =
        await sql`select name, (password = crypt(${p}, password)) as ok from usr where email=${u} or name=${u}`;
      if (!usr?.ok) return false;
      await setSignedCookie(c, "name", usr.name, cookieSecret);
      c.set("name", usr.name);
      return true;
    },
  }),
);

const app = new Hono<{ Variables: { name: string } }>();
app.use(logger());
app.notFound(notFound);

const botRe = /bot|crawl|spider|slurp|bing|facebook|google|yandex|baidu|duck|sogou|semrush|ahref/i;

app.use("*", async (c, next) => {
  const url = new URL(c.req.url), ua = c.req.header("User-Agent") || "";
  if (url.searchParams.getAll("tag").length > 3) return c.text("Too many tags", 400);
  if (url.search && botRe.test(ua)) return c.text("Forbidden", 403);
  const n = await getSignedCookie(c, cookieSecret, "name");
  if (n) c.set("name", n);
  let unread = 0;
  if (n && !host(c)) {
    const [row] = await sql`
      select count(*)::int as c from com
      where created_by != ${n}
        and orgs <@ (select orgs_r from usr where name = ${n})::text[]
        and created_at > (select last_seen_at from usr where name = ${n})
        and (${n}::text = any(usrs) or parent_cid in (select cid from com where created_by = ${n}))
    `;
    unread = row?.c || 0;
  }
  const scriptBody = `
    document.querySelectorAll("pre").forEach(x => {
      x.innerHTML = x.innerHTML.replace(/(https?:\\/\\/\\S+)/g, u => {
        const isImg = /\\.(jpe?g|png|gif|webp|svg)(\\?.*)?$/i.test(u) || /^https?:\\/\\/(i\\.redd\\.it|i\\.imgur\\.com|pbs\\.twimg\\.com)\\//i.test(u);
        return isImg ? '<a href="'+u+'">'+u+'</a><br><img src="'+u+'" loading="lazy" class="pre-img">' : '<a href="'+u+'">'+u+'</a>';
      });
    });
    const fr = document.getElementById("search-form");
    if (fr) fr.onsubmit = e => {
      e.preventDefault();
      const v = fr.querySelector('input[name="search"]').value, p = new URLSearchParams();
      v.split(/\\s+/).filter(Boolean).forEach(t => {
        const k = {"#":"tag","*":"org","@":"usr","~":"www"}[t[0]];
        if (k) p.append(k, t.slice(1).toLowerCase()); else p.set("q", (p.get("q") ? p.get("q") + " " : "") + t);
      });
      window.location.href = "/c?" + p;
    };
    ${
    n
      ? `
    (async () => {
      if (!("Notification" in window)) return;
      if (Notification.permission === "default") {
        const b = document.createElement("button");
        b.textContent = "🔔 enable notifications";
        b.className = "notify-enable";
        b.onclick = async () => { await Notification.requestPermission(); b.remove(); };
        document.body.appendChild(b);
      }
      let last = ${unread};
      setInterval(async () => {
        try {
          const r = await fetch("/n/unread", { credentials: "same-origin" });
          if (!r.ok) return;
          const d = await r.json();
          if (d.count > last && Notification.permission === "granted") {
            (d.latest || []).slice(0, d.count - last).forEach(x => {
              const nn = new Notification("ding", { body: x.title });
              nn.onclick = () => { window.open(x.url, "_blank"); nn.close(); };
            });
          }
          last = d.count;
        } catch {}
      }, 60000);
    })();
    `
      : ""
  }
  `;
  const path = c.req.path;
  const cur = (p: string) => path === p ? raw(' aria-current="page"') : "";
  c.setRenderer((content, props) =>
    c.html(html`
      <!DOCTYPE html>
      <html>
        <head>
          <title>${props?.title ? "ding | " + props.title : "ding"}</title>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />

          <link rel="stylesheet" href="/style.css" />
        </head>
        <body>
          <header>
            <section>
              <a href="/" class="brand">▢ding</a>
              <nav aria-label="site">
                <a href="/u"${cur("/u")}>${n ? `@${n}` : "account"}</a>
                ${n
                  ? html`
                    <a href="/n"${cur("/n")}>inbox${unread ? ` (${unread})` : ""}</a>
                  `
                  : ""}
                <a href="/c"${cur("/c")}>search</a>
                <a href="/c/496">help</a>
              </nav>
            </section>
          </header>
          <main>${content}</main>
          <script>
          ${raw(scriptBody)}
          </script>
        </body>
      </html>
    `)
  );
  await next();
});

app.get("/robots.txt", (c) => c.text("User-agent: *\\nDisallow: /*?*\\nCrawl-delay: 1"));
app.get("/sitemap.txt", (c) => c.text("https://ding.bar/"));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  const msg = "something broke. try again in a moment.", h = host(c);
  if (h === "api") return c.json({ error: msg }, 500);
  if (h === "rss") return c.text(msg, 500);
  c.status(500);
  return c.render(
    <section>
      <p>{msg}</p>
    </section>,
    { title: "error" },
  );
});

app.get("/", async (c) => {
  const q = c.req.query(), p = +(q.p || 0), s = q.sort || "hot", name = c.get("name");
  const [viewer] = name ? await sql`select orgs_r, orgs_w from usr where name = ${name}` : [{ orgs_r: [], orgs_w: [] }];
  const rT = viewer?.orgs_r || [], wT = viewer?.orgs_w || [];
  const tags = c.req.queries("tag") || [], orgs = c.req.queries("org") || [], usrs = c.req.queries("usr") || [];

  const me = name || "";
  const presets = await sql<{ tag: string }[]>`
    with
    own as (
      select unnest(tags) as t, '#' as p, max(created_at) as recency
        from com where created_by = ${me} and parent_cid is null group by 1
      union all
      select unnest(orgs), '*', max(created_at)
        from com where created_by = ${me} and parent_cid is null group by 1
      union all
      select unnest(usrs), '@', max(created_at)
        from com where created_by = ${me} and parent_cid is null group by 1
    ),
    affinity as (
      select unnest(p.tags) as t, '#' as p, max(r.created_at) as recency
        from com r join com p on p.cid = r.parent_cid
        where r.created_by = ${me} and r.body = '▲' and p.parent_cid is null
        group by 1
    ),
    quality as (
      select '#' || tag as tag, 3 as pri,
        (ups_received::float / ln(posts_count + 2)) as q
      from stat_tag
      where posts_count >= 3
      order by q desc
      limit 40
    )
    select distinct on (tag) tag from (
      select '*' || unnest(${wT}::text[]) as tag, 1 as pri, now() as recency, 0.0 as q
      union all select p || t, 2, recency, 0.0 from own
      union all select p || t, 2, recency, 0.0 from affinity
      union all select tag, pri, now() - interval '365 days', q from quality
    ) t order by tag, pri, recency desc, q desc limit 20
  `;

  const items = await sql`
    select c.*, 
      (select count(*) from com c_ where c_.parent_cid = c.cid and char_length(c_.body) > 1) as comments,
      (select count(*) from com r where r.parent_cid = c.cid and char_length(r.body) = 1) as reaction_count,
      (select coalesce(jsonb_object_agg(body, cnt), '{}') from (select body, count(*) as cnt from com where parent_cid = c.cid and char_length(body) = 1 group by body) r) as reaction_counts,
      array(select body from com where parent_cid = c.cid and char_length(body) = 1 and created_by = ${
    name || ""
  }) as user_reactions,
      array(select jsonb_build_object('body', ch.body, 'created_by', ch.created_by, 'cid', ch.cid, 'created_at', ch.created_at, 'c_flags', ch.c_flags,
        'comments', (select count(*) from com c2 where c2.parent_cid = ch.cid and char_length(c2.body) > 1),
        'reaction_counts', (select coalesce(jsonb_object_agg(body, cnt), '{}') from (select body, count(*) as cnt from com where parent_cid = ch.cid and char_length(body) = 1 group by body) r),
        'user_reactions', array(select body from com where parent_cid = ch.cid and char_length(body) = 1 and created_by = ${
    name || ""
  })
      ) from com ch where ch.parent_cid = c.cid and char_length(ch.body) > 1 order by ch.created_at desc) as child_comments
    from com c where parent_cid is null and orgs <@ ${rT}::text[] and (usrs = '{}' or ${name || ""}::text = any(usrs))
    ${tags.length ? sql`and tags @> ${tags}::text[]` : sql``}
    ${orgs.length ? sql`and orgs @> ${orgs}::text[]` : sql``}
    ${usrs.length ? sql`and usrs @> ${usrs}::text[]` : sql``}
    order by ${
    s === "new" ? sql`created_at desc` : s === "top" ? sql`reaction_count desc, created_at desc` : sql`score desc`
  }
    offset ${p * 25} limit 25
  `;

  const cur = new URL(c.req.url).searchParams, meta = buildFilterTitle(cur);
  return c.render(
    <>
      <section>
        {name
          ? (
            <form method="post" action="/c">
              <label>
                post
                <textarea required name="body" rows={18} minlength={1} maxlength={4096}></textarea>
              </label>
              <p class="compose-hint">#tag · *org · @user · urls become ~domain</p>
              <div class="post-form__row">
                <input
                  type="text"
                  name="tags"
                  aria-label="labels"
                  value={decodeLabels(cur)}
                  placeholder="#link *org @user"
                />
                <button type="submit">create post</button>
              </div>
            </form>
          )
          : (
            <p class="empty">
              <a href="/signup">sign up</a> or <a href="/u">log in</a> to post.
            </p>
          )}
        <ActiveFilters params={cur} basePath="/" />
        {presets.length > 0 && (
          <div class="tag-presets">
            {presets.map((t: { tag: string }) => (
              <a
                key={t.tag}
                href={buildAdditiveLink(
                  cur,
                  t.tag[0] === "*" ? "org" : t.tag[0] === "@" ? "usr" : "tag",
                  t.tag.slice(1),
                )}
                class="tag-preset"
              >
                {t.tag}
              </a>
            ))}
          </div>
        )}
        {meta && <h2>{meta}</h2>}
      </section>
      <section>
        {!items.length
          ? <p class="empty">no posts yet.</p>
          : <div class="posts">{items.map((i) => Post(i as Com, name, cur))}</div>}
      </section>
      <section>
        <div class="pagination">
          {p > 0
            ? <a href={`/?${(() => { const n = new URLSearchParams(cur); n.set("p", (p - 1).toString()); return n; })()}`}>prev</a>
            : <span />}
          {items.length === 25 && (
            <a href={`/?${(() => { const n = new URLSearchParams(cur); n.set("p", (p + 1).toString()); return n; })()}`}>next</a>
          )}
        </div>
      </section>
    </>,
    { title: meta || undefined },
  );
});

app.post("/login", async (c) => {
  const { email, password } = await form(c);
  const [u] =
    await sql`select name, email, email_verified_at, (password = crypt(${password}, password)) as ok from usr where email=${email}`;
  if (!u?.ok) throw new HTTPException(401);
  if (!u.email_verified_at && !(await getSignedCookie(c, cookieSecret, "name"))) {
    sendVerify(u.email).catch((err) =>
      console.error(`/login resend failed for ${u.email}:`, err?.response?.body || err)
    );
  }
  await setSignedCookie(c, "name", u.name, cookieSecret);
  return c.redirect(c.req.query("next")?.startsWith("/") ? c.req.query("next")! : "/u");
});

app.get("/logout", (c) => (deleteCookie(c, "name"), c.redirect("/")));
app.post("/logout", (c) => (deleteCookie(c, "name"), ok(c)));

app.get("/verify", async (c) => {
  const e = c.req.query("email"), t = c.req.query("token");
  if (!e || !t || !(await validateEmailToken(t, e))) throw new HTTPException(400);
  await sql`update usr set email_verified_at = now() where email_verified_at is null and email = ${e}`;
  return ok(c);
});

app.get("/forgot", (c) =>
  c.render(
    <section>
      {c.req.query("sent") !== undefined
        ? (
          <>
            <p>Check your email for a link to set your password. (Wait 5m if it hasn't arrived.)</p>
            <a href="/u">back</a>
          </>
        )
        : (
          <form method="post" action="/forgot">
            <label>email <input required name="email" type="email" /></label>
            <button type="submit">send</button>
          </form>
        )}
    </section>,
    { title: "forgot" },
  ));
app.post("/forgot", async (c) => {
  const { email } = await form(c), [u] = await sql`select email from usr where email = ${email}`;
  if (u) await sendVerify(u.email).catch((err) => console.error(`/forgot email failed for ${u.email}:`, err));
  return c.redirect("/forgot?sent=1");
});

app.get("/password", (c) =>
  c.render(
    <section>
      <form method="post" action="/password">
        <input name="token" value={c.req.query("token")} type="hidden" />
        <label>email <input name="email" value={c.req.query("email")} readonly /></label>
        <label>new password <input name="password" type="password" required /></label>
        <button type="submit">set</button>
      </form>
    </section>,
    { title: "password" },
  ));
app.post("/password", async (c) => {
  const { email, token, password } = await form(c);
  if (!(await validateEmailToken(token, email))) throw new HTTPException(400);
  const [u] =
    await sql`update usr set password = crypt(${password}, gen_salt('bf', 8)), email_verified_at = coalesce(email_verified_at, now()) where email = ${email} returning name`;
  if (u) await setSignedCookie(c, "name", u.name, cookieSecret);
  return ok(c);
});

app.post("/invite", authed, async (c) => {
  const e = (await form(c)).email, n = Math.random().toString(36).slice(2);
  if ((await sql`select count(*) from usr where invited_by = ${c.get("name")!}`)[0].count >= 4)
    throw new HTTPException(400);
  const [u] = await sql`insert into usr (name, email, bio, invited_by) values (${n}, ${e}, '...', ${c.get(
    "name",
  )!}) on conflict do nothing returning email`;
  if (u) await sendVerify(u.email).catch((err) => console.error(`/invite email failed for ${u.email}:`, err));
  return ok(c);
});

app.get("/signup", (c) => {
  const err = c.req.query("error"), prefillEmail = c.req.query("email") ?? "";
  const messages: Record<string, HtmlEscapedString | Promise<HtmlEscapedString>> = {
    name_taken: <p>That username is already taken. Pick another.</p>,
    already_verified: (
      <p>
        That email is already registered. <a href="/forgot">Forgot your password?</a>
      </p>
    ),
    email_failed: (
      <p>
        Account created, but the verification email failed to send. Try resending in a moment, or contact support.
      </p>
    ),
    conflict: <p>Username or email already taken.</p>,
  };
  return c.render(
    <section>
      <h2>sign up</h2>
      {c.req.query("ok") !== undefined && <p>Check your email for a verification link.</p>}
      {c.req.query("resent") !== undefined && <p>Sent another verification email — check your inbox.</p>}
      {err && messages[err]}
      <form method="post">
        <label>
          username
          <input type="text" name="name" pattern="^[0-9a-zA-Z_]{4,32}$" required />
        </label>
        <label>
          email
          <input type="email" name="email" value={prefillEmail} required />
        </label>
        <button type="submit">create account</button>
      </form>
      {(err === "email_failed" || err === "conflict") && prefillEmail && (
        <form method="post" action="/signup/resend">
          <input type="hidden" name="email" value={prefillEmail} />
          <button type="submit">resend verification email</button>
        </form>
      )}
    </section>,
    { title: "signup" },
  );
});

app.post("/signup", async (c) => {
  const formData = await form(c);
  const email = formData.email, name = formData.name;
  const qs = `&email=${encodeURIComponent(email)}`;

  const [existingByEmail] = await sql`select name, email_verified_at from usr where email = ${email}`;
  if (existingByEmail) {
    if (existingByEmail.email_verified_at) return c.redirect(`/signup?error=already_verified${qs}`);
    // Unverified: idempotent resend so user isn't stuck.
    try {
      await sendVerify(email);
      return c.redirect("/signup?ok");
    } catch (err) {
      console.error(`/signup email_failed for ${email}:`, err);
      return c.redirect(`/signup?error=email_failed${qs}`);
    }
  }

  const [existingByName] = await sql`select name from usr where name = ${name}`;
  if (existingByName) return c.redirect(`/signup?error=name_taken${qs}`);

  const usr = { name, email, bio: "coming soon", password: null, invited_by: name };
  const [newUsr] = await sql`
    with usr_ as (insert into usr ${sql(usr)} on conflict do nothing returning *)
    select name, email from usr_
  `;
  if (!newUsr?.email) return c.redirect(`/signup?error=conflict${qs}`); // race: someone grabbed it between checks
  try {
    await sendVerify(newUsr.email);
    return c.redirect("/signup?ok");
  } catch (err) {
    console.error(`/signup email_failed for ${newUsr.email}:`, resendErrBody(err));
    return c.redirect(`/signup?error=email_failed${qs}`);
  }
});

app.post("/signup/resend", async (c) => {
  const { email } = await form(c);
  const qs = `&email=${encodeURIComponent(email)}`;
  const [u] = await sql`select email, email_verified_at from usr where email = ${email}`;
  if (!u) return c.redirect(`/signup?error=conflict${qs}`); // pretend-success would mislead — ask them to sign up
  if (u.email_verified_at) return c.redirect(`/signup?error=already_verified${qs}`);
  try {
    await sendVerify(u.email);
    return c.redirect("/signup?resent");
  } catch (err) {
    console.error(`/signup/resend email_failed for ${email}:`, resendErrBody(err));
    return c.redirect(`/signup?error=email_failed${qs}`);
  }
});

app.get("/u", async (c) => {
  let name: string | undefined = (await getSignedCookie(c, cookieSecret, "name")) || undefined;
  if (name) c.set("name", name);
  else if (c.req.header("Authorization")?.startsWith("Basic ")) {
    name = (await basicAuthName(c)) ?? undefined;
    if (!name) throw new HTTPException(401, { message: "Invalid credentials." });
    c.set("name", name);
  }

  const next = c.req.query("next") ?? "";

  if (!name) {
    const action = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
    return c.render(
      <section>
        <h2>login</h2>
        <form method="post" action={action}>
          <label>email <input type="email" name="email" required /></label>
          <label>password <input type="password" name="password" required /></label>
          <button type="submit">login</button>
        </form>
        <p class="login-links">
          <a href="/forgot">forgot password?</a>
          {" • "}
          <a href="/signup">sign up</a>
        </p>
      </section>,
      { title: "login" },
    );
  }

  const [usr] = await sql`
    select name, bio, invited_by, password, orgs_r, orgs_w
    from usr where name = ${name}
  `;
  if (!usr) return notFound();
  if (!usr.password) return c.redirect("/password");
  return c.render(
    <>
      <section>{User(usr as unknown as Usr, name)}</section>
      <section>
        <form method="post" action="/u">
          <label>
            bio
            <textarea name="bio" rows={6}>{usr.bio}</textarea>
          </label>
          <button type="submit">save</button>
        </form>
      </section>
    </>,
    { title: "your account" },
  );
});

app.post("/u", authed, async (c) => {
  const data = await form(c);
  await sql`update usr set bio = ${data.bio} where name = ${c.get("name")!}`;
  return c.redirect("/u");
});

const notifQuery = (name: string, orgs_r: string[]) =>
  sql`
  select c.*, (c.created_at > u.last_seen_at) as unread,
    case when ${name}::text = any(c.usrs) then 'mention' else 'reply' end as kind
  from com c
  cross join (select last_seen_at from usr where name = ${name}) u
  where c.created_by != ${name}
    and c.orgs <@ ${orgs_r}::text[]
    and (
      ${name}::text = any(c.usrs)
      or c.parent_cid in (select cid from com where created_by = ${name})
    )
  order by c.created_at desc
  limit 100
`;

app.get("/n", authed, async (c) => {
  const name = c.get("name");
  const [usr] = await sql`select orgs_r from usr where name = ${name}`;
  const items = await notifQuery(name, usr?.orgs_r || []);
  await sql`update usr set last_seen_at = now() where name = ${name}`;
  if (host(c) === "api") return c.json(items);
  return c.render(
    <>
      <section>
        <h2>notifications</h2>
        <p class="note-sm">mentions and replies. unread items are highlighted.</p>
      </section>
      <section>
        {items.length === 0
          ? (
            <p class="empty">
              no notifications yet. mentions (@you) and replies to your posts show up here.
            </p>
          )
          : items.map((i) => {
            const item = i as Com;
            return (
              <div key={item.cid} class={`notif${item.unread ? " notif--unread" : ""}`}>
                <div class="notif__kind">{item.kind}</div>
                {Comment(item, name)}
              </div>
            );
          })}
      </section>
    </>,
    { title: "notifications" },
  );
});

app.get("/n/unread", authed, async (c) => {
  const name = c.get("name");
  const [usr] = await sql`select orgs_r, last_seen_at from usr where name = ${name}`;
  const rT = usr?.orgs_r || [];
  const rows = await sql`
    select cid, body, created_by, parent_cid
    from com c
    where created_by != ${name}
      and c.created_at > ${usr.last_seen_at}
      and orgs <@ ${rT}::text[]
      and (
        ${name}::text = any(usrs)
        or parent_cid in (select cid from com where created_by = ${name})
      )
    order by created_at desc limit 10
  `;
  return c.json({
    count: rows.length,
    latest: rows.map((r) => ({
      title: `@${r.created_by}: ${(r.body || "").trim().slice(0, 80)}`,
      url: `/c/${r.parent_cid || r.cid}#${r.cid}`,
    })),
  });
});

app.get("/u/:name", async (c) => {
  const profileName = c.req.param("name");
  const viewerName = c.get("name") ?? (await basicAuthName(c)) ?? undefined;
  if (viewerName) c.set("name", viewerName);
  const isOwner = viewerName && viewerName == profileName;
  const [usr] = await sql`
    select name, bio, invited_by
      ${isOwner ? sql`, orgs_r, orgs_w` : sql``}
    from usr where name = ${profileName}
  `;
  if (!usr) return notFound();
  switch (host(c)) {
    case "api":
      return c.json(usr, 200);
    default:
      return c.render(<section>{User(usr as Usr, viewerName)}</section>, { title: usr.name });
  }
});

app.get("/us", async (c) => {
  const limit = Math.min(+(c.req.query("limit") || 100), 500);
  const us = await sql`select name, created_at from usr order by created_at desc limit ${limit}`;
  return c.json(us, 200);
});

app.get("/o/new", authed, (c) =>
  c.render(
    <section>
      <h2>▢ create an organization</h2>
      <p class="note">
        create a private organization for your team. access control is managed via the <code>*org</code> tag.
      </p>
      <p class="note">cost: $1/member/month.</p>
      <form method="post" action="/o/new" class="form-inline">
        <input
          required
          pattern="^[0-9a-zA-Z_]{4,32}$"
          name="name"
          aria-label="org name"
          placeholder="org_name"
          class="grow"
        />
        <button type="submit">create & subscribe</button>
      </form>
      <p class="note-sm"><a href="/u">← back to account</a></p>
    </section>,
    { title: "new org" },
  ));

app.post("/o/new", authed, async (c) => {
  const { name } = await form(c);
  if (!name.match(/^[0-9a-zA-Z_]{4,32}$/)) throw new HTTPException(400, { message: "Invalid name" });

  const [existing] = await sql`select name from org where name = ${name}`;
  if (existing) throw new HTTPException(409, { message: `Org name "${name}" is already taken.` });

  const session = await stripe.checkout.sessions.create({
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `Ding Organization: ${name}`,
          },
          unit_amount: 100,
          recurring: {
            interval: "month",
          },
        },
        quantity: 1,
      },
    ],
    mode: "subscription",
    success_url: `${new URL(c.req.url).origin}/o/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${new URL(c.req.url).origin}/o/new`,
    metadata: {
      orgName: name,
      creatorName: c.get("name")!,
    },
  });

  return c.redirect(session.url!);
});

const createOrg = async (orgName: string, creatorName: string, subId: string) => {
  const inserted = await sql`
    insert into org ${sql({ name: orgName, created_by: creatorName, stripe_sub_id: subId })}
    on conflict (name) do nothing
    returning name
  `;
  if (!inserted.length) {
    const [existing] = await sql`select created_by, stripe_sub_id from org where name = ${orgName}`;
    if (existing?.stripe_sub_id === subId) return; // idempotent retry, already created
    console.error(
      `createOrg collision: wanted "${orgName}" for ${creatorName} (sub=${subId}) but exists for ${existing?.created_by} (sub=${existing?.stripe_sub_id}). Manual reconciliation required.`,
    );
    throw new HTTPException(409, {
      message: `Org "${orgName}" already exists. Your subscription ${subId} needs manual reconciliation.`,
    });
  }
  await sql`
    update usr
    set orgs_r = array_append(orgs_r, ${orgName}),
        orgs_w = array_append(orgs_w, ${orgName})
    where name = ${creatorName}
  `;
};

app.get("/o/success", authed, async (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) throw new HTTPException(400);

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.status !== "complete") throw new HTTPException(400, { message: "Payment not complete" });

  const { orgName, creatorName } = session.metadata!;
  await createOrg(orgName, creatorName, session.subscription as string);

  return c.redirect(`/o/${orgName}`);
});

app.get("/o/:name", async (c) => {
  const [org, hasAccess, members] = await Promise.all([
    sql`select * from org where name = ${c.req.param("name")}`.then((r) => r[0]),
    sql`select true from usr where true and name = ${c.get("name") ?? ""} and ${c.req.param("name")} = any(orgs_r)`
      .then((r) => r[0]),
    sql`select name from usr where ${c.req.param("name")} = any(orgs_r)`,
  ]);
  if (!org) return notFound();
  if (!hasAccess) throw new HTTPException(403, { message: "Access denied" });

  const viewer = c.get("name") ?? "";
  return c.render(
    <section>
      <h2>*{org.name}</h2>
      <p class="note-sm">
        created by @{org.created_by} on {new Date(org.created_at).toLocaleDateString()}.
      </p>
      <div class="stack stack--loose">
        <div>
          <h3>members ({members.length})</h3>
          <div class="stack">
            {members.map((m) => (
              <div class="member-row">
                <a href={`/u/${m.name}`}>@{m.name}</a>
                {org.created_by === viewer && m.name !== viewer && (
                  <form method="post" action={`/o/${org.name}/remove`} class="form-inline">
                    <input type="hidden" name="name" value={m.name} />
                    <button type="submit" class="btn-sm">remove</button>
                  </form>
                )}
                {m.name === viewer && org.created_by !== viewer && (
                  <form method="post" action={`/o/${org.name}/remove`} class="form-inline">
                    <input type="hidden" name="name" value={viewer} />
                    <button type="submit" class="btn-sm">leave</button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </div>
        {org.created_by === viewer && (
          <div class="section-divider">
            <h3>invite member</h3>
            <form method="post" action={`/o/${org.name}/invite`} class="form-inline">
              <input required type="email" name="email" aria-label="email" placeholder="email" class="grow" />
              <button type="submit">invite ($1/mo)</button>
            </form>
          </div>
        )}
      </div>
    </section>,
    { title: org.name },
  );
});

app.post("/o/:name/invite", authed, async (c) => {
  const [org, { email }] = await Promise.all([
    sql`select * from org where name = ${c.req.param("name")}`.then((r) => r[0]),
    form(c),
  ]);
  if (!org) return notFound();
  if (org.created_by !== c.get("name")) throw new HTTPException(403, { message: "Only owner can invite" });
  if (!email || !email.includes("@") || email.length < 4 || email.length > 64)
    throw new HTTPException(400, { message: "Invalid email" });

  const [existing] = await sql`select name, orgs_r from usr where email = ${email}`;
  if (existing?.orgs_r.includes(org.name)) return c.redirect(`/o/${org.name}`);

  const sub = await stripe.subscriptions.retrieve(org.stripe_sub_id);
  const newQty = sub.items.data[0].quantity! + 1;
  await stripe.subscriptions.update(org.stripe_sub_id, {
    items: [{ id: sub.items.data[0].id, quantity: newQty }],
  });
  try {
    if (existing)
      await sql`update usr set orgs_r = array_append(orgs_r, ${org.name}), orgs_w = array_append(orgs_w, ${org.name}) where name = ${existing.name}`;
    else {
      const newName = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      await sql`insert into usr (name, email, bio, invited_by, orgs_r, orgs_w) values (${newName}, ${email}, '...', ${c
        .get(
          "name",
        )!}, ${[org.name]}, ${[org.name]})`;
      sendVerify(email);
    }
  } catch (err) {
    console.error(
      `DRIFT invite: bumped ${org.stripe_sub_id} to qty=${newQty} but SQL write for ${email} in ${org.name} failed.`,
      err,
    );
    throw err;
  }
  return c.redirect(`/o/${org.name}`);
});

app.post("/o/:name/remove", authed, async (c) => {
  const [org, { name: paramName }] = await Promise.all([
    sql`select * from org where name = ${c.req.param("name")}`.then((r) => r[0]),
    form(c),
  ]);
  if (!org) return notFound();
  const viewer = c.get("name");
  const isOwner = org.created_by === viewer;
  const isSelfLeave = paramName === viewer;
  if (isOwner && isSelfLeave)
    throw new HTTPException(400, { message: "Owner cannot leave their own org — transfer or delete it first" });
  if (!isOwner && !isSelfLeave) throw new HTTPException(403, { message: "Only owner or self can remove" });

  const [member] = await sql`select name from usr where name = ${paramName} and ${org.name} = any(orgs_r)`;
  if (!member) throw new HTTPException(404, { message: `${paramName} is not a member of ${org.name}` });

  const sub = await stripe.subscriptions.retrieve(org.stripe_sub_id);
  const qty = sub.items.data[0].quantity!;
  if (qty > 1) {
    await stripe.subscriptions.update(org.stripe_sub_id, {
      items: [{ id: sub.items.data[0].id, quantity: qty - 1 }],
    });
  }
  try {
    await sql`update usr set orgs_r = array_remove(orgs_r, ${org.name}), orgs_w = array_remove(orgs_w, ${org.name}) where name = ${paramName}`;
  } catch (err) {
    console.error(
      `DRIFT remove: decremented ${org.stripe_sub_id} to qty=${
        qty - 1
      } but SQL update for ${paramName} in ${org.name} failed.`,
      err,
    );
    throw err;
  }
  return c.redirect(`/o/${org.name}`);
});

app.post("/api/stripe-webhook", async (c) => {
  const sig = c.req.header("stripe-signature");
  const body = await c.req.text();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig!, Deno.env.get("STRIPE_WEBHOOK_SECRET")!);
  } catch (_err) {
    throw new HTTPException(400, { message: `Webhook Error` });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { orgName, creatorName } = session.metadata ?? {};
    if (!orgName || !creatorName || !session.subscription)
      throw new HTTPException(400, { message: "checkout.session.completed missing orgName/creatorName/subscription" });
    await createOrg(orgName, creatorName, session.subscription as string);
  } else if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const [org] = await sql`select name from org where stripe_sub_id = ${sub.id}`;
    if (org) {
      await sql.begin(async (tx) => {
        const sql = tx as unknown as Sql;
        await sql`update usr set orgs_r = array_remove(orgs_r, ${org.name}), orgs_w = array_remove(orgs_w, ${org.name})`;
        await sql`delete from org where name = ${org.name}`;
      });
    }
  }
  return c.text("Received", 200);
});

app.get("/c/:cid/delete", authed, async (c) => {
  const [cm] = await sql`select body from com where cid = ${c.req.param("cid")} and created_by = ${c.get("name")!}`;
  if (!cm) return notFound();
  return c.render(
    <section>
      <h2>Delete?</h2>
      <pre>{cm.body.slice(0, 200)}</pre>
      <form method="post">
        <button type="submit">confirm</button> <a href={`/c/${c.req.param("cid")}`}>cancel</a>
      </form>
    </section>,
    { title: "delete" },
  );
});

app.post("/c/:cid/delete", authed, async (c) => {
  const [cm] = await sql`update com set body = '' where cid = ${c.req.param("cid")} and created_by = ${c.get(
    "name",
  )!} returning parent_cid`;
  return c.redirect(cm?.parent_cid ? `/c/${cm.parent_cid}` : "/");
});

export const postRate = new Map<string, number[]>();
const POST_RATE_MAX = 10, POST_RATE_MS = 60_000;

app.post("/c/:p?", async (c) => {
  const pid = c.req.param("p") || null;
  const n = c.get("name") ?? (await basicAuthName(c)) ?? undefined;
  if (!n) return c.redirect(`/u?next=${encodeURIComponent(pid ? `/c/${pid}` : "/")}`);

  const refBack = (): string | null => {
    const ref = c.req.header("referer");
    if (!ref) return null;
    try {
      const u = new URL(ref);
      if (u.host !== c.req.header("host")) return null;
      return u.pathname + u.search;
    } catch {
      return null;
    }
  };

  const now = Date.now();
  for (const [k, ts] of postRate) {
    const fresh = ts.filter((t) => now - t < POST_RATE_MS);
    if (fresh.length) postRate.set(k, fresh);
    else postRate.delete(k);
  }
  const times = postRate.get(n) ?? [];
  if (times.length >= POST_RATE_MAX) throw new HTTPException(429, { message: "slow down. try again in a minute." });
  times.push(now);
  postRate.set(n, times);

  const f = await c.req.formData(),
    b = f.get("body")?.toString() || "",
    [usr] = await sql`select orgs_w, orgs_r from usr where name = ${n}`;
  let tags: string[], orgs: string[], usrs: string[];
  type Prm = {
    tags: string[];
    orgs: string[];
    usrs: string[];
    created_by: string;
    prm_parent: number | null;
    domains: string[];
  };
  let prm: Prm | undefined;

  if (pid) {
    [prm] = await sql<
      Prm[]
    >`select tags, orgs, usrs, created_by, parent_cid as prm_parent, domains from com where cid = ${pid}`;
    if (!prm || !prm.orgs.every((t) => usr.orgs_r.includes(t)) || (prm.usrs.length && !prm.usrs.includes(n)))
      throw new HTTPException(403);
    tags = prm.tags;
    orgs = prm.orgs;
    usrs = prm.usrs;

    if (isReaction(b)) {
      if (prm.created_by === n)
        return c.redirect((prm.prm_parent ? `/c/${prm.prm_parent}#${pid}` : `/c/${pid}`) + "?err=self-react");
      const [existing] =
        await sql`select cid from com where parent_cid = ${pid} and created_by = ${n} and body = ${b} and char_length(body) = 1 limit 1`;
      if (existing) {
        await sql.begin((tx) => {
          const sql = tx as unknown as Sql;
          return Promise.all([
            sql`delete from com where cid = ${existing.cid}`,
            sql`update com set c_reactions = c_reactions || hstore(${b}, greatest(coalesce((c_reactions->${b})::int,0)-1, 0)::text) where cid = ${pid}`,
          ]);
        });
        await refreshScores(pid);
        const r = refBack();
        return c.redirect(r ? `${r}#${pid}` : (prm.prm_parent ? `/c/${prm.prm_parent}#${pid}` : `/c/${pid}`));
      }
    }
  } else {
    const l = parseLabels(f.get("tags")?.toString() || "");
    if (!l.tag.length || !l.org.every((t) => usr.orgs_w.includes(t))) throw new HTTPException(403);
    tags = l.tag;
    orgs = l.org;
    usrs = l.usr;
  }

  if (pid && b === "flag") {
    const [prm2] = await sql`select created_by, parent_cid as prm_parent, flaggers from com where cid = ${pid}`;
    const back = prm2.prm_parent ? `/c/${prm2.prm_parent}#${pid}` : `/c/${pid}`;
    if (prm2.created_by === n) return c.redirect(`${back}?err=self-flag`);
    if (!prm2.flaggers.includes(n))
      await sql`update com set c_flags = c_flags + 1, flaggers = array_append(flaggers, ${n}) where cid = ${pid}`;
    return c.redirect(back);
  }

  const links = extractLinks(b);
  const mentions = extractMentions(b);
  const thumb = pid
    ? null
    : (extractImageUrl(b) || (extractFirstUrl(b) ? await resolveThumbnail(extractFirstUrl(b)!) : null));
  const domains = extractDomains(b);
  const [cm] =
    await sql`insert into com (parent_cid, created_by, body, tags, orgs, usrs, mentions, links, thumb, domains) values (${pid}, ${n}, ${b}, ${tags}, ${orgs}, ${usrs}, ${mentions}, ${links}, ${thumb}, ${domains}) returning cid`;

  if (pid) {
    if (isReaction(b))
      await sql`update com set c_reactions = c_reactions || hstore(${b}, (coalesce((c_reactions->${b})::int,0)+1)::text) where cid = ${pid}`;
    else await sql`update com set c_comments = c_comments + 1 where cid = ${pid}`;
    await refreshScores(pid);
  } else {
    await refreshScores(cm.cid);
  }

  if (pid && isReaction(b)) {
    const r = refBack();
    if (r) return c.redirect(`${r}#${pid}`);
  }
  const [pr] = pid ? await sql`select parent_cid from com where cid = ${pid}` : [null];
  return c.redirect(pid ? (pr?.parent_cid ? `/c/${pr.parent_cid}#${pid}` : `/c/${pid}#${cm.cid}`) : `/c/${cm.cid}`);
});

app.get("/c/:cid?", async (c) => {
  const q = c.req.query(),
    cid = c.req.param("cid"),
    n = c.get("name"),
    s = q.sort || "hot",
    p = +(q.p || 0),
    lim = Math.min(+(q.limit || 25), 100);
  const [viewer] = n ? await sql`select orgs_r from usr where name = ${n}` : [{ orgs_r: [] }];
  const rT = viewer?.orgs_r || [],
    tags = c.req.queries("tag") || [],
    orgs = c.req.queries("org") || [],
    usrs = c.req.queries("usr") || [],
    mens = c.req.queries("mention") || [],
    www = c.req.queries("www") || [];

  const items = await sql`
    select c.*, (select count(*) from com c_ where c_.parent_cid = c.cid and char_length(c_.body) > 1) as comments,
      (select count(*) from com r where r.parent_cid = c.cid and char_length(r.body) = 1) as reaction_count,
      (select coalesce(jsonb_object_agg(body, cnt), '{}') from (select body, count(*) as cnt from com where parent_cid = c.cid and char_length(body) = 1 group by body) r) as reaction_counts,
      array(select body from com where parent_cid = c.cid and char_length(body) = 1 and created_by = ${
    n || ""
  }) as user_reactions,
      array(select jsonb_build_object('body', ch.body, 'created_by', ch.created_by, 'cid', ch.cid, 'parent_cid', ch.parent_cid, 'created_at', ch.created_at, 'tags', ch.tags, 'orgs', ch.orgs, 'usrs', ch.usrs, 'c_flags', ch.c_flags,
        'comments', (select count(*) from com c2 where c2.parent_cid = ch.cid and char_length(c2.body) > 1),
        'reaction_counts', (select coalesce(jsonb_object_agg(body, cnt), '{}') from (select body, count(*) as cnt from com where parent_cid = ch.cid and char_length(body) = 1 group by body) r),
        'user_reactions', array(select body from com where parent_cid = ch.cid and char_length(body) = 1 and created_by = ${
    n || ""
  }),
        'child_comments', array(select jsonb_build_object('body', gc.body, 'created_by', gc.created_by, 'cid', gc.cid, 'parent_cid', gc.parent_cid, 'created_at', gc.created_at, 'tags', gc.tags, 'orgs', gc.orgs, 'usrs', gc.usrs, 'c_flags', gc.c_flags,
          'comments', (select count(*) from com c3 where c3.parent_cid = gc.cid and char_length(c3.body) > 1),
          'reaction_counts', (select coalesce(jsonb_object_agg(body, cnt), '{}') from (select body, count(*) as cnt from com where parent_cid = gc.cid and char_length(body) = 1 group by body) r),
          'user_reactions', array(select body from com where parent_cid = gc.cid and char_length(body) = 1 and created_by = ${
    n || ""
  })
        ) from com gc where gc.parent_cid = ch.cid and char_length(gc.body) > 1 order by gc.created_at desc)
      ) from com ch where ch.parent_cid = c.cid and char_length(ch.body) > 1 order by ch.created_at desc) as child_comments
    from com c where ${
    cid
      ? sql`cid = ${cid}`
      : (q.reactions || q.replies_to || q.comments ? sql`parent_cid is not null` : sql`parent_cid is null`)
  }
    ${usrs.length ? sql`and created_by = any(${usrs}::citext[])` : sql``}
    and tags @> ${tags}::text[] and orgs <@ ${rT}::text[] and (usrs = '{}' or ${n || ""}::text = any(usrs))
    ${orgs.length ? sql`and orgs && ${orgs}::text[]` : sql``}
    ${
    mens.length ? sql`and (usrs && ${mens}::text[] or mentions && ${mens.map((m) => m.toLowerCase())}::text[])` : sql``
  }
    ${www.length ? sql`and domains && ${www}::text[]` : sql``}
    ${q.replies_to ? sql`and parent_cid in (select cid from com where created_by = ${q.replies_to})` : sql``}
    ${q.reactions ? sql`and char_length(body) = 1` : sql``}
    ${q.comments ? sql`and char_length(body) > 1` : sql``}
    ${q.q ? sql`and to_tsvector('english', body) @@ plainto_tsquery('english', ${q.q})` : sql``}
    order by ${
    s === "new" ? sql`created_at desc` : s === "top" ? sql`reaction_count desc, created_at desc` : sql`score desc`
  }
    offset ${p * lim} limit ${lim}
  `;

  if (host(c) === "api") return c.json(items);
  if (host(c) === "rss") {
    return c.text(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>ding</title><link>https://ding.bar/</link>${
        items.map((i) =>
          `<item><title>${escapeXml(i.body.slice(0, 60))}</title><link>https://ding.bar/c/${i.cid}</link><pubDate>${
            new Date(i.created_at).toUTCString()
          }</pubDate></item>`
        ).join("")
      }</channel></rss>`,
      200,
      { "Content-Type": "application/rss+xml" },
    );
  }

  if (!cid) {
    const cur = new URL(c.req.url).searchParams, meta = buildFilterTitle(cur);
    const onlyFilter = !mens.length && !www.length && !q.q && !q.reactions && !q.replies_to && !q.comments;
    const singleTag = onlyFilter && tags.length === 1 && !orgs.length && !usrs.length ? tags[0] : null;
    const singleOrg = onlyFilter && orgs.length === 1 && !tags.length && !usrs.length ? orgs[0] : null;
    const singleUsr = onlyFilter && usrs.length === 1 && !tags.length && !orgs.length ? usrs[0] : null;
    const tagCount = singleTag
      ? ((await sql`select count(*)::int as count from com where ${singleTag} = any(tags) and orgs <@ ${rT}::text[] and (usrs = '{}' or ${
        n || ""
      }::text = any(usrs))`)[0].count)
      : null;
    const orgInfo = singleOrg
      ? (await sql`select (select count(*)::int from usr where ${singleOrg} = any(orgs_r)) as member_count, (select created_by from org where name = ${singleOrg}) as created_by`)[
        0
      ]
      : null;
    const orgMembers = orgInfo?.member_count ?? null;
    const orgCreatedBy = orgInfo?.created_by ?? null;
    const usrRow = singleUsr
      ? (await sql`select u.name, u.bio, (select count(*)::int from com where created_by = ${singleUsr} and parent_cid is null and orgs <@ ${rT}::text[]) as post_count from usr u where u.name = ${singleUsr}`)[
        0
      ]
      : null;
    const usrPostCount = usrRow?.post_count ?? null;
    const userMatches = q.q
      ? await sql`select name from usr
                   where name ilike ${"%" + q.q + "%"} or bio ilike ${"%" + q.q + "%"}
                   order by (name ilike ${q.q + "%"}) desc, length(name) asc
                   limit 5`
      : [];
    return c.render(
      <>
        <section>
          <form id="search-form" method="get" action="/c" class="search-form">
            <input name="search" aria-label="search" value={decodeLabels(cur)} />
            <button type="submit">search</button>
          </form>
          <ActiveFilters params={cur} />
          {singleTag && (
            <div class="info-block">
              <h2>#{singleTag}</h2>
              <p class="note">{tagCount} post{tagCount === 1 ? "" : "s"}</p>
              <p class="note-sm"><a href={`/?tag=${singleTag}`}>post to #{singleTag}</a></p>
            </div>
          )}
          {singleOrg && (
            <div class="info-block">
              <h2>*{singleOrg}</h2>
              <p class="note">
                {orgMembers} member{orgMembers === 1 ? "" : "s"}
                {orgCreatedBy && (
                  <>
                    {" · "}created by <a href={`/u/${orgCreatedBy}`}>@{orgCreatedBy}</a>
                    {" · "}
                    <a href={`/o/${singleOrg}`}>settings</a>
                  </>
                )}
              </p>
              <p class="note-sm"><a href={`/?org=${singleOrg}`}>post to *{singleOrg}</a></p>
            </div>
          )}
          {singleUsr && usrRow && (
            <div class="info-block">
              <h2>@{singleUsr}</h2>
              <p class="note">
                {usrPostCount} post{usrPostCount === 1 ? "" : "s"}
                {" · "}
                <a href={`/u/${singleUsr}`}>profile</a>
              </p>
              <p class="note-sm"><a href={`/?usr=${singleUsr}`}>post to @{singleUsr}</a></p>
            </div>
          )}
          {!singleTag && !singleOrg && !singleUsr && meta && <h2>{meta}</h2>}
          {q.q && userMatches.length > 0 && (
            <div class="user-matches">
              {userMatches.map((u) => <a key={u.name} href={`/c?usr=${u.name}`}>@{u.name}</a>)}
            </div>
          )}
          <SortToggle sort={s} baseHref={`/c?${cur}`} title="results" />
        </section>
        <section>
          {items.length === 0
            ? (
              <p class="empty">
                no results. <a href="/c">clear filters</a> or <a href="/">back to home</a>.
              </p>
            )
            : <div class="posts">{items.map((i) => Post(i as Com, n, cur))}</div>}
        </section>
        <section>
          <div class="pagination">
            {p > 0
              ? <a href={`/c?${(() => { const n = new URLSearchParams(cur); n.set("p", (p - 1).toString()); return n; })()}`}>prev</a>
              : <span />}
            {items.length === lim && (
              <a href={`/c?${(() => { const n = new URLSearchParams(cur); n.set("p", (p + 1).toString()); return n; })()}`}>next</a>
            )}
          </div>
        </section>
      </>,
      { title: meta || "search" },
    );
  }

  const post = items[0];
  if (!post) return notFound();
  const backlinks =
    await sql`select cid, body, created_at from com where parent_cid is null and ${post.cid} = any(links) and orgs <@ ${rT}::text[] and (usrs = '{}' or ${
      n || ""
    }::text = any(usrs)) order by created_at desc limit 5`;
  const replies = (post.child_comments || []).filter((r: ChildCom) => !isReaction(r.body));
  const errMsg: Record<string, string> = {
    "self-react": "you cannot react to your own post",
    "self-flag": "you cannot flag your own post",
  };
  return c.render(
    <>
      {q.err && errMsg[q.err] && (
        <section>
          <p class="error">{errMsg[q.err]}</p>
        </section>
      )}
      <section>
        {Comment(
          { ...post, child_comments: (post.child_comments || []).filter((r: ChildCom) => isReaction(r.body)) } as Com,
          n,
          true,
        )}
      </section>
      <section>
        {n
          ? (
            <form method="post" action={`/c/${post.cid}`}>
              <label>
                reply
                <textarea required name="body" rows={18}></textarea>
              </label>
              <button type="submit">reply</button>
            </form>
          )
          : (
            <div class="stack">
              <p class="note">create an account to reply</p>
              <form method="post" action="/signup" class="stack">
                <label>
                  username
                  <input required name="name" type="text" pattern="^[0-9a-zA-Z_]{4,32}$" />
                </label>
                <label>
                  email
                  <input required name="email" type="email" />
                </label>
                <button type="submit">sign up</button>
              </form>
              <p class="note-sm">
                already have an account? <a href={`/u?next=${encodeURIComponent(`/c/${post.cid}`)}`}>log in</a>
              </p>
            </div>
          )}
        <SortToggle sort={s} baseHref={`/c/${cid}`} title="comments" />
      </section>
      <section>
        {replies.length === 0
          ? <p class="empty">no replies yet{n ? ". be the first." : "."}</p>
          : replies.map((r: ChildCom) => Comment(r, n))}
      </section>
      {backlinks.length > 0 && (
        <section>
          <h3>backlinks</h3>
          <div class="backlinks">
            {backlinks.map((bl) => (
              <div key={bl.cid}>
                <a href={`/c/${bl.cid}`}>{bl.body.trim().split("\n")[0].slice(0, 60)}</a>
              </div>
            ))}
          </div>
        </section>
      )}
    </>,
    { title: post.body.slice(0, 16) },
  );
});

app.get("/img", async (c) => {
  const url = c.req.query("url");
  if (!url) throw new HTTPException(400, { message: "missing ?url=" });
  if (!/^https?:\/\//.test(url)) throw new HTTPException(400, { message: "invalid url" });
  const res = await fetch(url, { headers: { "User-Agent": "ding/1.0" }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new HTTPException(502, { message: `upstream ${res.status}` });
  const ct = res.headers.get("content-type") || "image/png";
  if (!ct.startsWith("image/")) throw new HTTPException(400, { message: "not an image" });
  return new Response(res.body, {
    headers: { "Content-Type": ct, "Cache-Control": "public, max-age=604800, immutable" },
  });
});

app.use("/*", serveStatic({ root: "./public" }));
export default app;
