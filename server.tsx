/** @jsx jsx */
/** @jsxImportSource jsr:@hono/hono/jsx */

//// IMPORTS ///////////////////////////////////////////////////////////////////

import { HTTPException } from "jsr:@hono/hono/http-exception";
import { Hono, Context } from "jsr:@hono/hono";
import { some, every, except } from "jsr:@hono/hono/combine";
import { createMiddleware } from "jsr:@hono/hono/factory";
import { logger } from "jsr:@hono/hono/logger";
import { prettyJSON } from "jsr:@hono/hono/pretty-json";
import { basicAuth } from "jsr:@hono/hono/basic-auth";
import { html } from "jsr:@hono/hono/html";
import { getSignedCookie, setSignedCookie, deleteCookie } from "jsr:@hono/hono/cookie";
import { serveStatic } from "jsr:@hono/hono/deno";

import pg from "https://deno.land/x/postgresjs@v3.4.3/mod.js";

import sg from "npm:@sendgrid/mail";

//// HELPERS ///////////////////////////////////////////////////////////////////

const TODO = (x: TemplateStringsArray) => {
  throw new Error(`TODO: ${x.raw.join("")}`);
};

//// POSTGRES //////////////////////////////////////////////////////////////////

export const sql = pg(Deno.env.get(`DATABASE_URL`)?.replace(/flycast/, "internal")!, { database: "ding" });

//// SENDGRID //////////////////////////////////////////////////////////////////

sg.setApiKey(Deno.env.get(`SENDGRID_API_KEY`) ?? "");

const sendVerificationEmail = async (email: string, token: string) =>
  Deno.env.get(`SENDGRID_API_KEY`) &&
  (await sg
    .send({
      to: email,
      from: "taylor@troe.sh",
      subject: "Verify your email",
      text:
        `` +
        `Welcome to ᵗ𝕙𝔢 𝐟𝐔𝓉𝓾гє 𝔬𝔣 ᑕⓞ𝓓ƗŇg.` +
        `\n\n` +
        `Please verify your email: ` +
        `https://futureofcod.ing/password` +
        `?email=${encodeURIComponent(email)}` +
        `&token=${encodeURIComponent(token)}`,
    })
    .catch(err => {
      console.log(`/password?email=${email}&token=${token}`);
      console.error(`Could not send verification email to ${email}:`, err?.response?.body || err);
    }));

//// COMPONENTS ////////////////////////////////////////////////////////////////

const Layout = (props: { title?: string; keywords?: string; desc?: string; children?: any }) => html`<!DOCTYPE html>
  <html>
    <head>
      <title>${props.title ? `future of coding | ${props.title}` : "future of coding"}</title>
      <meta charset="UTF-8" />
      <meta name="color-scheme" content="light dark" />
      <meta name="author" content="Taylor Troesh" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      ${props.desc ? html`<meta name="description" content="${props.desc}" />` : ""}
      ${props.keywords ? html`<meta name="keywords" content="${props.keywords}" />` : ""}
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
          <a href="https://github.com/surprisetalk/ding" style="letter-spacing:2px;font-size:0.875rem;opacity:0.8;">source</a>
        </section>
      </header>
      <main>${props.children}</main>
      <footer></footer>
      <script>
        for (const x of document.querySelectorAll("pre")) x.innerHTML = x.innerHTML.replace(/(https?:\\/\\/\\S+)/g, '<a href="$1">$1</a>');
      </script>
    </body>
  </html>`;

const User = u => (
  <div class="user">
    <div>
      <span>{u.name}</span>
      {u.uid !== u.invited_by_uid || <a href={`/u/${u.invited_by_uid}`}>{u.invited_by_username}</a>}
      <a href={`/c?uid=${u.uid}`}>posts</a>
    </div>
    <div>
      <pre>{u.bio}</pre>
    </div>
  </div>
);

const Comment = c => (
  <div class="comment">
    <div>
      {!c.created_at || <a href={`/c/${c.cid}`}>{new Date(c.created_at).toLocaleDateString()}</a>}
      {!c.parent_cid || <a href={`/c/${c.parent_cid}`}>parent</a>}
      <a href={`/u/${c.uid}`}>{c.username ?? "unknown user"}</a>
      {c?.tags?.map((tag: string) => (
        <a href={`/c?tag=${tag}`}>{tag}</a>
      ))}
    </div>
    <pre>{c.body}</pre>
    <div style="padding-left: 1rem;">{c?.child_comments?.map(Comment)}</div>
  </div>
);

const Post = comment => (
  <div>
    <p>
      <a href={`/c/${comment.cid}`}>
        {`${comment.body
          .trim()
          .replace(/[\r\n\t].+$/, "")
          .slice(0, 60)}${comment.body.length > 60 ? "…" : ""}`.padEnd(40, " .")}
      </a>
    </p>
    <div>
      <a href={`/c/${comment.cid}`}>{new Date(comment.created_at).toLocaleDateString()}</a>
      <a href={`/u/${comment.uid}`}>{comment.username}</a>
      {comment?.tags?.map((tag: string) => (
        <a href={`/c?tag=${tag}`}>{tag}</a>
      ))}
    </div>
  </div>
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
  })
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
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
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
        500
      );
  }
});

