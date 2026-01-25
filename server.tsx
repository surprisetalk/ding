//// IMPORTS ///////////////////////////////////////////////////////////////////

import { HTTPException } from "jsr:@hono/hono/http-exception";
import { Context, Hono } from "jsr:@hono/hono";
import { every, except, some } from "jsr:@hono/hono/combine";
import { createMiddleware } from "jsr:@hono/hono/factory";
import { logger } from "jsr:@hono/hono/logger";
import { prettyJSON } from "jsr:@hono/hono/pretty-json";
import { basicAuth } from "jsr:@hono/hono/basic-auth";
import { html } from "jsr:@hono/hono/html";
import { deleteCookie, getSignedCookie, setSignedCookie } from "jsr:@hono/hono/cookie";
import { serveStatic } from "jsr:@hono/hono/deno";

import pg from "https://deno.land/x/postgresjs@v3.4.8/mod.js";

import sg from "npm:@sendgrid/mail";

declare module "jsr:@hono/hono" {
  interface ContextRenderer {
    (content: string | Promise<string>, props?: { title?: string }): Response | Promise<Response>;
  }
}

//// CONSTANTS /////////////////////////////////////////////////////////////////

const MAX_POSTS_PER_DAY = 1000;

//// HELPERS ///////////////////////////////////////////////////////////////////

const TODO = (x: TemplateStringsArray) => {
  throw new Error(`TODO: ${x.raw.join("")}`);
};

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const extractFirstUrl = (body: string): string | null => body.match(/https?:\/\/[^\s]+/)?.[0] || null;

const resolveThumbnail = async (url: string): Promise<string> => {
  // 1. Try og:image extraction
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "ding/1.0" },
      signal: AbortSignal.timeout(3000),
    });
    const html = await res.text();
    const og = html.match(/<meta[^>]+(?:property="og:image"|name="twitter:image")[^>]+content="([^"]+)"/i)?.[1];
    if (og) return og;
  } catch { /* fall through to favicon */ }

  // 2. Favicon fallback via Google's service
  const domain = new URL(url).hostname;
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
};

//// LABEL PARSING /////////////////////////////////////////////////////////////

export type Labels = {
  tag: string[]; // from # (public labels)
  org: string[]; // from * (org/private labels)
  usr: string[]; // from @ (user labels)
  www: string[]; // from ~ (domain filter, search only)
  text: string; // remaining free text
};

