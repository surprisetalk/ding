// deno-lint-ignore-file no-explicit-any
//// IMPORTS ///////////////////////////////////////////////////////////////////

import { Context, Hono } from "@hono/hono";
import { HTTPException } from "@hono/hono/http-exception";
import { some } from "@hono/hono/combine";
import { createMiddleware } from "@hono/hono/factory";
import { logger } from "@hono/hono/logger";
import { basicAuth } from "@hono/hono/basic-auth";
import { html } from "@hono/hono/html";
import { deleteCookie, getSignedCookie, setSignedCookie } from "@hono/hono/cookie";
import { serveStatic } from "@hono/hono/deno";
import pg from "postgres";
import sg from "@sendgrid/mail";
import Stripe from "stripe";

//// CONSTANTS & HELPERS ///////////////////////////////////////////////////////

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[m]!));
const extractFirstUrl = (b: string) => b.match(/https?:\/\/[^\s]+/)?.[0] || null;
export const extractLinks = (b: string) =>
  [...b.matchAll(/https:\/\/ding\.bar\/c\/(\d+)/g)].map(m => parseInt(m[1]));
export const extractImageUrl = (b: string) =>
  b.match(/https?:\/\/[^\s]+\.(?:jpe?g|png|gif|webp|svg)(?:\?[^\s]*)?/i)?.[0] || null;

const isImageUrl = (u: string) => /\.(?:jpe?g|png|gif|webp|svg)(?:\?|$)/i.test(u);

const extractDomain = (b: string) => {
  const u = extractFirstUrl(b);
  if (!u) return null;
  try { return new URL(u).hostname; } catch { return null; }
};

const refreshScores = async (
  opts: { pid?: string | number; author?: string; tags?: string[]; domain?: string | null },
) => {
  const { pid, author, tags, domain } = opts;
  await sql`select refresh_score(array(
    select cid from com where false
    ${pid ? sql`or cid = ${pid} or ${pid}::int = any(links)` : sql``}
    ${author ? sql`or created_by = ${author}` : sql``}
    ${tags && tags.length ? sql`or tags && ${tags}::text[]` : sql``}
    ${domain ? sql`or domain = ${domain}` : sql``}
  ))`;
};

const FLAG_THRESHOLD = 3;

