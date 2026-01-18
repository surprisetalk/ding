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

import pg from "https://deno.land/x/postgresjs@v3.4.3/mod.js";

import sg from "npm:@sendgrid/mail";

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

//// EMAIL TOKEN ///////////////////////////////////////////////////////////////

const EMAIL_TOKEN_SECRET = Deno.env.get("EMAIL_TOKEN_SECRET") ?? "dev-secret-change-in-production";

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

const Layout = (props: { title?: string; keywords?: string; desc?: string; children?: any }) =>
  html`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${props.title ? `ding | ${props.title}` : "ding"}</title>
        <meta charset="UTF-8" />
        <meta name="color-scheme" content="light dark" />
        <meta name="author" content="Taylor Troesh" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        ${props.desc
          ? html`
            <meta name="description" content="${props.desc}" />
          `
          : ""} ${props.keywords
          ? html`
            <meta name="keywords" content="${props.keywords}" />
          `
          : ""}
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
            <a href="/u" style="letter-spacing:2px;font-size:0.875rem;opacity:0.8;">account</a>
            <a href="https://github.com/surprisetalk/ding" style="letter-spacing:2px;font-size:0.875rem;opacity:0.8;"
            >source</a>
          </section>
        </header>
        <main>${props.children}</main>
        <footer></footer>
        <script>
        for (const x of document.querySelectorAll("pre"))
        x.innerHTML = x.innerHTML.replace(/(https?:\\/\\/\\S+)/g, '<a href="$1">$1</a>');
        </script>
      </body>
    </html>
  `;

const User = (u: Record<string, any>) => (
  <div class="user">
    <div>
      <span>{u.name}</span>
      {u.uid !== u.invited_by_uid || <a href={`/u/${u.invited_by_uid}`}>@{u.invited_by_username}</a>}
      <a href={`/c?uid=${u.uid}`}>posts</a>
    </div>
    <div>
      <pre>{u.bio}</pre>
    </div>
  </div>
);

const Comment = (c: Record<string, any>, currentUid?: string) => {
  const isDeleted = c.body === "";
  const canDelete = currentUid && String(c.uid) === String(currentUid) && !isDeleted;
  return (
    <div class="comment">
      <div>
        {!c.created_at || <a href={`/c/${c.cid}`}>{new Date(c.created_at).toLocaleDateString()}</a>}
        {!c.parent_cid || <a href={`/c/${c.parent_cid}`}>parent</a>}
        <a href={`/u/${c.uid}`}>@{c.username ?? "unknown"}</a>
        {c?.tags?.map((tag: string) => <a href={`/c?tag=${tag}`}>#{tag}</a>)}
        {canDelete && <a href={`/c/${c.cid}/delete`}>delete</a>}
      </div>
      <pre>{isDeleted ? "[deleted by author]" : c.body}</pre>
      <div style="padding-left: 1rem;">
        {c?.child_comments?.map((child: Record<string, any>) => Comment(child, currentUid))}
      </div>
    </div>
  );
};

const Post = (comment: Record<string, any>, currentUid?: string) => {
  const isDeleted = comment.body === "";
  const canDelete = currentUid && String(comment.uid) === String(currentUid) && !isDeleted;
  const displayBody = isDeleted
    ? "[deleted by author]"
    : `${comment.body.trim().replace(/[\r\n\t].+$/, "").slice(0, 60)}${comment.body.length > 60 ? "…" : ""}`.padEnd(40, " .");
  return (
    <div>
      <p>
        <a href={`/c/${comment.cid}`}>{displayBody}</a>
      </p>
      <div>
        <a href={`/c/${comment.cid}`}>{new Date(comment.created_at).toLocaleDateString()}</a>
        <a href={`/u/${comment.uid}`}>@{comment.username}</a>
        {comment?.tags?.map((tag: string) => <a href={`/c?tag=${tag}`}>#{tag}</a>)}
        {canDelete && <a href={`/c/${comment.cid}/delete`}>delete</a>}
      </div>
    </div>
  );
};

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
    const uid = await getSignedCookie(c, cookieSecret, "uid");
    if (!uid) throw new HTTPException(401, { message: "Not authorized." });
    c.set("uid", uid);
    await next();
  }),
  basicAuth({
    verifyUser: async (email, password, c) => {
      const [usr] = await sql`
        select *, password = crypt(${password}, password) AS is_password_correct
        from usr where email = ${email} or name = ${email}
      `;
      if (!usr || !usr.is_password_correct) return false;
      await setSignedCookie(c, "uid", usr.uid, cookieSecret);
      c.set("uid", usr.uid);
      return true;
    },
  }),
);

// TODO: Add rate-limiting middleware everywhere.
const app = new Hono<{ Variables: { uid?: string } }>();

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
      return c.html(
        <Layout title="error">
          <section>
            <p>{message}</p>
          </section>
        </Layout>,
        500,
      );
  }
});

