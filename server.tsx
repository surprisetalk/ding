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
      from: "hello@futureofcod.ing",
      subject: "Verify your email",
      text:
        `` +
        `Welcome to ᵗ𝕙𝔢 𝐟𝐔𝓉𝓾гє 𝔬𝔣 ᑕⓞ𝓓ƗŇg.` +
        `\n\n` +
        `Please verify your email: ` +
        `https://futureofcod.ing/verify` +
        `?email=${encodeURIComponent(email)}` +
        `&token=${encodeURIComponent(token)}`,
    })
    .catch(err => {
      console.log(`/verify?email=${email}&token=${token}`);
      console.error(`Could not send verification email to ${email}:`, err?.response?.body || err);
    }));

//// COMPONENTS ////////////////////////////////////////////////////////////////

const Layout = (props: { title?: string; keywords?: string; desc?: string; children?: any }) => html`<!DOCTYPE html>
  <html>
    <head>
      <title>${props.title ? `future of coding | ${props.title}` : "future of coding"}</title>
      <meta charset="UTF-8" />
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
      <header></header>
      <main>${props.children}</main>
      <footer></footer>
    </body>
  </html>`;

//// HONO //////////////////////////////////////////////////////////////////////

const cookieSecret = Deno.env.get("COOKIE_SECRET") ?? Math.random().toString();

const notFound = () => {
  throw new HTTPException(404, { message: "Not found." });
};

const form = async (c: Context): Promise<Record<string, string>> =>
  Object.fromEntries([...(await c.req.formData()).entries()].map(([k, v]) => [k, v.toString()]));

const ok = (c: Context) => {
  switch (c.req.header("host")) {
    case "api":
      return c.json(null, 204);
    default:
      return c.redirect("/u");
  }
};

const authed = some(
  createMiddleware(async (c, next) => {
    const usr_id = await getSignedCookie(c, cookieSecret, "usr_id");
    if (!usr_id) throw new HTTPException(401, { message: "Not authorized." });
    c.set("usr_id", usr_id);
    await next();
  }),
  basicAuth({
    verifyUser: async (email, password, c) => {
      const [usr] = await sql`
        select *, password = crypt(${password}, password) AS is_password_correct
        from usr where email = ${email}
      `;
      if (!usr || !usr.is_password_correct) return false;
      await setSignedCookie(c, "usr_id", usr.usr_id, cookieSecret);
      c.set("usr_id", usr.usr_id);
      return true;
    },
  })
);

// TODO: Add rate-limiting middleware everywhere.
const app = new Hono<{ Variables: { usr_id?: string } }>();

app.use(logger());
app.use(prettyJSON());

app.notFound(notFound);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  if (err) console.error(err);
  const message = "Sorry, this computer is мᎥｓβ𝕖𝓱𝐀𝓋𝓲𝓷g.";
  switch (c.req.header("host")) {
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

app.get("/", c => {
  return c.html(<Layout desc="TODO">TODO</Layout>);
});

app.post("/login", async c => {
  const { email, password } = await form(c);
  const [usr] = await sql`
    select *, password = crypt(${password}, password) AS is_password_correct
    from usr where email = ${email}
  `;
  if (!usr || !usr.is_password_correct) throw new HTTPException(401, { message: "Wrong credentials." });
  if (!usr.email_verified_at && !(await getSignedCookie(c, cookieSecret, "usr_id"))) await sendVerificationEmail(usr.email, usr.token);
  await setSignedCookie(c, "usr_id", usr.usr_id, cookieSecret);
  return c.redirect("/u");
});

app.post("/logout", authed, c => {
  deleteCookie(c, c.get("usr_id")!);
  return ok(c);
});

app.get("/verify", async c => {
  const email = c.req.query("email") ?? "";
  const token = c.req.query("token") ?? "";
  await sql`
    update usr
    set email_verified_at = now()
    where email_verified_at is null
      and to_timestamp(split_part(${token},':',1)::bigint) > now() - interval '2 days'
      and ${email} = email
      and ${token} = email_token(to_timestamp(split_part(${token},':',1)::bigint), email)
    returning usr_id
  `;
  return ok(c);
});

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
          from: "hello@futureofcod.ing",
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
  return ok(c);
});

app.get("/password", c => {
  const email = c.req.query("email") ?? "";
  const token = c.req.query("token") ?? "";
  return c.html(
    <Layout title="welcome">
      <section>
        <form method="post" action="/password">
          <input required name="email" value={email} class="hidden" />
          <input required name="token" value={token} class="hidden" />
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
    returning usr_id
  `;
  if (usr) await setSignedCookie(c, "usr_id", usr.usr_id, cookieSecret);
  return ok(c);
});

app.post("/invite", authed, async c => {
  const usr = {
    name: Math.random().toString().slice(2),
    email: (await form(c)).email,
    password: null,
    invited_by: c.get("usr_id")!,
  };
  if ((await sql`select count(*) as "count" from usr where invited_by = ${c.get("usr_id")!}`)?.[0]?.count >= 4)
    throw new HTTPException(400, { message: "No more invites remaining." });
  const [{ email = undefined, token = undefined } = {}] = await sql`
    with usr_ as (insert into usr ${sql(usr)} on conflict do nothing returning *)
    select usr_id, email, email_token(now(), email) as token from usr_
  `;
  if (email && token) await sendVerificationEmail(email, token);
  return ok(c);
});

app.get("/u", authed, async c => {
  const [usr] = await sql`select * from usr u where usr_id = ${c.get("usr_id")!}`;
  if (!usr) return notFound();
  if (!usr.password) return c.redirect("/password");
  return c.html(<Layout title="your account">TODO</Layout>);
});

app.patch("/u", authed, async c => {
  const usr = Object.fromEntries(await c.req.formData());
  for (const i in usr) if (!usr[i]) delete usr[i];
  await sql`update usr set ${sql(usr, "name", "bio")} where usr_id = ${c.get("usr_id")!}`;
  return ok(c);
});

app.get("/u/:usr_id", async c => {
  const [usr] = await sql`select usr_id, name, bio from usr where usr_id = ${c.req.param("usr_id")}`;
  if (!usr) return notFound();
  switch (c.req.header("host")) {
    case "api":
      return c.json(usr, 200);
    default:
      return c.html(<Layout title={usr.name}>TODO</Layout>);
  }
});

app.post("/c/:parent_comment_id?", authed, async c => {
  const comment = {
    parent_comment_id: c.req.param("parent_comment_id") ?? null,
    usr_id: c.get("usr_id")!,
    body: (await form(c)).body,
  };
  await sql`insert into comment ${sql(comment)}`;
  return ok(c);
});

app.get("/c/:comment_id?", async c => {
  const comments = await sql`
    select 
      usr_id, 
      parent_comment_id, 
      body, 
      array(select comment_id from comment c_ where c_.parent_comment_id = c.comment_id) as child_comment_ids
    from comment c
    where comment_id = ${c.req.param("comment_id") ?? null}
    and usr_id = ${c.req.query("usr_id") ?? sql`usr_id`}
    order by created_at desc
  `;
  switch (c.req.header("host")) {
    case "api":
      return c.json(comments, 200);
    case "rss":
      return TODO`RSS not yet implemented`;
    default:
      return c.html(<Layout>TODO</Layout>);
  }
});

app.use("/*", serveStatic({ root: "./public" }));

const server = Deno.serve(
  {
    hostname: Deno.env.get("HOST") ?? "0.0.0.0",
    port: parseInt(Deno.env.get("PORT") ?? "") || 8080,
  },
  app.fetch
);

export default app;
