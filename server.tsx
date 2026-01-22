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

//// TAG PARSING ///////////////////////////////////////////////////////////////

const parseTags = (input: string) => {
  const tags = input.split(/\s+/).filter(Boolean);
  return {
    pub: tags.filter((t) => t.startsWith("#")).map((t) => t.slice(1).toLowerCase()),
    prv: tags.filter((t) => t.startsWith("*")).map((t) => t.slice(1).toLowerCase()),
    usr: tags.filter((t) => t.startsWith("@")).map((t) => t.slice(1)),
  };
};

const formatTags = (c: Record<string, any>): string[] => [
  ...(c.tags_pub ?? []).map((t: string) => `#${t}`),
  ...(c.tags_prv ?? []).map((t: string) => `*${t}`),
  ...(c.tags_usr ?? []).map((t: string) => `@${t}`),
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

const isReaction = (body: string): boolean => !!body && [...body].length === 1; // Single grapheme (handles emoji)

const Reactions = (c: Record<string, any>, uid?: string) => {
  const reactions: { [k: string]: { count: number; userReacted: boolean } } = {
    "▲": { count: 0, userReacted: false },
    "▼": { count: 0, userReacted: false },
  };
  for (const child of (c.child_comments ?? [])) {
    if (!isReaction(child.body)) continue;
    reactions[child.body] = reactions[child.body] ?? { count: 0, userReacted: false };
    reactions[child.body].count++;
    if (uid && child.uid == uid) reactions[child.body].userReacted = true;
  }
  return Object.entries(reactions).map(([char, { count, userReacted }]) => (
    <form method="post" action={`/c/${c.cid}`} class={`reaction${userReacted ? " reacted" : ""}`}>
      <input type="hidden" name="body" value={char} />
      <button type="submit">{char} {count}</button>
    </form>
  ));
};

const Comment = (c: Record<string, any>, uid?: string) => {
  return (
    <div class="comment" id={c.cid}>
      <div>
        {!c.created_at || <a href={`/c/${c.cid}`}>{new Date(c.created_at).toLocaleDateString()}</a>}
        {!c.parent_cid || <a href={`/c/${c.parent_cid}`}>parent</a>}
        <a href={`/u/${c.uid}`}>@{c.username ?? "unknown"}</a>
        {c.body !== "" && uid && c.uid == uid && <a href={`/c/${c.cid}/delete`}>delete</a>}
        <a href={`/c/${c.cid}`}>reply</a>
        {formatTags(c).map((tag: string) => <a href={`/c?tag=${tag.slice(1)}`}>{tag}</a>)}
        {Reactions(c, uid)}
      </div>
      <pre>{c.body === "" ? "[deleted by author]" : c.body}</pre>
      <div style="padding-left: 1rem;">
        {c?.child_comments?.filter((c: Record<string, any>) => !isReaction(c.body)).map((child: Record<string, any>) =>
          Comment(child, uid)
        )}
      </div>
    </div>
  );
};

const Post = (c: Record<string, any>, uid?: string) => (
  <div>
    <p>
      <a href={`/c/${c.cid}`}>
        {c.body === ""
          ? "[deleted by author]"
          : `${c.body.trim().replace(/[\r\n\t].+$/, "").slice(0, 60)}${c.body.length > 60 ? "…" : ""}`.padEnd(
            40,
            " .",
          )}
      </a>
    </p>
    <div>
      <a href={`/c/${c.cid}`}>{new Date(c.created_at).toLocaleDateString()}</a>
      <a href={`/u/${c.uid}`}>@{c.username}</a>
      {c.body !== "" && uid && c.uid == uid && <a href={`/c/${c.cid}/delete`}>delete</a>}
      <a href={`/c/${c.cid}`}>reply</a>
      {formatTags(c).map((tag: string) => <a href={`/c?tag=${tag.slice(1)}`}>{tag}</a>)}
      {Reactions(c, uid)}
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
  }),
);