// Parse search input → Labels
export const parseLabels = (input: string): Labels => {
  const tokens = input.split(/\s+/).filter(Boolean);
  return {
    tag: tokens.filter((t) => t.startsWith("#")).map((t) => t.slice(1).toLowerCase()),
    org: tokens.filter((t) => t.startsWith("*")).map((t) => t.slice(1).toLowerCase()),
    usr: tokens.filter((t) => t.startsWith("@")).map((t) => t.slice(1)),
    www: tokens.filter((t) => t.startsWith("~")).map((t) => t.slice(1).toLowerCase()),
    text: tokens.filter((t) => !/^[#*@~]/.test(t)).join(" "),
  };
};

// Labels → URLSearchParams
export const encodeLabels = (labels: Labels): URLSearchParams => {
  const params = new URLSearchParams();
  for (const tag of labels.tag) params.append("tag", tag);
  for (const org of labels.org) params.append("org", org);
  for (const usr of labels.usr) params.append("usr", usr);
  for (const www of labels.www) params.append("www", www);
  if (labels.text) params.set("q", labels.text);
  return params;
};

// URLSearchParams → search input string
export const decodeLabels = (params: URLSearchParams): string => {
  const parts: string[] = [];
  for (const tag of params.getAll("tag")) parts.push(`#${tag}`);
  for (const org of params.getAll("org")) parts.push(`*${org}`);
  for (const usr of params.getAll("usr")) parts.push(`@${usr}`);
  for (const www of params.getAll("www")) parts.push(`~${www}`);
  const q = params.get("q");
  if (q) parts.push(q);
  return parts.join(" ");
};

// Database record → display strings (for UI)
export const formatLabels = (c: Record<string, any>): string[] => [
  ...(c.tags ?? []).map((t: string) => `#${t}`),
  ...(c.orgs ?? []).map((t: string) => `*${t}`),
  ...(c.usrs ?? []).map((t: string) => `@${t}`),
];

//// EMAIL TOKEN ///////////////////////////////////////////////////////////////

const EMAIL_TOKEN_SECRET = Deno.env.get("EMAIL_TOKEN_SECRET") ?? Math.random().toString();

async function emailToken(ts: Date, email: string): Promise<string> {
  const epoch = Math.floor(ts.getTime() / 1000);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(EMAIL_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${epoch}:${email}`));
  const hash = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32); // Match md5 length for compatibility
  return `${epoch}:${hash}`;
}

function parseTokenTimestamp(token: string): Date | null {
  const epochStr = token.split(":")[0];
  const epoch = parseInt(epochStr, 10);
  if (isNaN(epoch)) return null;
  return new Date(epoch * 1000);
}

async function validateEmailToken(
  token: string,
  email: string,
  maxAgeMs: number = 2 * 24 * 60 * 60 * 1000,
): Promise<boolean> {
  const ts = parseTokenTimestamp(token);
  if (!ts) return false;
  if (Date.now() - ts.getTime() > maxAgeMs) return false;
  const expected = await emailToken(ts, email);
  return token === expected;
}

//// POSTGRES //////////////////////////////////////////////////////////////////

export let sql = pg(Deno.env.get(`DATABASE_URL`)?.replace(/flycast/, "internal")!, { database: "ding" });
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
      console.log(`/password?email=${email}&token=${token}`);
      console.error(`Could not send verification email to ${email}:`, err?.response?.body || err);
    }));

//// COMPONENTS ////////////////////////////////////////////////////////////////

const User = (u: Record<string, any>, viewerName?: string, recentTags?: Record<string, any>[]) => {
  const isOwner = viewerName && viewerName == u.name;
  return (
    <div class="user">
      <div>
        <span>{u.name}</span>
        {u.name !== u.invited_by || <a href={`/u/${u.invited_by}`}>@{u.invited_by}</a>}
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
      {isOwner && recentTags && recentTags.length > 0 && (
        <div>
          {recentTags.map((t) => {
            const label = t.tag as string;
            const prefix = label[0];
            const name = label.slice(1);
            if (prefix === "@") return <a href={`/c?usr=${name}`}>{label}</a>;
            if (prefix === "*") return <a href={`/c?org=${name}`}>{label}</a>;
            return <a href={`/c?tag=${name}`}>{label}</a>;
          })}
        </div>
      )}
      <div>
        <pre>{u.bio}</pre>
      </div>
    </div>
  );
};

const isReaction = (body: string): boolean => !!body && [...body].length === 1; // Single grapheme (handles emoji)

const SortToggle = ({ sort, baseHref, title }: { sort: string; baseHref: string; title: string }) => {
  const base = new URL(baseHref, "http://x");
  const newParams = new URLSearchParams(base.search);
  newParams.delete("sort");
  newParams.delete("p");
  const topParams = new URLSearchParams(base.search);
  topParams.set("sort", "top");
  topParams.delete("p");
  return (
    <nav style="margin-bottom:0.5rem;display:flex;gap:0.5rem;align-items:baseline;justify-content:space-between;text-wrap:nowrap;">
      <span>
        {title}
      </span>
      <span style="text-overflow:hidden;overflow:hidden;opacity:0.5;">
        {". ".repeat(100)}
      </span>
      <span style="font-size:0.85rem;">
        {sort === "new" ? "new" : <a href={`${base.pathname}?${newParams}`}>new</a>}
        {" • "}
        {sort === "top" ? "top" : <a href={`${base.pathname}?${topParams}`}>top</a>}
      </span>
    </nav>
  );
};

const Reactions = (c: Record<string, any>) => {
  const counts: Record<string, number> = { "▲": 0, "▼": 0, ...(c.reaction_counts ?? {}) };
  const userReactions: string[] = c.user_reactions ?? [];
  return Object.entries(counts).map(([char, count]) => (
    <form method="post" action={`/c/${c.cid}`} class={`reaction${userReactions.includes(char) ? " reacted" : ""}`}>
      <input type="hidden" name="body" value={char} />
      <button type="submit">{char} {count}</button>
    </form>
  ));
};

const Comment = (c: Record<string, any>, viewerName?: string) => {
  return (
    <div class="comment" id={c.cid}>
      <div>
        {!c.created_at || <a href={`/c/${c.cid}`}>{new Date(c.created_at).toLocaleDateString()}</a>}
        {!c.parent_cid || <a href={`/c/${c.parent_cid}`}>parent</a>}
        <a href={`/u/${c.created_by}`}>@{c.created_by ?? "unknown"}</a>
        {c.body !== "" && viewerName && c.created_by == viewerName && <a href={`/c/${c.cid}/delete`}>delete</a>}
        <a href={`/c/${c.cid}`}>reply</a>
        {formatLabels(c).map((label: string) => {
          const prefix = label[0];
          const labelName = label.slice(1);
          const param = prefix === "*" ? "org" : prefix === "@" ? "usr" : "tag";
          return <a href={`/c?${param}=${labelName}`}>{label}</a>;
        })}
        {Reactions(c)}
      </div>
      <pre>{c.body === "" ? "[deleted by author]" : c.body}</pre>
      <div style="padding-left: 1rem;">
        {c?.child_comments?.map((child: Record<string, any>) => Comment(child, viewerName))}
      </div>
    </div>
  );
};

const defaultThumb =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3Crect fill='%23222' width='1' height='1'/%3E%3C/svg%3E";

const Post = (c: Record<string, any>, viewerName?: string) => (
  <>
    <img
      src={c.thumb || defaultThumb}
      loading="lazy"
      onerror={`this.onerror=null;this.src='${defaultThumb}'`}
    />
    <div class="post-content">
      <span>
        <a href={`/c/${c.cid}`}>
          {c.body === ""
            ? "[deleted by author]"
            : `${c.body.trim().replace(/[\r\n\t].+$/, "").slice(0, 60)}${c.body.length > 60 ? "…" : ""}`.padEnd(
              40,
              " .",
            )}
        </a>
      </span>
      <div>
        <a href={`/c/${c.cid}`}>{new Date(c.created_at).toLocaleDateString()}</a>
        {!c.parent_cid || <a href={`/c/${c.parent_cid}`}>parent</a>}
        <a href={`/u/${c.created_by}`}>@{c.created_by}</a>
        {c.body !== "" && viewerName && c.created_by == viewerName && <a href={`/c/${c.cid}/delete`}>delete</a>}
        <a href={`/c/${c.cid}`}>reply</a>
        {formatLabels(c).map((label: string) => {
          const prefix = label[0];
          const labelName = label.slice(1);
          const param = prefix === "*" ? "org" : prefix === "@" ? "usr" : "tag";
          return <a href={`/c?${param}=${labelName}`}>{label}</a>;
        })}
        {Reactions(c)}
      </div>
    </div>
  </>
);

//// HONO //////////////////////////////////////////////////////////////////////

const cookieSecret = Deno.env.get("COOKIE_SECRET") ?? Math.random().toString();

const notFound = () => {
  throw new HTTPException(404, { message: "Not found." });
};

const form = async (c: Context): Promise<Record<string, string>> =>
  Object.fromEntries([...(await c.req.formData()).entries()].map(([k, v]) => [k, v.toString()]));

const host = (c: Context): string | undefined => {
  const h = c.req.header("host")?.match(/^(?:https?:\/\/)?(?:www\.)?([^\/]+)\.([^\/]+)\./)?.[1];
  if (h) return h;
  if (c.req.header("accept")?.includes("application/json")) return "api";
  if (c.req.header("accept")?.includes("text/html")) return;
  if (c.req.header("accept")?.includes("application/xml")) return "rss";
  if (c.req.header("content-type")?.includes("application/json")) return "api";
  if (c.req.header("content-type")?.includes("multipart/form-data")) return;
};

const ok = (c: Context) => {
  switch (host(c)) {
    case "api":
      return c.json(null, 204);
    default:
      return c.redirect("/u");
  }
};

const authed = some(
  createMiddleware(async (c, next) => {
    const name = await getSignedCookie(c, cookieSecret, "name");
    if (!name) throw new HTTPException(401, { message: "Not authorized." });
    c.set("name", name);
    await next();
  }),
  basicAuth({
    verifyUser: async (email, password, c) => {
      const [usr] = await sql`
        select *, password = crypt(${password}, password) AS is_password_correct
        from usr where email = ${email} or name = ${email}
      `;
      if (!usr || !usr.is_password_correct) return false;
      await setSignedCookie(c, "name", usr.name, cookieSecret);
      c.set("name", usr.name);
      return true;
    },
  }),
);

// TODO: Add rate-limiting middleware everywhere.
const app = new Hono<{ Variables: { name?: string } }>();

app.use("*", async (c, next) => {
  console.log(c.req.method, c.req.url);
  await next();
});

app.use(logger());
app.use(async function prettyJSON(c, next) {
  await next();
  if (c.res.headers.get("Content-Type")?.startsWith("application/json")) {
    const obj = await c.res.json();
    c.res = new Response(JSON.stringify(obj, null, 2), c.res);
  }
});

app.notFound(notFound);

app.get("/robots.txt", (c) => c.text(`User-agent: *\nDisallow:`));

app.get("/sitemap.txt", (c) => c.text("https://ding.bar/"));

app.use("*", async (c, next) => {
  const name = await getSignedCookie(c, cookieSecret, "name");
  if (name)
    c.set("name", name);
  c.setRenderer((content, props) => {
    return c.html(
      html`
        <!DOCTYPE html>
        <html>
          <head>
            <title>${props?.title ? `ding | ${props?.title}` : "ding"}</title>
            <meta charset="UTF-8" />
            <meta name="color-scheme" content="light dark" />
            <meta name="author" content="Taylor Troesh" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <link rel="icon" sizes="16x16" href="/favicon-16x16.png" />
            <link rel="icon" sizes="32x32" href="/favicon-32x32.png" />
            <link rel="icon" sizes="192x192" href="/android-chrome-192x192.png" />
            <link rel="icon" sizes="512x512" href="/android-chrome-512x512.png" />
            <link rel="icon" href="/favicon.ico" type="image/x-icon" />
            <link rel="shortcut icon" href="/favicon.ico" type="image/x-icon" />
            <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
            <link rel="manifest" href="/manifest.json" />
            <link rel="stylesheet" href="/style.css" />
          </head>
          <body>
            <header>
              <section>
                <a href="/" style="letter-spacing:10px;font-weight:700;width:100%;">▢ding</a>
                <a href="/u" style="letter-spacing:2px;font-size:0.875rem;opacity:0.8;">
                  ${c.get("name") ? `@${c.get("name")}` : "account"}
                </a>
                <a href="/c/379" style="letter-spacing:2px;font-size:0.875rem;opacity:0.8;">
                  help
                </a>
              </section>
            </header>
            <main>${content}</main>
            <footer></footer>
            <script>
            for (const x of document.querySelectorAll("pre")) x.innerHTML = x.innerHTML.replace(/(https?:\\/\\/\\S+)/g,
            '<a href="$1">$1</a>');
            const presets = document.querySelector('.tag-presets');
            if (presets) {
              presets.style.display = 'flex';
              for (const btn of presets.querySelectorAll('.tag-preset')) {
                btn.onclick = () => {
                  const input = document.querySelector('input[name="tags"]');
                  const tag = btn.dataset.tag;
                  if (!input.value.split(/\\s+/).includes(tag)) {
                    input.value = input.value.trim() ? input.value.trim() + ' ' + tag : tag;
                  }
                  input.focus();
                };
              }
            }
            const searchForm = document.getElementById('search-form');
            if (searchForm) {
              searchForm.onsubmit = (e) => {
                e.preventDefault();
                const input = searchForm.querySelector('input[name="search"]');
                const tokens = input.value.split(/\\s+/).filter(Boolean);
                const params = new URLSearchParams();
                for (const t of tokens) {
                  if (t.startsWith('#')) params.append('tag', t.slice(1).toLowerCase());
                  else if (t.startsWith('*')) params.append('org', t.slice(1).toLowerCase());
                  else if (t.startsWith('@')) params.append('usr', t.slice(1));
                  else if (t.startsWith('~')) params.append('www', t.slice(1).toLowerCase());
                  else {
                    const q = params.get('q');
                    params.set('q', q ? q + ' ' + t : t);
                  }
                }
                window.location.href = '/c?' + params.toString();
              };
            }
            </script>
          </body>
        </html>
      `,
    );
  });
  await next();
});

app.onError((err, c) => {
  if (err instanceof HTTPException)
    return err.getResponse();
  if (err) console.error(err);
  const message = "Sorry, this computer is мᎥｓβ𝕖𝓱𝐀𝓋𝓲𝓷g.";
  switch (host(c)) {
    case "api":
      return c.json({ error: message }, 500);
    case "rss":
      return c.text(message, 500);
    default:
      c.status(500);
      return c.render(
        <section>
          <p>{message}</p>
        </section>,
        { title: "error" },
      );
  }
});

app.get("/", async (c) => {
  const p = parseInt(c.req.query("p") ?? "0");
  const sort = c.req.query("sort") === "top" ? "top" : "new";
  const name = c.get("name");
  // Get user's private tag permissions (empty if not logged in)
  const [viewer] = name ? await sql`select orgs_r, orgs_w from usr where name = ${name}` : [{ orgs_r: [], orgs_w: [] }];
  const userOrgsR = viewer?.orgs_r ?? [];
  // Get preset tags: user's writable private tags, then tags from their posts, then popular platform tags
  const presetTags = await sql`
    select distinct on (tag) tag from (
      select '*' || unnest(${viewer?.orgs_w ?? []}::text[]) as tag, 1 as pri
      union all
      select '#' || unnest(tags), 2 from com where created_by = ${name ?? ""} and parent_cid is null
      union all
      select '*' || unnest(orgs), 2 from com where created_by = ${name ?? ""} and parent_cid is null
      union all
      select '@' || unnest(usrs), 2 from com where created_by = ${name ?? ""} and parent_cid is null
      union all
      select '#' || unnest(tags), 3 from com where parent_cid is null
    ) t order by tag, pri limit 20
  `;
  const comments = await sql`
    select
      c.cid,
      c.created_by,
      c.body,
      c.thumb,
      c.tags,
      c.orgs,
      c.usrs,
      c.created_at,
      (select count(*) from com c_ where c_.parent_cid = c.cid) as comments,
      (select count(*) from com r where r.parent_cid = c.cid and char_length(r.body) = 1) as reaction_count,
      (
        select coalesce(jsonb_object_agg(body, cnt), '{}')
        from (select body, count(*) as cnt from com where parent_cid = c.cid and char_length(body) = 1 group by body) r
      ) as reaction_counts,
      array(
        select body from com where parent_cid = c.cid and char_length(body) = 1 and created_by = ${name ?? ""}
      ) as user_reactions,
      array(
        select jsonb_build_object(
          'body', c_.body,
          'created_by', c_.created_by,
          'cid', c_.cid,
          'created_at', c_.created_at
        )
        from com c_
        where c_.parent_cid = c.cid and char_length(c_.body) > 1
        order by c_.created_at desc
      ) as child_comments
    from com c
    where parent_cid is null
      and c.orgs <@ ${userOrgsR}::text[]
      and (c.usrs = '{}' or ${name ?? ""}::text = any(c.usrs))
    ${sort === "top" ? sql`order by reaction_count desc, c.created_at desc` : sql`order by c.created_at desc`}
    offset ${p * 25}
    limit 25
  `;
  // Prepopulate tags input from query params
  const initialTags = [
    ...(c.req.queries("tag") ?? []).map((t) => `#${t}`),
    ...(c.req.queries("org") ?? []).map((t) => `*${t}`),
    ...(c.req.queries("usr") ?? []).map((t) => `@${t}`),
  ].join(" ");
  return c.render(
    <>
      <section>
        <form method="post" action="/c">
          <textarea requried name="body" rows={18} minlength={1} maxlength={1441}></textarea>
          <div style="display:flex;gap:0.5rem;justify-content:flex-end;align-items:center;">
            <input
              type="text"
              name="tags"
              value={initialTags}
              placeholder="#linking #thinking *private @user"
              style="flex:1;"
            />
            <button>create post</button>
          </div>
          {presetTags.length > 0 && (
            <div class="tag-presets">
              {presetTags.map((t) => <button type="button" class="tag-preset" data-tag={t.tag}>{t.tag}</button>)}
            </div>
          )}
        </form>
      </section>
      <section>
        {!comments.length && (
          <p>
            no posts. <a href="/">go home.</a>
          </p>
        )}
        <div class="posts">{comments.map((cm) => Post(cm, c.get("name")))}</div>
      </section>
      <section>
        <div style="margin-top: 2rem;">
          {!p || <a href={`/?${sort === "top" ? "sort=top&" : ""}p=${p - 1}`}>prev</a>}
          {!comments.length || <a href={`/?${sort === "top" ? "sort=top&" : ""}p=${p + 1}`}>next</a>}
        </div>
      </section>
    </>,
  );
});

app.post("/login", async (c) => {
  const { email, password } = await form(c);
  const [usr] = await sql`
    select *, password = crypt(${password}, password) AS is_password_correct
    from usr where email = ${email}
  `;
  if (!usr || !usr.is_password_correct) throw new HTTPException(401, { message: "Wrong credentials." });
  if (!usr.email_verified_at && !(await getSignedCookie(c, cookieSecret, "name")))
    await sendVerificationEmail(usr.email, usr.token);
  await setSignedCookie(c, "name", usr.name, cookieSecret);
  return c.redirect("/u");
});

app.get("/logout", (c) => {
  deleteCookie(c, "name");
  return c.redirect("/");
});

app.post("/logout", (c) => {
  deleteCookie(c, "name");
  return ok(c);
});

app.get("/verify", async (c) => {
  const email = c.req.query("email") ?? "";
  const token = c.req.query("token") ?? "";
  if (!(await validateEmailToken(token, email)))
    throw new HTTPException(400, { message: "Invalid or expired token." });
  await sql`
    update usr
    set email_verified_at = now()
    where email_verified_at is null
      and email = ${email}
  `;
  return ok(c);
});

app.get("/forgot", (c) => {
  return c.render(
    <section>
      <form method="post" action="/forgot">
        <input required name="email" type="email" placeholder="hello@example.com" />
        <p>
          <button type="submit">send email</button>
        </p>
      </form>
    </section>,
    { title: "welcome" },
  );
});

app.post("/forgot", async (c) => {
  const { email } = await form(c);
  const [usr] = await sql`select email from usr where email = ${email}`;
  if (usr) {
    const token = await emailToken(new Date(), usr.email);
    Deno.env.get(`SENDGRID_API_KEY`) &&
      (await sg
        .send({
          to: email,
          from: "taylor@troe.sh",
          subject: "Reset your password",
          text: `` +
            `Click here to reset your password: ` +
            `https://ding.bar/password` +
            `?email=${encodeURIComponent(email)}` +
            `&token=${encodeURIComponent(token)}` +
            `\n\n` +
            `If you didn't request a password reset, please ignore this message.`,
        })
        .catch((err) => {
          console.log(`/password?email=${email}&token=${token}`);
          console.error(`Could not send password reset email to ${email}:`, err?.response?.body || err);
        }));
  }
  return c.redirect("/");
});

app.get("/password", (c) => {
  const email = c.req.query("email") ?? "";
  const token = c.req.query("token") ?? "";
  return c.render(
    <section>
      <form method="post" action="/password">
        <input required name="token" value={token} type="hidden" readonly />
        <input required name="email" value={email} readonly />
        <input required name="password" type="password" placeholder="password1!" />
        <p>
          <button type="submit">set password</button>
        </p>
      </form>
    </section>,
    { title: "welcome" },
  );
});

app.post("/password", async (c) => {
  const { email, token, password } = await form(c);
  if (!(await validateEmailToken(token, email)))
    throw new HTTPException(400, { message: "Invalid or expired token." });
  const [usr] = await sql`
    update usr
    set password = crypt(${password}, gen_salt('bf', 8)), email_verified_at = coalesce(email_verified_at, now())
    where email = ${email}
    returning name
  `;
  if (usr) await setSignedCookie(c, "name", usr.name, cookieSecret);
  return ok(c);
});

app.post("/invite", authed, async (c) => {
  const usr = {
    name: Math.random().toString().slice(2),
    email: (await form(c)).email,
    bio: "coming soon",
    password: null,
    invited_by: c.get("name")!,
  };
  if ((await sql`select count(*) as "count" from usr where invited_by = ${c.get("name")!}`)?.[0]?.count >= 4)
    throw new HTTPException(400, { message: "No more invites remaining." });
  const [newUsr] = await sql`
    with usr_ as (insert into usr ${sql(usr)} on conflict do nothing returning *)
    select name, email from usr_
  `;
  if (newUsr?.email) {
    const token = await emailToken(new Date(), newUsr.email);
    await sendVerificationEmail(newUsr.email, token);
  }
  return ok(c);
});

// TODO: Remove this when we want to disallow self-signups.
app.get("/signup", async (c) => {
  return c.render(
    <section>
      <form method="post" action="/signup" style="display:flex;flex-direction:row;">
        <input type="text" name="name" placeholder="ivan_grease" />
        <input type="email" name="email" placeholder="hello@example.com" />
        <button>verify email</button>
      </form>
    </section>,
    { title: "your account" },
  );
});

// TODO: Remove this when we want to disallow self-signups.
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
  }
  return c.redirect("/");
});

