/** @jsx jsx */

//// IMPORTS ///////////////////////////////////////////////////////////////////

import { Hono } from "https://deno.land/x/hono@v3.11.3/mod.ts";

import { serveStatic, jsx, html } from "https://deno.land/x/hono@v3.11.3/middleware.ts";

import { getSignedCookie, setSignedCookie, deleteCookie } from "https://deno.land/x/hono@v3.11.3/helper.ts";

import pg from "https://deno.land/x/postgresjs@v3.4.3/mod.js";

import sg from "npm:@sendgrid/mail";

//// HELPERS ///////////////////////////////////////////////////////////////////

const TODO = (x: TemplateStringsArray) => {
  throw new Error(`TODO: ${x.raw.join("")}`);
};

//// POSTGRES //////////////////////////////////////////////////////////////////

const sql = pg(Deno.env.get(`DATABASE_URL`)?.replace(/flycast/, "internal")!, { database: "ding" });

//// SENDGRID //////////////////////////////////////////////////////////////////

sg.setApiKey(Deno.env.get(`SENDGRID_API_KEY`) ?? "");

const sendVerificationEmail = async (email: string, token: string) =>
  await sg
    .send({
      to: email,
      from: "hello@futureofcod.ing",
      subject: "Verify your email",
      text:
        `` +
        `Welcome to ᵗ𝕙𝔢 𝐟𝐔𝓉𝓾гє 𝔬𝔣 ᑕⓞ𝓓ƗŇg.` +
        `\n\n` +
        `Please verify your email: ` +
        `https://futureofcod.ing/verify-email` +
        `?email=${encodeURIComponent(email)}` +
        `&token=${encodeURIComponent(token)}`,
    })
    .catch(err => {
      console.log(`/verify-email?email=${email}&token=${token}`);
      console.error(`Could not send verification email to ${email}:`, err?.response?.body || err);
    });

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

const NotFound = () => (
  <Layout title="not found">
    <section>
      <p style="text-align: center;">
        <a href="/">Not found.</a>
      </p>
    </section>
  </Layout>
);

//// HONO //////////////////////////////////////////////////////////////////////

const cookieSecret = Deno.env.get("COOKIE_SECRET") ?? Math.random().toString();

const app = new Hono();

// const app = new Hono({
//   getPath: req => "/" + req.headers.get("host") + "/" + req.url.replace(/^https?:\/\/[^/]+(\/[^?]*)/, "$1"),
// });

app.use("*", async (c, next) => {
  console.log(c.req.method, c.req.url);
  await next();
});

app.notFound(c => c.html(<NotFound />, 404));

app.onError((err, c) => {
  console.error(`${err}`);
  return c.html(
    <Layout title="error">
      <section>
        <p>Sorry, this computer is мᎥｓβ𝕖𝓱𝐀𝓋𝓲𝓷g.</p>
      </section>
    </Layout>,
    500
  );
});

app.get("/robots.txt", c => c.text(`User-agent: *\nDisallow:`));

app.get("/sitemap.txt", c => {
  return TODO`sitemap`;
});

app.get("/", c => {
  return c.html(<Layout desc="TODO"></Layout>);
});

app.post("/signup", async c => {
  try {
    const body = await c.req.parseBody();
    const usr = {
      email: body.email.toString(),
      password: sql`crypt(${body.password.toString()}, gen_salt('bf', 8))`,
    } as Record<string, unknown>;
    const [{ usr_id, email, token }] = await sql`
      with usr_ as (insert into usr ${sql(usr)} returning *)
      select usr_id, email, email_token(now(), email) as token from usr_
    `;
    await sendVerificationEmail(email, token);
    await setSignedCookie(c, "usr_id", usr_id, cookieSecret);
    return c.redirect("/u");
  } catch (err) {
    console.error(err);
    return c.redirect("/");
  }
});

app.post("/login", async c => {
  const { email, password } = await c.req.parseBody();
  const [usr] = await sql`
    select *, password = crypt(${password.toString()}, password) AS is_password_correct
    from usr where email = ${email.toString()}
  `;
  if (!usr || !usr.is_password_correct)
    return c.html(
      <Layout title="try again">
        <section>
          <p>Your password was incorrect.</p>
          <p>
            Please <a href="/u">try again</a>.
          </p>
        </section>
      </Layout>
    );
  if (!usr.email_verified_at) await sendVerificationEmail(usr.email, usr.token);
  await setSignedCookie(c, "usr_id", usr.usr_id, cookieSecret);
  return c.redirect("/u");
});