// TODO: Add rate-limiting middleware everywhere.
const app = new Hono<{ Variables: { uid?: string; username?: string } }>();

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
  const uid = await getSignedCookie(c, cookieSecret, "uid");
  if (uid) {
    c.set("uid", uid);
    const [usr] = await sql`select name from usr where uid = ${uid}`;
    if (usr) c.set("username", usr.name);
  }
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
                  ${c.get("username") ? `@${c.get("username")}` : "account"}
                </a>
                <a href="https://github.com/surprisetalk/ding" style="letter-spacing:2px;font-size:0.875rem;opacity:0.8;">
                  source
                </a>
              </section>
            </header>
            <main>${content}</main>
            <footer></footer>
            <script>
            for (const x of document.querySelectorAll("pre")) x.innerHTML = x.innerHTML.replace(/(https?:\\/\\/\\S+)/g,
            '<a href="$1">$1</a>');
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
  const uid = c.get("uid");
  const username = c.get("username") ?? "";
  // Get user's private tag permissions (empty if not logged in)
  const [viewer] = uid ? await sql`select tags_prv_r from usr where uid = ${uid}` : [{ tags_prv_r: [] }];
  const userTagsR = viewer?.tags_prv_r ?? [];
  const comments = await sql`
    select
      c.cid,
      c.uid,
      c.body,
      c.tags_pub,
      c.tags_prv,
      c.tags_usr,
      c.created_at,
      (select count(*) from com c_ where c_.parent_cid = c.cid) as comments,
      array(
        select jsonb_build_object(
          'body', c_.body,
          'uid', c_.uid,
          'cid', c_.cid,
          'created_at', c_.created_at,
          'username', u_.name
        )
        from com c_
        inner join usr u_ using (uid)
        where c_.parent_cid = c.cid
        order by c_.created_at desc
      ) as child_comments,
      u.name as username
    from com c
    inner join usr u using (uid)
    where parent_cid is null
      and c.tags_prv <@ ${userTagsR}::text[]
      and (c.tags_usr = '{}' or ${username}::text = any(c.tags_usr))
    -- TODO: rank adding log comments + log created_at
    order by c.created_at desc
    offset ${p * 25}
    limit 25
  `;
  return c.render(
    <>
      <section>
        <form method="post" action="/c">
          <textarea requried name="body" rows={18} minlength={1} maxlength={1441}></textarea>
          <div style="display:flex;gap:0.5rem;justify-content:flex-end;align-items:center;">
            <input type="text" name="tags" placeholder="#linking #thinking *private @user" style="flex:1;" />
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
        <div class="posts">{comments.map((cm) => Post(cm, c.get("uid")))}</div>
      </section>
      <section>
        <div style="margin-top: 2rem;">
          {!p || <a href={`/?p=${p - 1}`}>prev</a>}
          {!comments.length || <a href={`/?p=${p + 1}`}>next</a>}
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
  return c.render(
    <>
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
    </>,
    { title: "your account" },
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
      return c.render(<section>{User(usr)}</section>, { title: usr.name });
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
    where cid = ${cid} and uid = ${c.get("uid")!} and body <> ''
    returning parent_cid
  `;
  if (!comment) throw new HTTPException(404, { message: "Comment not found, not yours, or already deleted." });
  return c.redirect(comment.parent_cid ? `/c/${comment.parent_cid}` : "/");
});

app.post("/c/:parent_cid?", authed, async (c) => {
  const formData = await c.req.formData();
  const parent_cid = c.req.param("parent_cid") ?? null;
  const uid = c.get("uid")!;

  // Get user's write permissions
  const [user] = await sql`select tags_prv_w from usr where uid = ${uid}`;
  const userTagsW = user?.tags_prv_w ?? [];

  let tags_pub: string[], tags_prv: string[], tags_usr: string[];

  if (parent_cid) {
    // Child comment: inherit all tags from parent
    const [parent] = await sql`select tags_pub, tags_prv, tags_usr from com where cid = ${parent_cid}`;
    if (!parent) throw new HTTPException(404, { message: "Parent comment not found." });
    tags_pub = parent.tags_pub;
    tags_prv = parent.tags_prv;
    tags_usr = parent.tags_usr;

    // Check user can read (and thus reply to) posts with these private tags
    const [viewer] = await sql`select tags_prv_r from usr where uid = ${uid}`;
    const userTagsR = viewer?.tags_prv_r ?? [];
    const canRead = tags_prv.every((t: string) => userTagsR.includes(t));
    const canSeeUsr = tags_usr.length === 0 || tags_usr.includes(c.get("username") ?? "");
    if (!canRead || !canSeeUsr) throw new HTTPException(403, { message: "Cannot reply to this post." });
  } else {
    // Root post: parse tags from input
    const tagsInput = formData.get("tags")?.toString() ?? "";
    const parsed = parseTags(tagsInput);
    tags_pub = parsed.pub;
    tags_prv = parsed.prv;
    tags_usr = parsed.usr;

    if (!tags_pub.length) throw new HTTPException(400, { message: "Must include at least one #public tag." });

    // Check user can write all specified private tags
    const canWrite = tags_prv.every((t) => userTagsW.includes(t));
    if (!canWrite) throw new HTTPException(403, { message: "You don't have permission to use those private tags." });
  }

  if (
    (await sql`select true from com where uid = ${uid} and created_at > now() - interval '1 day' having count(*) > 19`)
      .length
  ) {
    throw new HTTPException(400, { message: "You've reached your allotted limit of 19 comments per 24 hours." });
  }

  const com = {
    parent_cid,
    uid,
    body: formData.get("body")?.toString() ?? "",
    tags_pub,
    tags_prv,
    tags_usr,
  };

  const [comment] = await sql`insert into com ${sql(com)} returning cid`;
  if (!parent_cid) return c.redirect(`/c/${comment.cid}`);
  const [parent] = await sql`select parent_cid from com where cid = ${parent_cid}`;
  // Show parent comment in grandparent context, or just the parent if it's top-level
  return c.redirect(parent?.parent_cid ? `/c/${parent.parent_cid}#${parent_cid}` : `/c/${parent_cid}#${comment.cid}`);
});