const resolveThumbnail = async (url: string) => {
  if (isImageUrl(url)) return url;
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

export const formatLabels = (c: any) => [
  ...(c.tags || []).map((t: any) => `#${t}`),
  ...(c.orgs || []).map((t: any) => `*${t}`),
  ...(c.usrs || []).map((t: any) => `@${t}`),
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

const SECRET = Deno.env.get("EMAIL_TOKEN_SECRET") ?? Math.random().toString();

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

export let sql: any = pg(Deno.env.get(`DATABASE_URL`)?.replace(/flycast/, "internal")!, { database: "ding" });
export const setSql = (s: typeof sql) => (sql = s);

//// SENDGRID //////////////////////////////////////////////////////////////////

sg.setApiKey(Deno.env.get(`SENDGRID_API_KEY`) ?? "");

const sendVerificationEmail = async (email: string, token: string) =>
  Deno.env.get(`SENDGRID_API_KEY`) &&
  (await sg
    .send({
      to: email,
      from: "taylor@troe.sh",
      subject: "Verify your email",
      text: `` +
        `Welcome to ᵗ𝕙𝔢 𝐟𝐔𝓉𝓾гє 𝔬𝔣 ᑕⓞ𝓓ƗŇg.` +
        `\n\n` +
        `Please verify your email: ` +
        `https://ding.bar/password` +
        `?email=${encodeURIComponent(email)}` +
        `&token=${encodeURIComponent(token)}`,
    })
    .catch((err) => {
      console.error(`Could not send verification email to ${email}:`, err?.response?.body || err);
    }));

//// STRIPE ////////////////////////////////////////////////////////////////////

const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const isStripeConfigured = stripeKey.startsWith("sk_");

if (!isStripeConfigured)
  console.warn("STRIPE_SECRET_KEY is missing, invalid, or still a placeholder. org features will fail.");

export const stripe = new Stripe(isStripeConfigured ? stripeKey : "sk_test_placeholder", {
  // @ts-ignore: stripe version types
  apiVersion: "2024-12-18.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});

//// COMPONENTS ////////////////////////////////////////////////////////////////

const User = (u: Record<string, any>, viewerName?: string) => {
  const isOwner = viewerName && viewerName == u.name;
  return (
    <div class="user">
      <h2>@{u.name}</h2>
      <div>
        {u.name !== u.invited_by || <a href={`/u/${u.invited_by}`}>invited by @{u.invited_by}</a>}
        <a href={`/c?usr=${u.name}`}>posts</a>
        <a href={`/c?usr=${u.name}&comments=1`}>comments</a>
        {isOwner && (
          <>
            <a href={`/c?mention=${u.name}`}>mentions</a>
            <a href={`/c?replies_to=${u.name}`}>replies</a>
            <a href={`/c?usr=${u.name}&reactions=1`}>reactions</a>
          </>
        )}
      </div>
      <div>
        <pre>{u.bio}</pre>
      </div>
    </div>
  );
};

const isReaction = (body: string): boolean => !!body && [...body].length === 1; // Single grapheme (handles emoji)

const SortToggle = ({ sort, baseHref, title }: { sort: string; baseHref: string; title: string }) => {
  const base = new URL(baseHref, "http://x");
  const hotParams = new URLSearchParams(base.search);
  hotParams.delete("sort");
  hotParams.delete("p");
  const newParams = new URLSearchParams(base.search);
  newParams.set("sort", "new");
  newParams.delete("p");
  const topParams = new URLSearchParams(base.search);
  topParams.set("sort", "top");
  topParams.delete("p");
  return (
    <nav style="margin-bottom:0.5rem;display:flex;gap:0.5rem;align-items:baseline;justify-content:space-between;text-wrap:nowrap;">
      <span>{title}</span>
      <span style="text-overflow:hidden;overflow:hidden;opacity:0.5;">{". ".repeat(100)}</span>
      <span style="font-size:0.85rem;">
        {sort === "hot" ? "hot" : <a href={`${base.pathname}?${hotParams}`}>hot</a>}
        {" • "}
        {sort === "new" ? "new" : <a href={`${base.pathname}?${newParams}`}>new</a>}
        {" • "}
        {sort === "top" ? "top" : <a href={`${base.pathname}?${topParams}`}>top</a>}
      </span>
    </nav>
  );
};

const ActiveFilters = ({ params, basePath = "/c" }: { params: URLSearchParams; basePath?: string }) => {
  const f: { label: string; param: string; value: string }[] = [];
  ["tag", "org", "usr", "www", "mention"].forEach((k) =>
    params.getAll(k).forEach((v) =>
      f.push({
        label: (k === "tag" ? "#" : k === "org" ? "*" : k === "usr" ? "@" : k === "www" ? "~" : `${k}:`) + v,
        param: k,
        value: v,
      })
    )
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

const Reactions = (c: any) =>
  Object.entries({ "▲": 0, "▼": 0, ...(c.reaction_counts || {}) }).map(([k, v]) => (
    <form
      key={k}
      method="post"
      action={`/c/${c.cid}`}
      class={`reaction${(c.user_reactions || []).includes(k) ? " reacted" : ""}`}
    >
      <input type="hidden" name="body" value={k} />
      <button type="submit">{k} {v}</button>
    </form>
  ));

const Comment = (c: any, user?: string) => (
  <div key={c.cid} class="comment" id={c.cid}>
    <div>
      {c.created_at && <a href={`/c/${c.cid}`}>{new Date(c.created_at).toLocaleDateString()}</a>}
      {c.parent_cid && <a href={`/c/${c.parent_cid}`}>parent</a>}
      <a href={`/u/${c.created_by}`}>@{c.created_by || "unknown"}</a>
      {c.body && user == c.created_by && <a href={`/c/${c.cid}/delete`}>delete</a>}
      <a href={`/c/${c.cid}`}>reply</a>
      {formatLabels(c).map((l) => (
        <a key={l} href={`/c?${l[0] === "*" ? "org" : l[0] === "@" ? "usr" : "tag"}=${l.slice(1)}`}>{l}</a>
      ))}
      {Reactions(c)}
    </div>
    <pre>{(c.c_flags >= FLAG_THRESHOLD && user !== c.created_by) ? "[flagged]" : (c.body || "[deleted by author]")}</pre>
    <div style="padding-left:1rem">{c?.child_comments?.map((ch: any) => Comment(ch, user))}</div>
  </div>
);

const defaultThumb =
  "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 1 1%27%3E%3Crect fill=%27%23333%27 width=%271%27 height=%271%27/%3E%3C/svg%3E";

const Post = (c: any, user?: string, p?: URLSearchParams) => {
  const linkUrl = (c.body && extractFirstUrl(c.body)) || null;
  return (
  <>
    <a href={linkUrl ?? `/c/${c.cid}`} class="thumb" {...(linkUrl ? { target: "_blank", rel: "noopener" } : {})}>
      <img src={c.thumb ? `/img?url=${encodeURIComponent(c.thumb)}` : defaultThumb} loading="lazy" onerror={`this.onerror=null;this.src='${defaultThumb}'`} />
    </a>
    <div class="post-content">
      <span>
        <a href={`/c/${c.cid}`}>
          {c.body
            ? (c.body.trim().split("\n")[0].slice(0, 60) + (c.body.length > 60 ? "…" : "")).padEnd(40, " .")
            : "[deleted by author]"}
        </a>
      </span>
      <div>
        <a href={`/c/${c.cid}`}>{new Date(c.created_at).toLocaleDateString()}</a>
        {c.parent_cid && <a href={`/c/${c.parent_cid}`}>parent</a>}
        <a href={`/u/${c.created_by}`}>@{c.created_by}</a>
        {c.body && user == c.created_by && <a href={`/c/${c.cid}/delete`}>delete</a>}
        <a href={`/c/${c.cid}`}>reply</a>
        {formatLabels(c).map((l) => (
          <a key={l} href={buildAdditiveLink(p, l[0] === "*" ? "org" : l[0] === "@" ? "usr" : "tag", l.slice(1))}>
            {l}
          </a>
        ))}
        {Reactions(c)}
      </div>
    </div>
  </>
  );
};

//// HONO //////////////////////////////////////////////////////////////////////

const cookieSecret = Deno.env.get("COOKIE_SECRET") ?? Math.random().toString();
const notFound = () => {
  throw new HTTPException(404, { message: "Not found." });
};
const form = async (c: Context) =>
  Object.fromEntries([...(await c.req.formData()).entries()].map(([k, v]) => [k, v.toString()]));
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
    const [usr] =
      await sql`select name from usr where (email=${u} or name=${u}) and password=crypt(${rest.join(":")}, password)`;
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
  c.setRenderer((content: any, props?: any) =>
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
              <a href="/" style="letter-spacing:10px;font-weight:700;width:100%;">▢ding</a>
              <a href="/o/new" style="letter-spacing:2px;font-size:0.875rem;opacity:0.8;"> +org </a>
              ${n ? html`<a href="/n" style="letter-spacing:2px;font-size:0.875rem;opacity:0.8;"> inbox${unread ? ` (${unread})` : ""} </a>` : ""}
              <a href="/u" style="letter-spacing:2px;font-size:0.875rem;opacity:0.8;">${c.get("name")
                ? "@" + c.get("name")
                : "account"}</a>
              <a href="/c/496" style="letter-spacing:2px;font-size:0.875rem;opacity:0.8;"> help </a>
            </section>
          </header>
          <main>${content}</main>
          <script>
          document.querySelectorAll("pre").forEach(x => {
            x.innerHTML = x.innerHTML.replace(/(https?:\\/\\/\\S+)/g, u => {
              const isImg = /\\.(jpe?g|png|gif|webp|svg)(\\?.*)?$/i.test(u) || /^https?:\\/\\/(i\\.redd\\.it|i\\.imgur\\.com|pbs\\.twimg\\.com)\\//i.test(u);
              return isImg ? '<a href="'+u+'">'+u+'</a><br><img src="'+u+'" loading="lazy" style="max-width:100%;max-height:400px;">' : '<a href="'+u+'">'+u+'</a>';
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
${n ? html`
          (async () => {
            if (!("Notification" in window)) return;
            if (Notification.permission === "default") {
              const b = document.createElement("button");
              b.textContent = "🔔 enable notifications";
              b.style.cssText = "position:fixed;bottom:0.5rem;right:0.5rem;font-size:0.75rem;opacity:0.7;z-index:10;";
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
          ` : ""}
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
  if (err instanceof HTTPException) return (err as any).getResponse();
  console.error(err);
  const msg = "Sorry, this computer is мᎥｓβ𝕖𝓱𝐀𝓋𝓲𝓷g.", h = host(c);
  if (h === "api") return c.json({ error: msg }, 500);
  if (h === "rss") return c.text(msg, 500);
  c.status(500);
  return (c as any).render(<section><p>{msg}</p></section>, { title: "error" });
});

app.get("/", async (c) => {
  const q = c.req.query(), p = +(q.p || 0), s = q.sort || "hot", name = c.get("name");
  const [viewer] = name ? await sql`select orgs_r, orgs_w from usr where name = ${name}` : [{ orgs_r: [], orgs_w: [] }];
  const rT = viewer?.orgs_r || [], wT = viewer?.orgs_w || [];
  const tags = c.req.queries("tag") || [], orgs = c.req.queries("org") || [], usrs = c.req.queries("usr") || [];

  const presets = await sql`
    select distinct on (tag) tag from (
      select '*' || unnest(${wT}::text[]) as tag, 1 as pri
      union all select '#' || unnest(tags), 2 from com where created_by = ${name || ""} and parent_cid is null
      union all select '*' || unnest(orgs), 2 from com where created_by = ${name || ""} and parent_cid is null
      union all select '@' || unnest(usrs), 2 from com where created_by = ${name || ""} and parent_cid is null
      union all select '#' || unnest(tags), 3 from com where parent_cid is null
    ) t order by tag, pri limit 20
  `;

  const items = await sql`
    select c.*, 
      (select count(*) from com c_ where c_.parent_cid = c.cid) as comments,
      (select count(*) from com r where r.parent_cid = c.cid and char_length(r.body) = 1) as reaction_count,
      (select coalesce(jsonb_object_agg(body, cnt), '{}') from (select body, count(*) as cnt from com where parent_cid = c.cid and char_length(body) = 1 group by body) r) as reaction_counts,
      array(select body from com where parent_cid = c.cid and char_length(body) = 1 and created_by = ${
    name || ""
  }) as user_reactions,
      array(select jsonb_build_object('body', body, 'created_by', created_by, 'cid', cid, 'created_at', created_at, 'c_flags', c_flags) from com where parent_cid = c.cid and char_length(body) > 1 order by created_at desc) as child_comments
    from com c where parent_cid is null and orgs <@ ${rT}::text[] and (usrs = '{}' or ${name || ""}::text = any(usrs))
    ${tags.length ? sql`and tags @> ${tags}::text[]` : sql``}
    ${orgs.length ? sql`and orgs @> ${orgs}::text[]` : sql``}
    ${usrs.length ? sql`and usrs @> ${usrs}::text[]` : sql``}
    order by ${
    s === "new"
      ? sql`created_at desc`
      : s === "top"
      ? sql`reaction_count desc, created_at desc`
      : sql`score desc`
  }
    offset ${p * 25} limit 25
  `;

  const cur = new URL(c.req.url).searchParams, meta = buildFilterTitle(cur);
  return (c as any).render(
    <>
      <section>
        <form method="post" action="/c">
          <textarea required name="body" rows={18} minlength={1} maxlength={1441}></textarea>
          <div style="display:flex;gap:0.5rem;justify-content:flex-end;align-items:center;">
            <input type="text" name="tags" value={decodeLabels(cur)} placeholder="#link *org @user" style="flex:1;" />
            <button type="submit">create post</button>
          </div>
          {presets.length > 0 && (
            <div class="tag-presets">
              {presets.map((t: any) => (
                <a
                  key={t.tag}
                  href={buildAdditiveLink(
                    cur,
                    (t.tag as string)[0] === "*" ? "org" : (t.tag as string)[0] === "@" ? "usr" : "tag",
                    (t.tag as string).slice(1),
                  )}
                  class="tag-preset"
                >
                  {t.tag}
                </a>
              ))}
            </div>
          )}
        </form>
        <ActiveFilters params={cur} basePath="/" />
        {meta && <h2>{meta}</h2>}
      </section>
      <section>
        {!items.length
          ? (
            <p>
              no posts. <a href="/">go home.</a>
            </p>
          )
          : <div class="posts">{items.map((i: any) => Post(i, name, cur))}</div>}
      </section>
      <section>
        <div style="margin-top:2rem;">
          {p > 0 && <a href={`/?${new URLSearchParams([...cur.entries(), ["p", (p - 1).toString()]])}`}>prev</a>}
          {items.length === 25 && (
            <a href={`/?${new URLSearchParams([...cur.entries(), ["p", (p + 1).toString()]])}`}>next</a>
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
  if (!u.email_verified_at && !(await getSignedCookie(c, cookieSecret, "name")))
    sendVerificationEmail(u.email, await emailToken(new Date(), u.email));
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
  (c as any).render(
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
            <input required name="email" type="email" placeholder="email" />
            <button type="submit">send</button>
          </form>
        )}
    </section>,
    { title: "forgot" },
  ));
app.post("/forgot", async (c) => {
  const { email } = await form(c), [u] = await sql`select email from usr where email = ${email}`;
  if (u) sendVerificationEmail(u.email, await emailToken(new Date(), u.email));
  return c.redirect("/forgot?sent=1");
});

app.get("/password", (c) =>
  (c as any).render(
    <section>
      <form method="post" action="/password">
        <input name="token" value={c.req.query("token")} type="hidden" />
        <input name="email" value={c.req.query("email")} readonly />
        <input name="password" type="password" placeholder="new password" />
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
  if (u) sendVerificationEmail(u.email, await emailToken(new Date(), u.email));
  return ok(c);
});

app.get("/signup", (c) =>
  (c as any).render(
    <section>
      <h2>sign up</h2>
      {c.req.query("ok") !== undefined && <p>Check your email for a verification link.</p>}
      <form method="post">
        <input type="text" name="name" placeholder="username" required />
        <input type="email" name="email" placeholder="email" required />
        <button type="submit">create account</button>
      </form>
    </section>,
    { title: "signup" },
  ));

app.post("/signup", async (c) => {
  const formData = await form(c);
  const usr = {
    name: formData.name,
    email: formData.email,
    bio: "coming soon",
    password: null,
    invited_by: formData.name, // Self-invited for self-signups
  };
  const [newUsr] = await sql`
    with usr_ as (insert into usr ${sql(usr)} on conflict do nothing returning *)
    select name, email from usr_
  `;
  if (newUsr?.email) {
    const token = await emailToken(new Date(), newUsr.email);
    await sendVerificationEmail(newUsr.email, token);
    return c.redirect("/signup?ok");
  }
  return c.redirect("/signup?error=conflict");
});

app.get("/u", async (c) => {
  // Try cookie auth first
  let name: string | undefined = (await getSignedCookie(c, cookieSecret, "name")) || undefined;

  // Try Basic Auth if no cookie
  if (!name) {
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Basic ")) {
      try {
        const decoded = atob(authHeader.slice(6));
        const [email, ...rest] = decoded.split(":");
        const password = rest.join(":");
        if (email && password) {
          const [usr] = await sql`
            select *, password = crypt(${password}, password) AS is_password_correct
            from usr where email = ${email} or name = ${email}
          `;
          if (usr?.is_password_correct) {
            name = usr.name;
            c.set("name", name!);
          } else {
            throw new HTTPException(401, { message: "Invalid credentials." });
          }
        }
      } catch (_e) {
        throw new HTTPException(401, { message: "Invalid auth header." });
      }
    }
  } else {
    c.set("name", name);
  }

  const next = c.req.query("next") ?? "";

  if (!name) {
    const action = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
    return (c as any).render(
      <section>
        <h2>login</h2>
        <form method="post" action={action}>
          <input type="email" name="email" placeholder="email" required />
          <input type="password" name="password" placeholder="password" required />
          <button type="submit">login</button>
        </form>
        <p style="font-size:0.875rem;margin-top:1rem;">
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
  return (c as any).render(
    <>
      <section>{User(usr, name)}</section>
      <section>
        <form method="post" action="/u">
          <textarea name="bio" rows={6} placeholder="bio">
            {usr.bio}
          </textarea>
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

const notifQuery = (name: string, orgs_r: string[]) => sql`
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
  return (c as any).render(
    <>
      <section>
        <h2>notifications</h2>
        <p style="font-size:0.75rem;opacity:0.6;margin:0.25rem 0 1rem 0;">mentions and replies. unread items are highlighted.</p>
      </section>
      <section>
        {items.length === 0
          ? <p style="opacity:0.6;">no notifications yet.</p>
          : items.map((i: any) => (
            <div
              key={i.cid}
              style={`border-left: 3px solid ${i.unread ? "currentColor" : "transparent"}; padding-left: 0.5rem; margin-bottom: 0.5rem;`}
            >
              <div style="font-size:0.75rem;opacity:0.6;">{i.kind}</div>
              {Comment(i, name)}
            </div>
          ))}
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
    latest: rows.map((r: any) => ({
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
      return (c as any).render(<section>{User(usr, viewerName)}</section>, { title: usr.name });
  }
});

app.get("/o/new", authed, (c) =>
  (c as any).render(
    <section>
      <h2>
        <span style="margin-right: 0.5rem;">▢</span>create an organization
      </h2>
      <p style="font-size: 0.875rem; opacity: 0.8; line-height: 1.5; margin: 1rem 0 0.5rem 0;">
        create a private organization for your team. access control is managed via the <code>*org</code> tag.
      </p>
      <p style="font-size: 0.875rem; opacity: 0.8; margin-bottom: 1.5rem;">cost: $1/member/month.</p>
      <form method="post" action="/o/new" style="padding: 0;">
        <div style="display:flex; gap:0.5rem; align-items:center;">
          <input
            required
            pattern="^[0-9a-zA-Z_]{4,32}$"
            name="name"
            placeholder="org_name"
            style="flex: 1; max-width: 300px; padding: 0.25rem 0.5rem; border-radius: 5px; border: 1px solid currentColor;"
          />
          <button type="submit">create & subscribe</button>
        </div>
      </form>
      <p style="font-size: 0.75rem; opacity: 0.5; margin-top: 2rem;">
        <a href="/u">← back to account</a>
      </p>
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
    sql`select * from org where name = ${c.req.param("name")}`.then((r: any) => r[0]),
    sql`select true from usr where true and name = ${c.get("name") ?? ""} and ${c.req.param("name")} = any(orgs_r)`
      .then((r: any) => r[0]),
    sql`select name from usr where ${c.req.param("name")} = any(orgs_r)`,
  ]);
  if (!org) return notFound();
  if (!hasAccess) throw new HTTPException(403, { message: "Access denied" });

  const viewer = c.get("name") ?? "";
  return (c as any).render(
    <section>
      <h2>*{org.name}</h2>
      <p style="font-size: 0.875rem; opacity: 0.5; margin: 0.5rem 0 1.5rem 0;">
        Created by @{org.created_by} on {new Date(org.created_at).toLocaleDateString()}.
      </p>
      <div style="display: flex; flex-direction: column; gap: 2rem;">
        <div>
          <h3 style="font-size: 0.875rem; font-weight: bold; margin-bottom: 0.5rem; opacity: 0.8;">
            members ({members.length})
          </h3>
          <div style="display: flex; flex-direction: column; gap: 0.5rem;">
            {members.map((m: any) => (
              <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.875rem;">
                <a href={`/u/${m.name}`}>@{m.name}</a>
                {org.created_by === viewer && m.name !== viewer && (
                  <form
                    method="post"
                    action={`/o/${org.name}/remove`}
                    style="display:inline; padding: 0; width: auto;"
                  >
                    <input type="hidden" name="name" value={m.name} />
                    <button
                      type="submit"
                      style="font-size:0.75rem; padding: 0.1rem 0.4rem; opacity: 0.6; border: 1px solid currentColor; background: none; border-radius: 4px;"
                    >
                      remove
                    </button>
                  </form>
                )}
                {m.name === viewer && org.created_by !== viewer && (
                  <form
                    method="post"
                    action={`/o/${org.name}/remove`}
                    style="display:inline; padding: 0; width: auto;"
                  >
                    <input type="hidden" name="name" value={viewer} />
                    <button
                      type="submit"
                      style="font-size:0.75rem; padding: 0.1rem 0.4rem; opacity: 0.6; border: 1px solid currentColor; background: none; border-radius: 4px;"
                    >
                      leave
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </div>
        {org.created_by === viewer && (
          <div style="border-top: 1px solid rgba(128,128,128,0.2); padding-top: 1.5rem;">
            <h3 style="font-size: 0.875rem; font-weight: bold; margin-bottom: 0.5rem; opacity: 0.8;">
              invite member
            </h3>
            <form
              method="post"
              action={`/o/${org.name}/invite`}
              style="padding: 0; display: flex; flex-direction: row; gap: 0.5rem;"
            >
              <input
                required
                type="email"
                name="email"
                placeholder="email"
                style="flex: 1; max-width: 240px; padding: 0.25rem 0.5rem; border-radius: 5px; border: 1px solid currentColor;"
              />
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
    sql`select * from org where name = ${c.req.param("name")}`.then((r: any) => r[0]),
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
    if (existing) {
      await sql`update usr set orgs_r = array_append(orgs_r, ${org.name}), orgs_w = array_append(orgs_w, ${org.name}) where name = ${existing.name}`;
    } else {
      const newName = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      await sql`insert into usr (name, email, bio, invited_by, orgs_r, orgs_w) values (${newName}, ${email}, '...', ${c.get(
        "name",
      )!}, ${[org.name]}, ${[org.name]})`;
      sendVerificationEmail(email, await emailToken(new Date(), email));
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
    sql`select * from org where name = ${c.req.param("name")}`.then((r: any) => r[0]),
    form(c),
  ]);
  if (!org) return notFound();
  const viewer = c.get("name");
  const isOwner = org.created_by === viewer;
  const isSelfLeave = paramName === viewer;
  if (isOwner && isSelfLeave) throw new HTTPException(400, { message: "Owner cannot leave their own org — transfer or delete it first" });
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
      `DRIFT remove: decremented ${org.stripe_sub_id} to qty=${qty - 1} but SQL update for ${paramName} in ${org.name} failed.`,
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
      await sql.begin(async (sql: any) => {
        // @ts-ignore: postgres.js transaction types
        await sql`update usr set orgs_r = array_remove(orgs_r, ${org.name}), orgs_w = array_remove(orgs_w, ${org.name})`;
        // @ts-ignore: postgres.js transaction types
        await sql`delete from org where name = ${org.name}`;
      });
    }
  }
  return c.text("Received", 200);
});

app.get("/c/:cid/delete", authed, async (c) => {
  const [cm] = await sql`select body from com where cid = ${c.req.param("cid")} and created_by = ${c.get("name")!}`;
  if (!cm) return notFound();
  return (c as any).render(
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
  let n = c.get("name");
  if (!n) {
    const a = c.req.header("Authorization");
    if (a?.startsWith("Basic ")) {
      try {
        const decoded = atob(a.slice(6));
        const [u, ...rest] = decoded.split(":");
        const p = rest.join(":");
        const [usr] =
          await sql`select name from usr where (email=${u} or name=${u}) and password=crypt(${p}, password)`;
        if (usr) n = usr.name;
      } catch { /* ignore invalid auth */ }
    }
  }
  if (!n) return c.redirect(`/u?next=${encodeURIComponent(pid ? `/c/${pid}` : "/")}`);

  const now = Date.now();
  for (const [k, ts] of postRate) {
    const fresh = ts.filter((t) => now - t < POST_RATE_MS);
    if (fresh.length) postRate.set(k, fresh);
    else postRate.delete(k);
  }
  const times = postRate.get(n) ?? [];
  if (times.length >= POST_RATE_MAX) throw new HTTPException(429, { message: "Slow down" });
  times.push(now);
  postRate.set(n, times);

  const f = await c.req.formData(),
    b = f.get("body")?.toString() || "",
    [usr] = await sql`select orgs_w, orgs_r from usr where name = ${n}`;
  let tags: string[], orgs: string[], usrs: string[], prm: any = null;

  if (pid) {
    [prm] = await sql`select tags, orgs, usrs, created_by, parent_cid as prm_parent, domain from com where cid = ${pid}`;
    if (!prm || !prm.orgs.every((t: any) => usr.orgs_r.includes(t)) || (prm.usrs.length && !prm.usrs.includes(n)))
      throw new HTTPException(403);
    tags = prm.tags;
    orgs = prm.orgs;
    usrs = prm.usrs;

    if (isReaction(b)) {
      if (prm.created_by === n)
        return c.redirect((prm.prm_parent ? `/c/${prm.prm_parent}#${pid}` : `/c/${pid}`) + "?err=self-react");
      const [existing] = await sql`select cid from com where parent_cid = ${pid} and created_by = ${n} and body = ${b} and char_length(body) = 1 limit 1`;
      if (existing) {
        await sql.begin((tx: any) => Promise.all([
          tx`delete from com where cid = ${existing.cid}`,
          tx`update com set c_reactions = c_reactions || hstore(${b}, greatest(coalesce((c_reactions->${b})::int,0)-1, 0)::text) where cid = ${pid}`,
        ]));
        await refreshScores({ pid, author: prm.created_by, tags: prm.tags, domain: prm.domain });
        return c.redirect(prm.prm_parent ? `/c/${prm.prm_parent}#${pid}` : `/c/${pid}`);
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
  const thumb = pid
    ? null
    : (extractImageUrl(b) || (extractFirstUrl(b) ? await resolveThumbnail(extractFirstUrl(b)!) : null));
  const domain = pid ? null : extractDomain(b);
  const [cm] =
    await sql`insert into com (parent_cid, created_by, body, tags, orgs, usrs, links, thumb, domain) values (${pid}, ${n}, ${b}, ${tags}, ${orgs}, ${usrs}, ${links}, ${thumb}, ${domain}) returning cid`;

  if (pid) {
    if (isReaction(b))
      await sql`update com set c_reactions = c_reactions || hstore(${b}, (coalesce((c_reactions->${b})::int,0)+1)::text) where cid = ${pid}`;
    else await sql`update com set c_comments = c_comments + 1 where cid = ${pid}`;
    if (isReaction(b))
      await refreshScores({ pid, author: prm.created_by, tags: prm.tags, domain: prm.domain });
  } else {
    await refreshScores({ pid: cm.cid, author: n, tags, domain });
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
    select c.*, (select count(*) from com c_ where c_.parent_cid = c.cid) as comments,
      (select count(*) from com r where r.parent_cid = c.cid and char_length(r.body) = 1) as reaction_count,
      (select coalesce(jsonb_object_agg(body, cnt), '{}') from (select body, count(*) as cnt from com where parent_cid = c.cid and char_length(body) = 1 group by body) r) as reaction_counts,
      array(select body from com where parent_cid = c.cid and char_length(body) = 1 and created_by = ${
    n || ""
  }) as user_reactions,
      array(select jsonb_build_object('body', body, 'created_by', created_by, 'cid', cid, 'created_at', created_at, 'tags', tags, 'orgs', orgs, 'usrs', usrs, 'c_flags', c_flags) from com where parent_cid = c.cid and char_length(body) > 1 order by created_at desc) as child_comments
    from com c where ${
    cid
      ? sql`cid = ${cid}`
      : (q.reactions || q.replies_to || q.comments ? sql`parent_cid is not null` : sql`parent_cid is null`)
  }
    ${usrs.length ? sql`and created_by = any(${usrs}::citext[])` : sql``}
    and tags @> ${tags}::text[] and orgs <@ ${rT}::text[] and (usrs = '{}' or ${n || ""}::text = any(usrs))
    ${orgs.length ? sql`and orgs && ${orgs}::text[]` : sql``}
    ${mens.length ? sql`and usrs && ${mens}::text[]` : sql``}
    ${www.length ? sql`and body ~* ${www.join("|")}` : sql``}
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
        items.map((i: any) =>
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
      ? ((await sql`select count(*)::int as count from com where ${singleTag} = any(tags) and orgs <@ ${rT}::text[] and (usrs = '{}' or ${n || ""}::text = any(usrs))`)[0].count)
      : null;
    const orgInfo = singleOrg
      ? (await sql`select (select count(*)::int from usr where ${singleOrg} = any(orgs_r)) as member_count, (select created_by from org where name = ${singleOrg}) as created_by`)[0]
      : null;
    const orgMembers = orgInfo?.member_count ?? null;
    const orgCreatedBy = orgInfo?.created_by ?? null;
    const usrRow = singleUsr
      ? (await sql`select u.name, u.bio, (select count(*)::int from com where created_by = ${singleUsr} and parent_cid is null and orgs <@ ${rT}::text[]) as post_count from usr u where u.name = ${singleUsr}`)[0]
      : null;
    const usrPostCount = usrRow?.post_count ?? null;
    return (c as any).render(
      <>
        <section>
          <form id="search-form" method="get" action="/c" style="display:flex;gap:0.5rem;">
            <input name="search" value={decodeLabels(cur)} style="width:100%;" />
            <button type="submit">search</button>
          </form>
          <ActiveFilters params={cur} />
          {singleTag && (
            <div style="margin:1rem 0;">
              <h2 style="margin:0;">#{singleTag}</h2>
              <p style="font-size:0.875rem;opacity:0.6;margin:0.25rem 0;">{tagCount} post{tagCount === 1 ? "" : "s"}</p>
              <p style="font-size:0.75rem;opacity:0.5;margin:0.25rem 0 0 0;">
                <a href={`/?tag=${singleTag}`}>post to #{singleTag}</a>
              </p>
            </div>
          )}
          {singleOrg && (
            <div style="margin:1rem 0;">
              <h2 style="margin:0;">*{singleOrg}</h2>
              <p style="font-size:0.875rem;opacity:0.6;margin:0.25rem 0;">
                {orgMembers} member{orgMembers === 1 ? "" : "s"}
                {orgCreatedBy && (
                  <>
                    {" · "}created by <a href={`/u/${orgCreatedBy}`}>@{orgCreatedBy}</a>
                    {" · "}<a href={`/o/${singleOrg}`}>settings</a>
                  </>
                )}
              </p>
              <p style="font-size:0.75rem;opacity:0.5;margin:0.25rem 0 0 0;">
                <a href={`/?org=${singleOrg}`}>post to *{singleOrg}</a>
              </p>
            </div>
          )}
          {singleUsr && usrRow && (
            <div style="margin:1rem 0;">
              <h2 style="margin:0;">@{singleUsr}</h2>
              <p style="font-size:0.875rem;opacity:0.6;margin:0.25rem 0;">
                {usrPostCount} post{usrPostCount === 1 ? "" : "s"}{" · "}
                <a href={`/u/${singleUsr}`}>profile</a>
              </p>
              <p style="font-size:0.75rem;opacity:0.5;margin:0.25rem 0 0 0;">
                <a href={`/?usr=${singleUsr}`}>post to @{singleUsr}</a>
              </p>
            </div>
          )}
          {!singleTag && !singleOrg && !singleUsr && meta && <h2>{meta}</h2>}
          <SortToggle sort={s} baseHref={`/c?${cur}`} title="results" />
        </section>
        <section>
          <div class="posts">{items.map((i: any) => Post(i, n, cur))}</div>
        </section>
        <section>
          <div style="margin-top:2rem;">
            {p > 0 && <a href={`/c?${new URLSearchParams([...cur.entries(), ["p", (p - 1).toString()]])}`}>prev</a>}
            {items.length === lim && (
              <a href={`/c?${new URLSearchParams([...cur.entries(), ["p", (p + 1).toString()]])}`}>next</a>
            )}
          </div>
        </section>
      </>,
      { title: meta || "search" },
    );
  }

  const post = items[0];
  if (!post) return notFound();
  const backlinks = await sql`select cid, body, created_at from com where parent_cid is null and ${post.cid} = any(links) and orgs <@ ${rT}::text[] and (usrs = '{}' or ${n || ""}::text = any(usrs)) order by created_at desc limit 5`;
  return (c as any).render(
    <>
      {q.err === "self-react" && <section><p style="color:#c44;margin:0;">you cannot react to your own post</p></section>}
      <section>
        {Comment({ ...post, child_comments: (post.child_comments || []).filter((r: any) => isReaction(r.body)) }, n)}
      </section>
      <section>
        {n
          ? (
            <form method="post" action={`/c/${post.cid}`}>
              <textarea required name="body" rows={18}></textarea>
              <button type="submit">reply</button>
            </form>
          )
          : (
            <div style="display:flex;flex-direction:column;gap:0.5rem;">
              <p style="margin:0;font-size:0.875rem;opacity:0.8;">create an account to reply</p>
              <form method="post" action="/signup" style="display:flex;flex-direction:column;gap:0.5rem;">
                <input required name="name" type="text" pattern="^[0-9a-zA-Z_]{4,32}$" placeholder="username" />
                <input required name="email" type="email" placeholder="email" />
                <button type="submit">sign up</button>
              </form>
              <p style="margin:0;font-size:0.75rem;opacity:0.6;">
                already have an account? <a href={`/u?next=${encodeURIComponent(`/c/${post.cid}`)}`}>log in</a>
              </p>
            </div>
          )}
        <SortToggle sort={s} baseHref={`/c/${cid}`} title="comments" />
      </section>
      <section>
        {(post.child_comments || []).filter((r: any) => !isReaction(r.body)).map((r: any) => Comment(r, n))}
      </section>
      {backlinks.length > 0 && (
        <section>
          <h3 style="margin:0 0 0.5rem 0;font-size:0.875rem;opacity:0.6;">backlinks</h3>
          {backlinks.map((bl: any) => (
            <div key={bl.cid} style="margin:0.25rem 0;">
              <a href={`/c/${bl.cid}`}>{bl.body.trim().split("\n")[0].slice(0, 60)}</a>
            </div>
          ))}
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
  return new Response(res.body, { headers: { "Content-Type": ct, "Cache-Control": "public, max-age=604800, immutable" } });
});

app.use("/*", serveStatic({ root: "./public" }));
export default app;