app.get("/u", authed, async (c) => {
  const name = c.get("name")!;
  const [usr] = await sql`
    select name, email, bio, invited_by, password is not null as password, orgs_r, orgs_w
    from usr where name = ${name}
  `;
  if (!usr) return notFound();
  if (!usr.password) return c.redirect("/password");
  // Recent tags: user's recent interactions, then their permissions, then popular
  const recentTags = await sql`
    select distinct on (tag) tag from (
      select '#' || unnest(tags) as tag, created_at, 1 as pri from com where created_by = ${name}
      union all
      select '*' || unnest(orgs), created_at, 1 from com where created_by = ${name}
      union all
      select '@' || unnest(usrs), created_at, 1 from com where created_by = ${name}
      union all
      select '*' || unnest(${usr.orgs_r ?? []}::text[]), null, 2
      union all
      select '*' || unnest(${usr.orgs_w ?? []}::text[]), null, 2
      union all
      select '#' || unnest(tags), null, 3 from com where parent_cid is null
    ) t order by tag, pri, created_at desc nulls last limit 20
  `;
  return c.render(
    <>
      <section>{User(usr, name, recentTags)}</section>
      <section>
        <form method="post" action="/u">
          <textarea name="bio" rows={6} placeholder="bio">{usr.bio}</textarea>
          <button>save</button>
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

app.get("/u/:name", async (c) => {
  const profileName = c.req.param("name");
  const viewerName = c.get("name");
  const isOwner = viewerName && viewerName == profileName;
  const [usr] = await sql`
    select name, bio, invited_by
      ${isOwner ? sql`, orgs_r, orgs_w` : sql``}
    from usr where name = ${profileName}
  `;
  if (!usr) return notFound();
  // Fetch recent tags only for owner
  const recentTags = isOwner
    ? await sql`
      select distinct on (tag) tag from (
        select '#' || unnest(tags) as tag, created_at, 1 as pri from com where created_by = ${profileName}
        union all
        select '*' || unnest(orgs), created_at, 1 from com where created_by = ${profileName}
        union all
        select '@' || unnest(usrs), created_at, 1 from com where created_by = ${profileName}
        union all
        select '*' || unnest(${usr.orgs_r ?? []}::text[]), null, 2
        union all
        select '*' || unnest(${usr.orgs_w ?? []}::text[]), null, 2
        union all
        select '#' || unnest(tags), null, 3 from com where parent_cid is null
      ) t order by tag, pri, created_at desc nulls last limit 20
    `
    : [];
  switch (host(c)) {
    case "api":
      return c.json(usr, 200);
    default:
      return c.render(<section>{User(usr, viewerName, recentTags)}</section>, { title: usr.name });
  }
});

app.get("/c/:cid/delete", authed, async (c) => {
  const cid = c.req.param("cid");
  const [comment] = await sql`
    select cid, body, parent_cid, created_by
    from com
    where cid = ${cid} and created_by = ${c.get("name")!}
  `;
  if (!comment) throw new HTTPException(404, { message: "Comment not found or not yours." });
  if (comment.body === "") throw new HTTPException(400, { message: "Already deleted." });
  return c.render(
    <section>
      <h2>Delete this post?</h2>
      <pre style="margin: 1rem 0; padding: 1rem; background: var(--bg-secondary, #f5f5f5);">
        {comment.body.length > 200 ? comment.body.slice(0, 200) + "…" : comment.body}
      </pre>
      <p style="opacity: 0.8;">This will show "[deleted by author]" but preserve any replies.</p>
      <form method="post" action={`/c/${cid}/delete`}>
        <div style="display: flex; gap: 1rem;">
          <button type="submit">confirm delete</button>
          <a href={`/c/${cid}`}>cancel</a>
        </div>
      </form>
    </section>,
    { title: "delete" },
  );
});

app.post("/c/:cid/delete", authed, async (c) => {
  const cid = c.req.param("cid");
  const [comment] = await sql`
    update com
    set body = ''
    where cid = ${cid} and created_by = ${c.get("name")!} and body <> ''
    returning parent_cid
  `;
  if (!comment) throw new HTTPException(404, { message: "Comment not found, not yours, or already deleted." });
  return c.redirect(comment.parent_cid ? `/c/${comment.parent_cid}` : "/");
});

app.post("/c/:parent_cid?", authed, async (c) => {
  const formData = await c.req.formData();
  const parent_cid = c.req.param("parent_cid") ?? null;
  const name = c.get("name")!;

  // Get user's write permissions
  const [user] = await sql`select orgs_w from usr where name = ${name}`;
  const userOrgsW = user?.orgs_w ?? [];

  let tags: string[], orgs: string[], usrs: string[];

  if (parent_cid) {
    // Child comment: inherit all tags from parent
    const [parent] = await sql`select tags, orgs, usrs from com where cid = ${parent_cid}`;
    if (!parent) throw new HTTPException(404, { message: "Parent comment not found." });
    tags = parent.tags;
    orgs = parent.orgs;
    usrs = parent.usrs;

    // Check user can read (and thus reply to) posts with these private tags
    const [viewer] = await sql`select orgs_r from usr where name = ${name}`;
    const userOrgsR = viewer?.orgs_r ?? [];
    const canRead = orgs.every((t: string) => userOrgsR.includes(t));
    const canSeeUsr = usrs.length === 0 || usrs.includes(name);
    if (!canRead || !canSeeUsr) throw new HTTPException(403, { message: "Cannot reply to this post." });
  } else {
    // Root post: parse labels from input
    const labelsInput = formData.get("tags")?.toString() ?? "";
    const parsed = parseLabels(labelsInput);
    tags = parsed.tag;
    orgs = parsed.org;
    usrs = parsed.usr;

    if (!tags.length) throw new HTTPException(400, { message: "Must include at least one #public tag." });

    // Check user can write all specified private tags
    const canWrite = orgs.every((t) => userOrgsW.includes(t));
    if (!canWrite) throw new HTTPException(403, { message: "You don't have permission to use those private tags." });
  }

  if (
    (await sql`select true from com where created_by = ${name} and created_at > now() - interval '1 day' having count(*) > ${MAX_POSTS_PER_DAY}`)
      .length
  ) {
    throw new HTTPException(400, {
      message: `You've reached your allotted limit of ${MAX_POSTS_PER_DAY} comments per 24 hours.`,
    });
  }

  const body = formData.get("body")?.toString() ?? "";

  // Extract thumbnail for root posts only (not replies)
  let thumb: string | null = null;
  if (!parent_cid) {
    const url = extractFirstUrl(body);
    if (url) thumb = await resolveThumbnail(url);
  }

  const com = {
    parent_cid,
    created_by: name,
    body,
    tags,
    orgs,
    usrs,
    thumb,
  };

  const [comment] = await sql`insert into com ${sql(com)} returning cid`;
  if (!parent_cid) return c.redirect(`/c/${comment.cid}`);
  const [parent] = await sql`select parent_cid from com where cid = ${parent_cid}`;
  // Show parent comment in grandparent context, or just the parent if it's top-level
  return c.redirect(parent?.parent_cid ? `/c/${parent.parent_cid}#${parent_cid}` : `/c/${parent_cid}#${comment.cid}`);
});

app.get("/c/:cid?", async (c) => {
  const p = parseInt(c.req.query("p") ?? "0");
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "25"), 1), 100);
  const sort = c.req.query("sort") === "top" ? "top" : "new";
  const cid = c.req.param("cid");
  const name = c.get("name");
  // Get user's private tag permissions (empty if not logged in)
  const [viewer] = name ? await sql`select orgs_r from usr where name = ${name}` : [{ orgs_r: [] }];
  const userOrgsR = viewer?.orgs_r ?? [];
  // Label filters (multiple allowed)
  const tagFilters: string[] = c.req.queries("tag") ?? [];
  const orgFilters: string[] = c.req.queries("org") ?? [];
  const usrFilters: string[] = c.req.queries("usr") ?? []; // Posts BY this author
  const mentionFilters: string[] = c.req.queries("mention") ?? []; // Posts that @mention this user
  const wwwFilters: string[] = c.req.queries("www") ?? [];
  const repliesToFilter = c.req.query("replies_to");
  const reactionsFilter = c.req.query("reactions");
  const commentsFilter = c.req.query("comments");
  const comments = await sql`
    select
      c.created_by,
      c.cid,
      c.parent_cid,
      c.body,
      c.thumb,
      c.tags,
      c.orgs,
      c.usrs,
      c.created_at,
      (select count(*) from com c_ where c_.parent_cid = c.cid) as comments,
      (select count(*) from com r where r.parent_cid = c.cid and char_length(r.body) = 1) as reaction_count,
      (
        select coalesce(jsonb_object_agg(body, cnt), '{}')
        from (select body, count(*) as cnt from com where parent_cid = c.cid and char_length(body) = 1 group by body) r
      ) as reaction_counts,
      array(
        select body from com where parent_cid = c.cid and char_length(body) = 1 and created_by = ${name ?? ""}
      ) as user_reactions,
      array(
        select jsonb_build_object(
          'body', c_.body,
          'created_by', c_.created_by,
          'cid', c_.cid,
          'created_at', c_.created_at,
          'tags', c_.tags,
          'orgs', c_.orgs,
          'usrs', c_.usrs,
          'reaction_counts', (
            select coalesce(jsonb_object_agg(body, cnt), '{}')
            from (select body, count(*) as cnt from com where parent_cid = c_.cid and char_length(body) = 1 group by body) r
          ),
          'user_reactions', array(
            select body from com where parent_cid = c_.cid and char_length(body) = 1 and created_by = ${name ?? ""}
          ),
          'child_comments', array(
            select jsonb_build_object(
              'body', c__.body,
              'created_by', c__.created_by,
              'cid', c__.cid,
              'created_at', c__.created_at,
              'tags', c__.tags,
              'orgs', c__.orgs,
              'usrs', c__.usrs,
              'reaction_counts', (
                select coalesce(jsonb_object_agg(body, cnt), '{}')
                from (select body, count(*) as cnt from com where parent_cid = c__.cid and char_length(body) = 1 group by body) r
              ),
              'user_reactions', array(
                select body from com where parent_cid = c__.cid and char_length(body) = 1 and created_by = ${name ?? ""}
              ),
              'child_comments_ids', array(
                select c___.cid
                from com c___
                where c___.parent_cid = c__.cid
                order by c___.created_at desc
              )
            )
            from com c__
            where c__.parent_cid = c_.cid and char_length(c__.body) > 1
            order by c__.created_at desc
          )
        )
        from com c_
        where c_.parent_cid = c.cid and char_length(c_.body) > 1
        order by c_.created_at desc
      ) as child_comments
    from com c
    where ${
    cid
      ? sql`cid = ${cid ?? null}`
      : (reactionsFilter || repliesToFilter || commentsFilter)
      ? sql`c.parent_cid is not null`
      : sql`c.parent_cid is null`
  }
      ${usrFilters.length ? sql`and c.created_by = any(${usrFilters}::citext[])` : sql``}
      and c.tags @> ${tagFilters}::text[]
      and c.orgs <@ ${userOrgsR}::text[]
      and (c.usrs = '{}' or ${name ?? ""}::text = any(c.usrs))
    ${orgFilters.length ? sql`and c.orgs && ${orgFilters}::text[]` : sql``}
    ${mentionFilters.length ? sql`and c.usrs && ${mentionFilters}::text[]` : sql``}
    ${
    wwwFilters.length
      ? sql`and c.body ~* ${wwwFilters.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}`
      : sql``
  }
    ${
    repliesToFilter
      ? sql`and c.parent_cid in (select cid from com where created_by = ${repliesToFilter}) and char_length(c.body) > 1`
      : sql``
  }
    ${reactionsFilter ? sql`and char_length(c.body) = 1` : sql``}
    ${commentsFilter ? sql`and char_length(c.body) > 1` : sql``}
    ${
    c.req.query("q")
      ? sql`and to_tsvector('english', body) @@ plainto_tsquery('english', ${c.req.query("q") ?? ""}::text)`
      : sql``
  }
    ${sort === "top" ? sql`order by reaction_count desc, c.created_at desc` : sql`order by c.created_at desc`}
    offset ${p * limit}
    limit ${limit}
  `;
  switch (host(c)) {
    case "api":
      return c.json(comments, 200);
    case "rss":
      return c.text(
        `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>ding</title>
    <link>https://ding.bar/</link>
    <description>Simple social commenting</description>
${
          comments.map((cm: Record<string, any>) =>
            `    <item>
      <title>${escapeXml(cm.body.trim().replace(/[\r\n\t].+$/, "").slice(0, 60))}</title>
      <link>https://ding.bar/c/${cm.cid}</link>
      <pubDate>${new Date(cm.created_at).toUTCString()}</pubDate>
    </item>`
          ).join("\n")
        }
  </channel>
</rss>`,
        200,
        { "Content-Type": "application/rss+xml" },
      );
    default: {
      if (!cid) {
        const paginationParams = (page: number) => {
          const params = new URLSearchParams();
          if (c.req.query("q")) params.set("q", c.req.query("q")!);
          for (const tag of c.req.queries("tag") ?? []) params.append("tag", tag);
          for (const org of c.req.queries("org") ?? []) params.append("org", org);
          for (const usr of c.req.queries("usr") ?? []) params.append("usr", usr);
          for (const mention of c.req.queries("mention") ?? []) params.append("mention", mention);
          for (const www of c.req.queries("www") ?? []) params.append("www", www);
          if (c.req.query("replies_to")) params.set("replies_to", c.req.query("replies_to")!);
          if (c.req.query("reactions")) params.set("reactions", c.req.query("reactions")!);
          if (c.req.query("comments")) params.set("comments", c.req.query("comments")!);
          if (c.req.query("sort")) params.set("sort", c.req.query("sort")!);
          params.set("p", String(page));
          return params.toString();
        };
        const searchValue = decodeLabels(new URL(c.req.url).searchParams);
        return c.render(
          <>
            <section>
              <form id="search-form" method="get" action="/c" style="display:flex;flex-direction:row;gap:0.5rem;">
                <input
                  name="search"
                  value={searchValue}
                  placeholder="#tag *org @user ~domain text"
                  style="width:100%;"
                />
                <button>search</button>
              </form>
              <SortToggle
                sort={sort}
                baseHref={`/c?${paginationParams(0).replace(/&?p=0/, "")}`}
                title="search results"
              />
            </section>
            <section>
              <div class="posts">{comments.map((cm) => Post(cm, c.get("name")))}</div>
            </section>
            <section>
              <div style="margin-top: 2rem;">
                {!p || <a href={`/c?${paginationParams(p - 1)}`}>prev</a>}
                {!comments.length || <a href={`/c?${paginationParams(p + 1)}`}>next</a>}
              </div>
            </section>
          </>,
        );
      } else {
        const post = comments?.[0];
        const replies = post?.child_comments?.filter((c: Record<string, any>) => !isReaction(c.body)) ?? [];
        if (sort === "top") {
          replies.sort((a: Record<string, any>, b: Record<string, any>) => {
            const aReactions = (a.child_comments ?? []).filter((c: Record<string, any>) => isReaction(c.body)).length;
            const bReactions = (b.child_comments ?? []).filter((c: Record<string, any>) => isReaction(c.body)).length;
            return bReactions - aReactions || new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          });
        }
        return c.render(
          <>
            <section>
              {Comment(
                { ...post, child_comments: post.child_comments.filter((c: { body: string }) => isReaction(c.body)) },
                c.get("name"),
              )}
            </section>
            <section>
              <form method="post" action={`/c/${post?.cid ?? 0}`}>
                <textarea requried name="body" rows={18} minlength={1} maxlength={1441}></textarea>
                <button>reply</button>
              </form>
              <SortToggle sort={sort} baseHref={`/c/${cid}`} title="comments" />
            </section>
            <section>
              {replies.map((cm: Record<string, any>) => Comment(cm, c.get("name")))}
            </section>
          </>,
          { title: post?.body?.slice(0, 16) },
        );
      }
    }
  }
});

app.use("/*", serveStatic({ root: "./public" }));

export default app;