app.get("/c/:cid?", async (c) => {
  const p = parseInt(c.req.query("p") ?? "0");
  const cid = c.req.param("cid");
  const uid = c.get("uid");
  const username = c.get("username") ?? "";
  // Get user's private tag permissions (empty if not logged in)
  const [viewer] = uid ? await sql`select tags_prv_r from usr where uid = ${uid}` : [{ tags_prv_r: [] }];
  const userTagsR = viewer?.tags_prv_r ?? [];
  const tagFilter: string[] = c.req.query("tag") ? [c.req.query("tag")!] : [];
  const comments = await sql`
    select
      c.uid,
      c.cid,
      c.parent_cid,
      c.body,
      c.tags_pub,
      c.tags_prv,
      c.tags_usr,
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
          'tags_pub', c_.tags_pub,
          'tags_prv', c_.tags_prv,
          'tags_usr', c_.tags_usr,
          'child_comments', array(
            select jsonb_build_object(
              'body', c__.body,
              'uid', c__.uid,
              'cid', c__.cid,
              'created_at', c__.created_at,
              'username', u_.name,
              'tags_pub', c__.tags_pub,
              'tags_prv', c__.tags_prv,
              'tags_usr', c__.tags_usr,
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
      and c.tags_pub @> ${tagFilter}::text[]
      and c.tags_prv <@ ${userTagsR}::text[]
      and (c.tags_usr = '{}' or ${username}::text = any(c.tags_usr))
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
        return c.render(
          <>
            <section>
              <form method="get" action="/c" style="display:flex;flex-direction:row;gap:0.5rem;">
                <input name="q" value={c.req.query("q") ?? ""} style="width:100%;" />
                <button>search</button>
              </form>
            </section>
            <section>
              <div class="posts">{comments.map((cm) => Post(cm, c.get("uid")))}</div>
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
        return c.render(
          <>
            <section>
              {Comment(
                { ...post, child_comments: post.child_comments.filter((c: { body: string }) => isReaction(c.body)) },
                c.get("uid"),
              )}
            </section>
            <section>
              <form method="post" action={`/c/${post?.cid ?? 0}`}>
                <textarea requried name="body" rows={18} minlength={1} maxlength={1441}></textarea>
                <button>reply</button>
              </form>
            </section>
            <section>
              {post?.child_comments?.filter((c: Record<string, any>) => !isReaction(c.body))?.map((
                cm: Record<string, any>,
              ) => Comment(cm, c.get("uid")))}
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