app.get("/robots.txt", c => c.text(`User-agent: *\nDisallow:`));

app.get("/sitemap.txt", c => {
  return TODO`sitemap`;
});

app.get("/", async c => {
  const p = parseInt(c.req.query("p") ?? "0");
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
          {/* TODO: Change to checkboxes */}
          <div style="display:flex;gap:0.5rem;justify-content:flex-end;align-items:center;">
            <select required name="tag" style="width:100%;">
              {["", "linking", "thinking"].map(x => (
                <option value={x}>{x}</option>
              ))}
            </select>
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
        <div class="posts">{comments.map(Post)}</div>
      </section>
      <section>
        <div style="margin-top: 2rem;">
          {!p || <a href={`/?p=${p - 1}`}>prev</a>}
          {!comments.length || <a href={`/?p=${p + 1}`}>next</a>}
        </div>
      </section>
    </Layout>
  );
});

app.post("/login", async c => {
  const { email, password } = await form(c);
  const [usr] = await sql`
    select *, password = crypt(${password}, password) AS is_password_correct
    from usr where email = ${email}
  `;
  if (!usr || !usr.is_password_correct) throw new HTTPException(401, { message: "Wrong credentials." });
  if (!usr.email_verified_at && !(await getSignedCookie(c, cookieSecret, "uid"))) await sendVerificationEmail(usr.email, usr.token);
  await setSignedCookie(c, "uid", usr.uid, cookieSecret);
  return c.redirect("/u");
});

app.get("/logout", c => {
  deleteCookie(c, "uid");
  return c.redirect("/");
});

app.post("/logout", c => {
  deleteCookie(c, "uid");
  return ok(c);
});

// app.get("/verify", async c => {
//   const email = c.req.query("email") ?? "";
//   const token = c.req.query("token") ?? "";
//   await sql`
//     update usr
//     set email_verified_at = now()
//     where email_verified_at is null
//       and to_timestamp(split_part(${token},':',1)::bigint) > now() - interval '2 days'
//       and ${email} = email
//       and ${token} = email_token(to_timestamp(split_part(${token},':',1)::bigint), email)
//     returning uid
//   `;
//   return ok(c);
// });

app.get("/forgot", c => {
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
    </Layout>
  );
});

app.post("/forgot", async c => {
  const { email } = await form(c);
  const [usr] = await sql`
    select email_token(now(), email) as token from usr where email = ${email}
  `;
  if (usr)
    Deno.env.get(`SENDGRID_API_KEY`) &&
      (await sg
        .send({
          to: email,
          from: "taylor@troe.sh",
          subject: "Reset your password",
          text:
            `` +
            `Click here to reset your password: ` +
            `https://futureofcod.ing/password` +
            `?email=${encodeURIComponent(email)}` +
            `&token=${encodeURIComponent(usr.token)}` +
            `\n\n` +
            `If you didn't request a password reset, please ignore this message.`,
        })
        .catch(err => {
          console.log(`/password?email=${email}&token=${usr.token}`);
          console.error(`Could not send password reset email to ${email}:`, err?.response?.body || err);
        }));
  return c.redirect("/");
});

app.get("/password", c => {
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
    </Layout>
  );
});

app.post("/password", async c => {
  const { email, token, password } = await form(c);
  const [usr] = await sql`
    update usr
    set password = crypt(${password}, gen_salt('bf', 8))
    where true
      and to_timestamp(split_part(${token},':',1)::bigint) > now() - interval '2 days'
      and ${email} = email
      and ${token} = email_token(to_timestamp(split_part(${token},':',1)::bigint), email)
    returning uid
  `;
  if (usr) await setSignedCookie(c, "uid", usr.uid, cookieSecret);
  return ok(c);
});

app.post("/invite", authed, async c => {
  const usr = {
    name: Math.random().toString().slice(2),
    email: (await form(c)).email,
    bio: "coming soon",
    password: null,
    invited_by: c.get("uid")!,
  };
  if ((await sql`select count(*) as "count" from usr where invited_by = ${c.get("uid")!}`)?.[0]?.count >= 4)
    throw new HTTPException(400, { message: "No more invites remaining." });
  const [{ email = undefined, token = undefined } = {}] = await sql`
    with usr_ as (insert into usr ${sql(usr)} on conflict do nothing returning *)
    select uid, email, email_token(now(), email) as token from usr_
  `;
  if (email && token) await sendVerificationEmail(email, token);
  return ok(c);
});

// TODO: Remove this when we want to disallow self-signups.
app.get("/signup", async c => {
  return c.html(
    <Layout title="your account">
      <section>
        <form method="post" action="/signup" style="display:flex;flex-direction:row;">
          <input type="text" name="name" placeholder="ivan_grease" />
          <input type="email" name="email" placeholder="hello@example.com" />
          <button>verify email</button>
        </form>
      </section>
    </Layout>
  );
});