app.get("/logout", c => {
  deleteCookie(c, "usr_id");
  return c.redirect("/u");
});

app.get("/verify-email", async c => {
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
  return c.redirect("/u");
});

app.get("/forgot-password", c => {
  return c.html(
    <Layout title="welcome">
      <section>
        <form method="post" action="/forgot-password">
          <input required name="email" type="email" placeholder="hello@example.com" />
          <p>
            <button type="submit">send email</button>
          </p>
        </form>
      </section>
    </Layout>
  );
});

app.post("/forgot-password", async c => {
  const email = Object.fromEntries(await c.req.formData()).email.toString();
  const [usr] = await sql`
    select email_token(now(), email) as token from usr where email = ${email}
  `;
  if (usr)
    await sg
      .send({
        to: email,
        from: "hello@futureofcod.ing",
        subject: "Reset your password",
        text:
          `` +
          `Click here to reset your password: ` +
          `https://futureofcod.ing/reset-password` +
          `?email=${encodeURIComponent(email)}` +
          `&token=${encodeURIComponent(usr.token)}` +
          `\n\n` +
          `If you didn't request a password reset, please ignore this message.`,
      })
      .catch(err => {
        console.log(`/reset-password?email=${email}&token=${usr.token}`);
        console.error(`Could not send password reset email to ${email}:`, err?.response?.body || err);
      });
  return c.redirect("/u");
});

app.get("/reset-password", c => {
  const email = c.req.query("email") ?? "";
  const token = c.req.query("token") ?? "";
  return c.html(
    <Layout title="welcome">
      <section>
        <form method="post" action="/reset-password">
          <input required name="email" value={email} class="hidden" />
          <input required name="token" value={token} class="hidden" />
          <input required name="password" type="password" placeholder="password1!" />
          <p>
            <button type="submit">reset password</button>
          </p>
        </form>
      </section>
    </Layout>
  );
});

app.post("/reset-password", async c => {
  const { email, token, password } = Object.fromEntries(await c.req.formData());
  const [usr] = await sql`
    update usr
    set password = crypt(${password.toString()}, gen_salt('bf', 8))
    where true
      and to_timestamp(split_part(${token.toString()},':',1)::bigint) > now() - interval '2 days'
      and ${email.toString()} = email
      and ${token.toString()} = email_token(to_timestamp(split_part(${token.toString()},':',1)::bigint), email)
    returning usr_id
  `;
  if (usr) await setSignedCookie(c, "usr_id", usr.usr_id, cookieSecret);
  return c.redirect("/u");
});

app.get("/u", async c => {
  const usr_id = await getSignedCookie(c, cookieSecret, "usr_id");
  if (!usr_id) return c.html(<Layout title="welcome"></Layout>);
  const [usr] = await sql`
    select u.*
    from usr u
    where usr_id = ${usr_id}
  `;
  if (!usr) return c.html(<NotFound />, 404);
  if (!usr.email_verified_at)
    return c.html(
      <Layout title="login">
        <section>
          <p>email not yet verified</p>
        </section>
      </Layout>
    );
  return c.html(<Layout title="your account"></Layout>);
});

/*

almost all the routes are public, so we can afford to switch response types based on req.headers.get("host")

usr (invite-only?), thread, comment

todo: automatically issue api keys
todo: every route should turn into rss by adding .xml to the end?

get /verify-email : todo
post /forgot-password : todo
post /reset-password : todo
post /u : insert into usr values ${sql(usr,'uid','name','bio','email')}
get /u/:uid : select uid, name, bio from usr where uid = ${uid}
put /u/:uid : update usr set ${sql(usr,'uid','name','bio','email')} where uid = ${uid}
delete /u/:uid : delete from usr where uid = ${uid}
get /u/:uid/c : select cid, body from comments where uid = ${uid}
post /c : todo
get /c/:cid : todo
post /c/:cid : todo
put /c/:cid : todo
delete /c/:cid : todo
*/

app.use("/*", serveStatic({ root: "./public" }));

Deno.serve(
  {
    hostname: Deno.env.get("HOST") ?? "0.0.0.0",
    port: parseInt(Deno.env.get("PORT") ?? "") || 8080,
  },
  app.fetch
);