app.get("/robots.txt", (c) => c.text(`User-agent: *\nDisallow:`));

app.get("/sitemap.txt", (c) => c.text("https://ding.bar/"));

app.get("/", async (c) => {
  const p = parseInt(c.req.query("p") ?? "0");
  const currentUid = (await getSignedCookie(c, cookieSecret, "uid")) || undefined;
  const comments = await sql`
    select
      c.cid,
      c.uid,
      c.body,
      c.tags,
      c.created_at,
      (select count(*) from com c_ where c_.parent_cid = c.cid) as comments,
      u.name as username
    from com c
    inner join usr u using (uid)
    where parent_cid is null
    -- TODO: rank adding log comments + log created_at
    order by c.created_at desc
    offset ${p * 25}
    limit 25
  `;
  return c.html(
    <Layout>
      <section>
        <form method="post" action="/c">
          <textarea requried name="body" rows={18} minlength={1} maxlength={1441}></textarea>
          <div style="display:flex;gap:0.5rem;justify-content:flex-end;align-items:center;">
            <fieldset style="display:flex;gap:1rem;border:none;padding:0;margin:0;">
              {["linking", "thinking"].map((t) => (
                <label style="display:flex;align-items:center;gap:0.25rem;">
                  <input type="checkbox" name="tag" value={t} />
                  {t}
                </label>
              ))}
            </fieldset>
            <button>create post</button>
          </div>
        </form>
      </section>
      <section>
        {!comments.length && (
          <p>
            no posts. <a href="/">go home.</a>
          </p>
        )}
        <div class="posts">{comments.map((cm) => Post(cm, currentUid))}</div>
      </section>
      <section>
        <div style="margin-top: 2rem;">
          {!p || <a href={`/?p=${p - 1}`}>prev</a>}
          {!comments.length || <a href={`/?p=${p + 1}`}>next</a>}
        </div>
      </section>
    </Layout>,
  );
});

app.post("/login", async (c) => {
  const { email, password } = await form(c);
  const [usr] = await sql`
    select *, password = crypt(${password}, password) AS is_password_correct
    from usr where email = ${email}
  `;
  if (!usr || !usr.is_password_correct) throw new HTTPException(401, { message: "Wrong credentials." });
  if (!usr.email_verified_at && !(await getSignedCookie(c, cookieSecret, "uid")))
    await sendVerificationEmail(usr.email, usr.token);
  await setSignedCookie(c, "uid", usr.uid, cookieSecret);
  return c.redirect("/u");
});

app.get("/logout", (c) => {
  deleteCookie(c, "uid");
  return c.redirect("/");
});