// TODO: Remove this when we want to disallow self-signups.
app.post("/signup", async c => {
  const usr = {
    name: (await form(c)).name,
    email: (await form(c)).email,
    bio: "coming soon",
    password: null,
    invited_by: -1,
  };
  const [{ email = undefined, token = undefined } = {}] = await sql`
    with usr_ as (insert into usr ${sql(usr)} on conflict do nothing returning *)
    select uid, email, email_token(now(), email) as token from usr_
  `;
  if (email && token) await sendVerificationEmail(email, token);
  return c.redirect("/");
});

app.get("/u", authed, async c => {
  const [usr] = await sql`
    select u.uid, u.name, u.email, u.bio, u.invited_by, u.password is not null as password, i.name as invited_by_username
    from usr u left join usr i on i.uid = u.invited_by where u.uid = ${c.get("uid")!}
  `;
  if (!usr) return notFound();
  if (!usr.password) return c.redirect("/password");
  return c.html(
    <Layout title="your account">
      <section>{User(usr)}</section>
      {/*
      <section>
        <form method="post" action="/logout">
          <button>logout</button>
        </form>
      </section>
      */}
    </Layout>
  );
});

app.patch("/u", authed, async c => {
  const usr = Object.fromEntries(await c.req.formData());
  for (const i in usr) if (!usr[i]) delete usr[i];
  await sql`update usr set ${sql(usr, "name", "bio")} where uid = ${c.get("uid")!}`;
  return ok(c);
});

app.get("/u/:uid", async c => {
  const [usr] = await sql`select uid, name, bio, invited_by from usr where uid = ${c.req.param("uid")}`;
  if (!usr) return notFound();
  switch (host(c)) {
    case "api":
      return c.json(usr, 200);
    default:
      return c.html(
        <Layout title={usr.name}>
          <section>{User(usr)}</section>
        </Layout>
      );
  }
});

app.post("/c/:parent_cid?", authed, async c => {
  const com = {
    parent_cid: c.req.param("parent_cid") ?? null,
    uid: c.get("uid")!,
    body: (await form(c)).body,
    tags: [(await form(c)).tag].filter(x => x),
  };
  if (!com.tags.length && !com.parent_cid) throw new HTTPException(400, { message: "Must include tags on post." });
  if (com.tags.length && com.parent_cid) throw new HTTPException(400, { message: "Cannot include tags on child comment." });
  // if ((await sql`select true from com where uid = ${c.get("uid")!} and created_at between now() and interval '1 day' having count(*) > 19`).length)
  //   throw new HTTPException(400, { message: "You've reached your allotted limit of 19 comments per 24 hours." });
  const [comment] = await sql`insert into com ${sql(com)} returning cid`;
  return c.redirect(`/c/${c.req.param("parent_cid") ?? comment?.cid ?? ""}`);
});

app.get("/c/:cid?", async c => {
  const p = parseInt(c.req.query("p") ?? "0");
  const cid = c.req.param("cid");
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
    and tags @> ${[c.req.query("tag") ?? null].filter(x => x)}
    ${c.req.query("q") ? sql`and to_tsvector('english', body) @@ plainto_tsquery('english', ${c.req.query("q") ?? ""}::text)` : sql``}
    order by created_at desc
    offset ${p * 25}
    limit 25
  `;
  switch (host(c)) {
    case "api":
      return c.json(comments, 200);
    case "rss":
      return TODO`RSS not yet implemented`;
    default: {
      if (!cid) {
        return c.html(
          <Layout>
            <section>
              <form method="get" action="/c" style="display:flex;flex-direction:row;gap:0.5rem;">
                <input name="q" value={c.req.query("q") ?? ""} style="width:100%;" />
                <button>search</button>
              </form>
            </section>
            <section>
              <div class="posts">{comments.map(Post)}</div>
            </section>
            <section>
              <div style="margin-top: 2rem;">
                {/* TODO: This also needs to keep the other query params... */}
                {!p || <a href={`/c?p=${p - 1}`}>prev</a>}
                {!comments.length || <a href={`/c?p=${p + 1}`}>next</a>}
              </div>
            </section>
          </Layout>
        );
      } else {
        const post = comments?.[0];
        return c.html(
          <Layout title={post?.body?.slice(0, 16)}>
            <section>{Comment({ ...post, child_comments: [] })}</section>
            <section>
              <form method="post" action={`/c/${post?.cid ?? 0}`}>
                <textarea requried name="body" rows={18} minlength={1} maxlength={1441}></textarea>
                <button>reply</button>
              </form>
            </section>
            <section>{post?.child_comments?.map(Comment)}</section>
          </Layout>
        );
      }
    }
  }
});

app.use("/*", serveStatic({ root: "./public" }));

Deno.serve(
  {
    hostname: Deno.env.get("HOST") ?? "0.0.0.0",
    port: parseInt(Deno.env.get("PORT") ?? "") || 8080,
  },
  app.fetch
);

export default app;