app.post("/logout", (c) => {
  deleteCookie(c, "uid");
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
  return c.html(
    <Layout title="welcome">
      <section>
        <form method="post" action="/forgot">
          <input required name="email" type="email" placeholder="hello@example.com" />
          <p>
            <button type="submit">send email</button>
          </p>
        </form>
      </section>
    </Layout>,
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
  return c.html(
    <Layout title="welcome">
      <section>
        <form method="post" action="/password">
          <input required name="token" value={token} type="hidden" readonly />
          <input required name="email" value={email} readonly />
          <input required name="password" type="password" placeholder="password1!" />
          <p>
            <button type="submit">set password</button>
          </p>
        </form>
      </section>
    </Layout>,
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
    returning uid
  `;
  if (usr) await setSignedCookie(c, "uid", usr.uid, cookieSecret);
  return ok(c);
});

app.post("/invite", authed, async (c) => {
  const usr = {
    name: Math.random().toString().slice(2),
    email: (await form(c)).email,
    bio: "coming soon",
    password: null,
    invited_by: c.get("uid")!,
  };
  if ((await sql`select count(*) as "count" from usr where invited_by = ${c.get("uid")!}`)?.[0]?.count >= 4)
    throw new HTTPException(400, { message: "No more invites remaining." });
  const [newUsr] = await sql`
    with usr_ as (insert into usr ${sql(usr)} on conflict do nothing returning *)
    select uid, email from usr_
  `;
  if (newUsr?.email) {
    const token = await emailToken(new Date(), newUsr.email);
    await sendVerificationEmail(newUsr.email, token);
  }
  return ok(c);
});

// TODO: Remove this when we want to disallow self-signups.
app.get("/signup", async (c) => {
  return c.html(
    <Layout title="your account">
      <section>
        <form method="post" action="/signup" style="display:flex;flex-direction:row;">
          <input type="text" name="name" placeholder="ivan_grease" />
          <input type="email" name="email" placeholder="hello@example.com" />
          <button>verify email</button>
        </form>
      </section>
    </Layout>,
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
    invited_by: -1,
  };
  const [newUsr] = await sql`
    with usr_ as (insert into usr ${sql(usr)} on conflict do nothing returning *)
    select uid, email from usr_
  `;
  if (newUsr?.email) {
    const token = await emailToken(new Date(), newUsr.email);
    await sendVerificationEmail(newUsr.email, token);
  }
  return c.redirect("/");
});

app.get("/u", authed, async (c) => {
  const [usr] = await sql`
    select u.uid, u.name, u.email, u.bio, u.invited_by, u.password is not null as password, i.name as invited_by_username
    from usr u left join usr i on i.uid = u.invited_by where u.uid = ${c.get("uid")!}
  `;
  if (!usr) return notFound();
  if (!usr.password) return c.redirect("/password");
  return c.html(
    <Layout title="your account">
      <section>{User(usr)}</section>
      {
        /*
      <section>
        <form method="post" action="/logout">
          <button>logout</button>
        </form>
      </section>
      */
      }
    </Layout>,
  );
});

app.patch("/u", authed, async (c) => {
  const usr = Object.fromEntries(await c.req.formData());
  for (const i in usr) if (!usr[i]) delete usr[i];
  await sql`update usr set ${sql(usr, "name", "bio")} where uid = ${c.get("uid")!}`;
  return ok(c);
});

app.get("/u/:uid", async (c) => {
  const [usr] = await sql`select uid, name, bio, invited_by from usr where uid = ${c.req.param("uid")}`;
  if (!usr) return notFound();
  switch (host(c)) {
    case "api":
      return c.json(usr, 200);
    default:
      return c.html(
        <Layout title={usr.name}>
          <section>{User(usr)}</section>
        </Layout>,
      );
  }
});

app.get("/c/:cid/delete", authed, async (c) => {
  const cid = c.req.param("cid");
  const [comment] = await sql`
    select c.cid, c.body, c.parent_cid, u.name as username
    from com c
    inner join usr u using (uid)
    where c.cid = ${cid} and c.uid = ${c.get("uid")!}
  `;
  if (!comment) throw new HTTPException(404, { message: "Comment not found or not yours." });
  if (comment.body === "") throw new HTTPException(400, { message: "Already deleted." });
  return c.html(
    <Layout title="delete">
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
      </section>
    </Layout>,
  );
});

app.post("/c/:cid/delete", authed, async (c) => {
  const cid = c.req.param("cid");
  const [comment] = await sql`
    update com
    set body = ''
    where cid = ${cid} and uid = ${c.get("uid")!} and body <> ''
    returning parent_cid
  `;
  if (!comment) throw new HTTPException(404, { message: "Comment not found, not yours, or already deleted." });
  return c.redirect(comment.parent_cid ? `/c/${comment.parent_cid}` : "/");
});

app.post("/c/:parent_cid?", authed, async (c) => {
  const formData = await c.req.formData();
  const com = {
    parent_cid: c.req.param("parent_cid") ?? null,
    uid: c.get("uid")!,
    body: formData.get("body")?.toString() ?? "",
    tags: formData.getAll("tag").map((t) => t.toString()),
  };
  if (!com.tags.length && !com.parent_cid) throw new HTTPException(400, { message: "Must include tags on post." });
  if (com.tags.length && com.parent_cid)
    throw new HTTPException(400, { message: "Cannot include tags on child comment." });
  if (
    (await sql`select true from com where uid = ${c.get(
      "uid",
    )!} and created_at > now() - interval '1 day' having count(*) > 19`).length
  ) {
    throw new HTTPException(400, { message: "You've reached your allotted limit of 19 comments per 24 hours." });
  }
  const [comment] = await sql`insert into com ${sql(com)} returning cid`;
  return c.redirect(`/c/${c.req.param("parent_cid") ?? comment?.cid ?? ""}`);
});

app.get("/c/:cid?", async (c) => {
  const p = parseInt(c.req.query("p") ?? "0");
  const cid = c.req.param("cid");
  const currentUid = (await getSignedCookie(c, cookieSecret, "uid")) || undefined;
  const comments = await sql`
    select 
      c.uid, 
      c.cid,
      c.parent_cid, 
      c.body,
      c.tags,
      c.created_at,
      (select count(*) from com c_ where c_.parent_cid = c.cid) as comments,
      u.name as username,
      array(
        select jsonb_build_object(
          'body', c_.body,
          'uid', c_.uid,
          'cid', c_.cid,
          'created_at', c_.created_at,
          'username', u_.name,
          'child_comments', array(
            select jsonb_build_object(
              'body', c__.body,
              'uid', c__.uid,
              'cid', c__.cid,
              'created_at', c__.created_at,
              'username', u_.name,
              'child_comments_ids', array(
                select c___.cid 
                from com c___
                where c___.parent_cid = c__.cid
                order by c___.created_at desc
              )
            )
            from com c__ 
            inner join usr u_ using (uid)
            where c__.parent_cid = c_.cid
            order by c__.created_at desc
          )
        )
        from com c_ 
        inner join usr u_ using (uid)
        where c_.parent_cid = c.cid
        order by c_.created_at desc
      ) as child_comments
    from com c
    inner join usr u using (uid)
    where ${cid ? sql`cid = ${cid ?? null}` : sql`parent_cid is null`}
    and uid = ${c.req.query("uid") ?? sql`uid`}
    and tags @> ${[c.req.query("tag") ?? null].filter((x) => x)}
    ${
    c.req.query("q")
      ? sql`and to_tsvector('english', body) @@ plainto_tsquery('english', ${c.req.query("q") ?? ""}::text)`
      : sql``
  }
    order by created_at desc
    offset ${p * 25}
    limit 25
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
          if (c.req.query("uid")) params.set("uid", c.req.query("uid")!);
          if (c.req.query("tag")) params.set("tag", c.req.query("tag")!);
          params.set("p", String(page));
          return params.toString();
        };
        return c.html(
          <Layout>
            <section>
              <form method="get" action="/c" style="display:flex;flex-direction:row;gap:0.5rem;">
                <input name="q" value={c.req.query("q") ?? ""} style="width:100%;" />
                <button>search</button>
              </form>
            </section>
            <section>
              <div class="posts">{comments.map((cm) => Post(cm, currentUid))}</div>
            </section>
            <section>
              <div style="margin-top: 2rem;">
                {!p || <a href={`/c?${paginationParams(p - 1)}`}>prev</a>}
                {!comments.length || <a href={`/c?${paginationParams(p + 1)}`}>next</a>}
              </div>
            </section>
          </Layout>,
        );
      } else {
        const post = comments?.[0];
        return c.html(
          <Layout title={post?.body?.slice(0, 16)}>
            <section>{Comment({ ...post, child_comments: [] }, currentUid)}</section>
            <section>
              <form method="post" action={`/c/${post?.cid ?? 0}`}>
                <textarea requried name="body" rows={18} minlength={1} maxlength={1441}></textarea>
                <button>reply</button>
              </form>
            </section>
            <section>{post?.child_comments?.map((cm: Record<string, any>) => Comment(cm, currentUid))}</section>
          </Layout>,
        );
      }
    }
  }
});

app.use("/*", serveStatic({ root: "./public" }));

Deno.serve(
  {
    hostname: Deno.env.get("HOST") ?? "127.0.0.1",
    port: parseInt(Deno.env.get("PORT") ?? "") || 8080,
  },
  app.fetch,
);

export default app;
