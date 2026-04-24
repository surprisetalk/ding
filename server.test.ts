//// IMPORTS ///////////////////////////////////////////////////////////////////

import { assertEquals } from "@std/assert";
import { jsx } from "@hono/hono/jsx";
import pg from "postgres";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { hstore } from "@electric-sql/pglite/contrib/hstore";
import { PostgresConnection } from "pg-gateway";
import "./test_env.ts"; // sets env BEFORE server.tsx module evaluation (ES import order)
import dbSql from "./db.sql" with { type: "text" };

import app, {
  decodeLabels,
  emailToken,
  encodeLabels,
  extractDomains,
  extractImageUrl,
  extractLinks,
  formatBody,
  formatLabels,
  parseLabels,
  postRate,
  resend,
  setSql,
  stripe,
} from "./server.tsx";

//// MOCK SHAPES ///////////////////////////////////////////////////////////////
// Tests monkey-patch Resend and Stripe with narrow stubs; these SDKs don't
// expose testable-mock types, so we define the tiny surface we actually drive.

type SubItem = { id: string; quantity: number };
type Subscription = { items: { data: SubItem[] } };
type UpdateArgs = { items: SubItem[] };
type UpdateCall = { subId: string; args: UpdateArgs };
type EmailMsg = { to: string; subject: string; text: string };

type MockResend = {
  emails: {
    send: (msg: EmailMsg) => Promise<{ data: { id: string }; error: null }>;
  };
};

type MockStripe = {
  checkout: {
    sessions: {
      create: (args?: unknown) => Promise<{ url: string; id: string }>;
      retrieve: () => Promise<{
        status: string;
        subscription: string;
        metadata: { orgName: string; creatorName: string };
      }>;
    };
  };
  subscriptions: {
    retrieve: () => Promise<Subscription>;
    update: (subId: string, args: UpdateArgs) => Promise<unknown>;
  };
  webhooks: {
    constructEventAsync: (body: string, sig: string) => Promise<unknown>;
  };
  __updateCalls: UpdateCall[];
};

const mResend = resend as unknown as MockResend;
const mStripe = stripe as unknown as MockStripe;

// Stub Resend so tests don't make network calls.
const sentEmails: EmailMsg[] = [];
mResend.emails = {
  send: (msg) => {
    sentEmails.push({ to: msg.to, subject: msg.subject, text: msg.text });
    return Promise.resolve({ data: { id: "test_id" }, error: null });
  },
};

//// PGLITE WRAPPER ////////////////////////////////////////////////////////////

const pglite = (f: (sql: pg.Sql) => (t: Deno.TestContext) => Promise<void>) => async (t: Deno.TestContext) => {
  const port = 2000 + Math.floor(Math.random() * 8000);
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  const db = new PGlite({ extensions: { citext, hstore } });
  const testSql = pg(`postgresql://postgres@127.0.0.1:${port}/postgres`, { fetch_types: true });

  (async () => {
    for await (const conn of listener) {
      new PostgresConnection(conn, {
        async onStartup() {
          await db.waitReady;
        },
        async onMessage(data: Uint8Array, { isAuthenticated }: { isAuthenticated: boolean }) {
          if (!isAuthenticated) return;
          if (data[0] === 88) return; // Terminate message
          return await db.execProtocolRaw(data);
        },
      });
    }
  })();

  await db.waitReady;

  // Mock pgcrypto functions for testing (PGlite doesn't have pgcrypto)
  await db.exec(`
    create or replace function gen_salt(text, int default 8) returns text language sql as $$ select 'salt' $$;
    create or replace function crypt(password text, salt text) returns text language sql as $$
      select case when salt like '$%' then password else 'hashed:' || password end
    $$;
  `);

  // Load schema (skip pgcrypto extension since we mocked it; hstore needs explicit CREATE)
  const schema = dbSql.replace(/create extension if not exists pgcrypto;/i, "");
  await db.exec(schema);

  // Insert test users
  await db.exec(`
    insert into usr (name, email, password, bio, email_verified_at, invited_by, orgs_r, orgs_w)
    values ('john_doe', 'john@example.com', 'hashed:password1!', 'sample bio', now(), 'john_doe', '{secret}', '{secret}')
    on conflict do nothing;
  `);

  await db.exec(`
    insert into usr (name, email, password, bio, email_verified_at, invited_by, orgs_r, orgs_w)
    values ('jane_doe', 'jane@example.com', 'hashed:password1!', 'sample bio', now(), 'john_doe', '{}', '{}')
    on conflict do nothing;
  `);

  // Mock Stripe
  mStripe.checkout = {
    sessions: {
      create: () => Promise.resolve({ url: "https://stripe.com/checkout", id: "cs_test_123" }),
      retrieve: () =>
        Promise.resolve({
          status: "complete",
          subscription: "sub_123",
          metadata: { orgName: "TestOrg", creatorName: "john_doe" },
        }),
    },
  };
  mStripe.__updateCalls = [];
  mStripe.subscriptions = {
    retrieve: () => Promise.resolve({ items: { data: [{ id: "si_123", quantity: 1 }] } }),
    update: (subId, args) => {
      mStripe.__updateCalls.push({ subId, args });
      return Promise.resolve({});
    },
  };
  mStripe.webhooks = {
    constructEventAsync: (body, sig) =>
      sig === "valid" ? Promise.resolve(JSON.parse(body)) : Promise.reject(new Error("bad sig")),
  };

  setSql(testSql);
  postRate.clear();
  await f(testSql)(t);

  await testSql.end();
  listener.close();
  await db.close();
};

//// TESTS /////////////////////////////////////////////////////////////////////

Deno.test(
  "routes",
  pglite((sql) => async (t) => {
    await t.step("GET /robots.txt", async () => {
      const res = await app.request("/robots.txt");
      assertEquals(res.status, 200);
    });

    await t.step("POST /login wrong credentials", async () => {
      const body = new FormData();
      body.append("email", "john@example.com");
      body.append("password", "wrong!");
      const res = await app.request("/login", { method: "post", body });
      assertEquals(res.status, 401);
    });

    await t.step("POST /login correct credentials", async () => {
      const body = new FormData();
      body.append("email", "john@example.com");
      body.append("password", "password1!");
      const res = await app.request("/login", { method: "post", body });
      assertEquals(res.status, 302);
    });

    await t.step("GET /forgot", async () => {
      const res = await app.request("/forgot");
      assertEquals(res.status, 200);
    });

    await t.step("POST /forgot valid email", async () => {
      const body = new FormData();
      body.append("email", "john@example.com");
      const res = await app.request("/forgot", { method: "post", body });
      assertEquals(res.status, 302);
    });

    await t.step("POST /password expired token", async () => {
      const body = new FormData();
      body.append("email", "john@example.com");
      body.append("token", "123:expired_token");
      body.append("password", "newpassword1!");
      const res = await app.request("/password", { method: "post", body });
      assertEquals(res.status, 400); // Invalid or expired token
    });

    await t.step("GET /u without auth shows login form", async () => {
      const res = await app.request("/u");
      assertEquals(res.status, 200);
      const text = await res.text();
      assertEquals(text.includes("<h2>login</h2>"), true);
    });

    await t.step("GET /u/:name valid name", async () => {
      const res = await app.request("/u/john_doe");
      assertEquals(res.status, 200);
    });

    await t.step("GET /u/:name invalid name", async () => {
      const res = await app.request("/u/nonexistent_user");
      assertEquals(res.status, 404);
    });

    await t.step("GET /c/:cid valid cid", async () => {
      const res = await app.request("/c/301");
      assertEquals(res.status, 200);
    });

    await t.step("GET /c all comments", async () => {
      const res = await app.request("/c");
      assertEquals(res.status, 200);
    });

    await t.step("GET /c all comments (page 2)", async () => {
      const res = await app.request("/c?p=1");
      assertEquals(res.status, 200);
    });

    await t.step("GET /verify invalid token", async () => {
      const res = await app.request("/verify?email=john@example.com&token=123:invalid_token");
      assertEquals(res.status, 400); // Invalid or expired token
    });

    await t.step("GET /signup shows form", async () => {
      const res = await app.request("/signup");
      assertEquals(res.status, 200);
      const html = await res.text();
      assertEquals(html.includes(`name="name"`), true);
      assertEquals(html.includes(`name="email"`), true);
    });

    await t.step("POST /signup creates unverified user and redirects to ?ok", async () => {
      const body = new FormData();
      body.append("name", "fresh_user");
      body.append("email", "fresh@example.com");
      const res = await app.request("/signup", { method: "POST", body });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/signup?ok");
      const [u] = await sql`select name, email, password, email_verified_at from usr where name = 'fresh_user'`;
      assertEquals(u.email, "fresh@example.com");
      assertEquals(u.password, null);
      assertEquals(u.email_verified_at, null);
    });

    await t.step("POST /signup duplicate name (different email) redirects to ?error=name_taken", async () => {
      const body = new FormData();
      body.append("name", "john_doe");
      body.append("email", "different@example.com");
      const res = await app.request("/signup", { method: "POST", body });
      assertEquals(res.status, 302);
      assertEquals(
        res.headers.get("location"),
        `/signup?error=name_taken&email=${encodeURIComponent("different@example.com")}`,
      );
      const [{ count }] = await sql`select count(*)::int as count from usr where name = 'john_doe'`;
      assertEquals(count, 1);
    });

    await t.step("POST /signup duplicate verified email redirects to ?error=already_verified", async () => {
      const body = new FormData();
      body.append("name", "different_name");
      body.append("email", "john@example.com");
      const res = await app.request("/signup", { method: "POST", body });
      assertEquals(res.status, 302);
      assertEquals(
        res.headers.get("location"),
        `/signup?error=already_verified&email=${encodeURIComponent("john@example.com")}`,
      );
      const [{ count }] = await sql`select count(*)::int as count from usr where name = 'different_name'`;
      assertEquals(count, 0);
    });

    await t.step("POST /signup duplicate unverified email re-sends and redirects to ?ok", async () => {
      // fresh_user from earlier step is unverified
      const body = new FormData();
      body.append("name", "yet_another");
      body.append("email", "fresh@example.com");
      const res = await app.request("/signup", { method: "POST", body });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/signup?ok");
      // No new row inserted under the second name
      const [{ count }] = await sql`select count(*)::int as count from usr where name = 'yet_another'`;
      assertEquals(count, 0);
    });

    await t.step("POST /signup/resend for unverified email redirects to ?resent", async () => {
      const body = new FormData();
      body.append("email", "fresh@example.com");
      const res = await app.request("/signup/resend", { method: "POST", body });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/signup?resent");
    });

    await t.step("POST /signup/resend for verified email redirects to ?error=already_verified", async () => {
      const body = new FormData();
      body.append("email", "john@example.com");
      const res = await app.request("/signup/resend", { method: "POST", body });
      assertEquals(res.status, 302);
      assertEquals(
        res.headers.get("location"),
        `/signup?error=already_verified&email=${encodeURIComponent("john@example.com")}`,
      );
    });

    await t.step("POST /signup/resend for unknown email redirects to ?error=conflict", async () => {
      const body = new FormData();
      body.append("email", "nobody@example.com");
      const res = await app.request("/signup/resend", { method: "POST", body });
      assertEquals(res.status, 302);
      assertEquals(
        res.headers.get("location"),
        `/signup?error=conflict&email=${encodeURIComponent("nobody@example.com")}`,
      );
    });

    await t.step("GET /signup renders error message for ?error=name_taken", async () => {
      const res = await app.request("/signup?error=name_taken&email=x%40y.com");
      const html = await res.text();
      assertEquals(html.includes("already taken"), true);
    });

    await t.step("GET /verify with valid token sets email_verified_at for signup user", async () => {
      const tok = await emailToken(new Date(), "fresh@example.com");
      const res = await app.request(
        `/verify?email=${encodeURIComponent("fresh@example.com")}&token=${encodeURIComponent(tok)}`,
      );
      assertEquals(res.status < 400, true);
      const [u] = await sql`select email_verified_at from usr where name = 'fresh_user'`;
      assertEquals(u.email_verified_at !== null, true);
    });

    await t.step("GET /u with valid credentials", async () => {
      const res = await app.request("/u", {
        headers: {
          Authorization: "Basic " + btoa("john@example.com:password1!"),
        },
      });
      assertEquals(res.status, 200);
    });

    await t.step("GET /u with invalid credentials", async () => {
      const res = await app.request("/u", {
        headers: { Authorization: "Basic " + btoa("john@example.com:wrong!") },
      });
      assertEquals(res.status, 401);
    });

    await t.step("GET /u with next param shows login form with redirect", async () => {
      const res = await app.request("/u?next=%2Fc%2F123");
      assertEquals(res.status, 200);
      const text = await res.text();
      assertEquals(text.includes("/login?next=%2Fc%2F123"), true);
    });

    await t.step("GET / (default hot sort)", async () => {
      const res = await app.request("/");
      assertEquals(res.status, 200);
    });

    await t.step("GET /?sort=new", async () => {
      const res = await app.request("/?sort=new");
      assertEquals(res.status, 200);
    });

    await t.step("GET /?sort=top", async () => {
      const res = await app.request("/?sort=top");
      assertEquals(res.status, 200);
    });

    await t.step("GET /c with tag filter", async () => {
      const res = await app.request("/c?tag=humor");
      assertEquals(res.status, 200);
    });

    await t.step("GET /c with multiple tag filters", async () => {
      const res = await app.request("/c?tag=humor&tag=bugs");
      assertEquals(res.status, 200);
    });

    await t.step("GET /c/:cid for private post (access denied - shows 404)", async () => {
      // 355 is a secret post in db.sql. Unauthenticated access should return 404 for privacy.
      const res = await app.request("/c/355");
      assertEquals(res.status, 404);
    });

    await t.step("GET /c/:cid for non-existent post (404)", async () => {
      const res = await app.request("/c/999999");
      assertEquals(res.status, 404);
    });

    await t.step("GET /c/:cid logged out shows signup form", async () => {
      const res = await app.request("/c/301");
      assertEquals(res.status, 200);
      const html = await res.text();
      assertEquals(html.includes("create an account to reply"), true);
      assertEquals(html.includes(`action="/signup"`), true);
      assertEquals(html.includes(`pattern="^[0-9a-zA-Z_]{4,32}$"`), true);
      assertEquals(html.includes(`/u?next=%2Fc%2F301`), true);
    });

    await t.step("GET /c?tag=humor renders single-tag header and 'post to' action", async () => {
      const res = await app.request("/c?tag=humor");
      const html = await res.text();
      assertEquals(html.includes(`<h2>#humor</h2>`), true);
      assertEquals(html.includes("post to #humor"), true);
      assertEquals(html.includes(`href="/?tag=humor"`), true);
    });

    await t.step("GET /c?tag=humor&tag=bugs does not render single-tag header", async () => {
      const res = await app.request("/c?tag=humor&tag=bugs");
      const html = await res.text();
      assertEquals(html.includes("post to #humor"), false);
      assertEquals(html.includes("post to #bugs"), false);
    });

    await t.step("GET /c?usr=BugHunter42 renders single-user header and 'post to' action", async () => {
      const res = await app.request("/c?usr=BugHunter42");
      const html = await res.text();
      assertEquals(html.includes(`<h2>@BugHunter42</h2>`), true);
      assertEquals(html.includes(`href="/u/BugHunter42"`), true);
      assertEquals(html.includes("post to @BugHunter42"), true);
    });

    await t.step("GET /c?org=secret renders single-org header for member", async () => {
      const loginBody = new FormData();
      loginBody.append("email", "john@example.com");
      loginBody.append("password", "password1!");
      const boot = await app.request("/login", { method: "POST", body: loginBody });
      const cookie = boot.headers.get("set-cookie")!.split(";")[0];
      const res = await app.request("/c?org=secret", { headers: { cookie } });
      const html = await res.text();
      assertEquals(html.includes(`<h2>*secret</h2>`), true);
      assertEquals(html.includes("post to *secret"), true);
    });

    await t.step("GET /c with Accept: application/json returns JSON array", async () => {
      const res = await app.request("/c", { headers: { Accept: "application/json" } });
      assertEquals(res.status, 200);
      const data = await res.json();
      assertEquals(Array.isArray(data), true);
      assertEquals(data.length > 0, true);
    });

    await t.step("GET /c with browser Accept header returns HTML, not RSS", async () => {
      const res = await app.request("/c", {
        headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      });
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type")?.includes("text/html"), true);
      const body = await res.text();
      assertEquals(body.startsWith("<?xml"), false);
    });

    await t.step("GET /c with feed-reader Accept returns RSS", async () => {
      const res = await app.request("/c", { headers: { Accept: "application/rss+xml" } });
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type")?.includes("xml"), true);
      const body = await res.text();
      assertEquals(body.startsWith("<?xml"), true);
    });

    await t.step("GET /c/:cid with Accept: application/json returns JSON", async () => {
      const res = await app.request("/c/301", { headers: { Accept: "application/json" } });
      assertEquals(res.status, 200);
      const data = await res.json();
      assertEquals(Array.isArray(data), true);
      assertEquals(data[0].cid, 301);
      assertEquals(data[0].created_by, "BugHunter42");
    });

    await t.step("GET /u/:name JSON as non-owner hides orgs_r/orgs_w", async () => {
      const res = await app.request("/u/john_doe", { headers: { Accept: "application/json" } });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.name, "john_doe");
      assertEquals("orgs_r" in body, false);
      assertEquals("orgs_w" in body, false);
    });

    await t.step("GET /u/:name JSON as owner via Basic Auth exposes orgs_r/orgs_w", async () => {
      const res = await app.request("/u/john_doe", {
        headers: {
          Accept: "application/json",
          Authorization: "Basic " + btoa("john@example.com:password1!"),
        },
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.name, "john_doe");
      assertEquals(body.bio, "sample bio");
      assertEquals(body.invited_by, "john_doe");
      assertEquals(body.orgs_r, ["secret"]);
      assertEquals(body.orgs_w, ["secret"]);
    });

    await t.step("GET /u/:name JSON with invalid Basic Auth hides owner fields (non-owner view)", async () => {
      const res = await app.request("/u/john_doe", {
        headers: {
          Accept: "application/json",
          Authorization: "Basic " + btoa("john@example.com:wrong!"),
        },
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.name, "john_doe");
      assertEquals("orgs_r" in body, false);
      assertEquals("orgs_w" in body, false);
    });
  }),
);

//// ORG TESTS /////////////////////////////////////////////////////////////////

Deno.test(
  "Org Management",
  pglite((sql) => async (t) => {
    const authHeaders = {
      Authorization: "Basic " + btoa("john@example.com:password1!"),
    };

    await t.step("POST /o/new creates Checkout Session", async () => {
      const body = new FormData();
      body.append("name", "TestOrg");
      const res = await app.request("/o/new", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "https://stripe.com/checkout");
    });

    await t.step("POST /api/stripe-webhook checkout.session.completed creates org", async () => {
      const body = JSON.stringify({
        type: "checkout.session.completed",
        data: { object: { subscription: "sub_webhook", metadata: { orgName: "WebhookOrg", creatorName: "john_doe" } } },
      });
      const res = await app.request("/api/stripe-webhook", {
        method: "POST",
        body,
        headers: { "stripe-signature": "valid" },
      });
      assertEquals(res.status, 200);

      const [org] = await sql`select * from org where name = 'WebhookOrg'`;
      assertEquals(org.created_by, "john_doe");
      assertEquals(org.stripe_sub_id, "sub_webhook");
      const [usr] = await sql`select orgs_r, orgs_w from usr where name = 'john_doe'`;
      assertEquals(usr.orgs_r.includes("WebhookOrg"), true);
      assertEquals(usr.orgs_w.includes("WebhookOrg"), true);
    });

    await t.step("POST /api/stripe-webhook checkout.session.completed is idempotent", async () => {
      const body = JSON.stringify({
        type: "checkout.session.completed",
        data: { object: { subscription: "sub_webhook", metadata: { orgName: "WebhookOrg", creatorName: "john_doe" } } },
      });
      await app.request("/api/stripe-webhook", { method: "POST", body, headers: { "stripe-signature": "valid" } });
      const [usr] = await sql`select orgs_r from usr where name = 'john_doe'`;
      assertEquals(usr.orgs_r.filter((o: string) => o === "WebhookOrg").length, 1);
    });

    await t.step("GET /o/success creates org and updates user", async () => {
      const res = await app.request("/o/success?session_id=cs_test_123", { headers: authHeaders });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/o/TestOrg");

      // Verify DB
      const [org] = await sql`select * from org where name = 'TestOrg'`;
      assertEquals(org.name, "TestOrg");
      assertEquals(org.created_by, "john_doe");
      assertEquals(org.stripe_sub_id, "sub_123");

      const [usr] = await sql`select orgs_r, orgs_w from usr where name = 'john_doe'`;
      assertEquals(usr.orgs_r.includes("TestOrg"), true);
      assertEquals(usr.orgs_w.includes("TestOrg"), true);
    });

    await t.step("POST /o/:name/invite by email adds existing member and bumps Stripe quantity", async () => {
      mStripe.__updateCalls.length = 0;
      const body = new FormData();
      body.append("email", "jane@example.com");
      const res = await app.request("/o/TestOrg/invite", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 302);

      const [usr] = await sql`select orgs_r, orgs_w from usr where name = 'jane_doe'`;
      assertEquals(usr.orgs_r.includes("TestOrg"), true);
      assertEquals(usr.orgs_w.includes("TestOrg"), true);

      const calls = mStripe.__updateCalls;
      assertEquals(calls.length, 1);
      assertEquals(calls[0].args.items[0].quantity, 2);
    });

    await t.step("POST /o/:name/invite matches email case-insensitively", async () => {
      // jane is already a member from the prior step; mixed case should be idempotent, not create a placeholder
      mStripe.__updateCalls.length = 0;
      const body = new FormData();
      body.append("email", "JANE@Example.com");
      const res = await app.request("/o/TestOrg/invite", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 302);
      assertEquals(mStripe.__updateCalls.length, 0);
      const users = await sql`select name from usr where email = 'jane@example.com'`;
      assertEquals(users.length, 1);
    });

    await t.step("POST /o/:name/invite new email creates placeholder user with org membership", async () => {
      mStripe.__updateCalls.length = 0;
      const body = new FormData();
      body.append("email", "newbie@example.com");
      const res = await app.request("/o/TestOrg/invite", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 302);

      const [usr] =
        await sql`select name, password, email_verified_at, orgs_r, orgs_w, invited_by from usr where email = 'newbie@example.com'`;
      assertEquals(typeof usr.name, "string");
      assertEquals(usr.password, null);
      assertEquals(usr.email_verified_at, null);
      assertEquals(usr.invited_by, "john_doe");
      assertEquals(usr.orgs_r.includes("TestOrg"), true);
      assertEquals(usr.orgs_w.includes("TestOrg"), true);

      const calls = mStripe.__updateCalls;
      assertEquals(calls.length, 1);
      assertEquals(calls[0].args.items[0].quantity, 2);
    });

    await t.step("POST /o/:name/invite duplicate email is no-op, no Stripe call, no duped array entry", async () => {
      mStripe.__updateCalls.length = 0;
      const body = new FormData();
      body.append("email", "jane@example.com");
      const res = await app.request("/o/TestOrg/invite", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 302);
      assertEquals(mStripe.__updateCalls.length, 0);
      const [usr] = await sql`select orgs_r from usr where name = 'jane_doe'`;
      assertEquals(usr.orgs_r.filter((o: string) => o === "TestOrg").length, 1);
    });

    await t.step("POST /o/:name/invite 400 for missing/invalid email, no Stripe call", async () => {
      mStripe.__updateCalls.length = 0;
      const body = new FormData();
      body.append("email", "not-an-email");
      const res = await app.request("/o/TestOrg/invite", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 400);
      assertEquals(mStripe.__updateCalls.length, 0);
    });

    await t.step("POST /o/:name/invite 403 for non-owner", async () => {
      const janeAuth = { Authorization: "Basic " + btoa("jane@example.com:password1!") };
      mStripe.__updateCalls.length = 0;
      const body = new FormData();
      body.append("email", "john@example.com");
      const res = await app.request("/o/TestOrg/invite", { method: "POST", body, headers: janeAuth });
      assertEquals(res.status, 403);
      assertEquals(mStripe.__updateCalls.length, 0);
    });

    await t.step("POST /o/:name/remove removes member", async () => {
      const body = new FormData();
      body.append("name", "jane_doe");
      const res = await app.request("/o/TestOrg/remove", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 302);

      const [usr] = await sql`select orgs_r, orgs_w from usr where name = 'jane_doe'`;
      assertEquals(usr.orgs_r.includes("TestOrg"), false);
      assertEquals(usr.orgs_w.includes("TestOrg"), false);
    });

    await t.step("POST /o/:name/remove non-member returns 404, no Stripe call", async () => {
      mStripe.__updateCalls.length = 0;
      const body = new FormData();
      body.append("name", "jane_doe");
      const res = await app.request("/o/TestOrg/remove", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 404);
      assertEquals(mStripe.__updateCalls.length, 0);
    });

    await t.step("POST /o/:name/remove by self (non-owner) leaves org and decrements Stripe qty", async () => {
      await sql`update usr set orgs_r = array_append(orgs_r, 'TestOrg'), orgs_w = array_append(orgs_w, 'TestOrg') where name = 'jane_doe'`;
      mStripe.__updateCalls.length = 0;
      const origRetrieve = mStripe.subscriptions.retrieve;
      mStripe.subscriptions.retrieve = () => Promise.resolve({ items: { data: [{ id: "si_123", quantity: 2 }] } });

      const janeAuth = { Authorization: "Basic " + btoa("jane@example.com:password1!") };
      const body = new FormData();
      body.append("name", "jane_doe");
      const res = await app.request("/o/TestOrg/remove", { method: "POST", body, headers: janeAuth });
      assertEquals(res.status, 302);

      const [usr] = await sql`select orgs_r, orgs_w from usr where name = 'jane_doe'`;
      assertEquals(usr.orgs_r.includes("TestOrg"), false);
      assertEquals(usr.orgs_w.includes("TestOrg"), false);

      const calls = mStripe.__updateCalls;
      assertEquals(calls.length, 1);
      assertEquals(calls[0].args.items[0].quantity, 1);

      mStripe.subscriptions.retrieve = origRetrieve;
    });

    await t.step("POST /o/:name/remove owner cannot leave own org", async () => {
      mStripe.__updateCalls.length = 0;
      const body = new FormData();
      body.append("name", "john_doe");
      const res = await app.request("/o/TestOrg/remove", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 400);
      assertEquals(mStripe.__updateCalls.length, 0);
      const [usr] = await sql`select orgs_r from usr where name = 'john_doe'`;
      assertEquals(usr.orgs_r.includes("TestOrg"), true);
    });

    await t.step("POST /o/:name/remove by non-owner targeting another member returns 403", async () => {
      await sql`update usr set orgs_r = array_append(orgs_r, 'TestOrg'), orgs_w = array_append(orgs_w, 'TestOrg') where name = 'jane_doe'`;
      mStripe.__updateCalls.length = 0;
      const janeAuth = { Authorization: "Basic " + btoa("jane@example.com:password1!") };
      const body = new FormData();
      body.append("name", "john_doe");
      const res = await app.request("/o/TestOrg/remove", { method: "POST", body, headers: janeAuth });
      assertEquals(res.status, 403);
      assertEquals(mStripe.__updateCalls.length, 0);
    });

    await t.step("POST /o/new with taken name returns 409, no Stripe Checkout", async () => {
      const stripeCreateCalls: unknown[] = [];
      const origCreate = mStripe.checkout.sessions.create;
      mStripe.checkout.sessions.create = (args) => {
        stripeCreateCalls.push(args);
        return origCreate(args);
      };
      const body = new FormData();
      body.append("name", "TestOrg");
      const res = await app.request("/o/new", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 409);
      assertEquals(stripeCreateCalls.length, 0);
      mStripe.checkout.sessions.create = origCreate;
    });
  }),
);

//// WRITE PATH TESTS //////////////////////////////////////////////////////////

Deno.test(
  "write paths",
  pglite((sql) => async (t) => {
    const jAuth = { Authorization: "Basic " + btoa("john@example.com:password1!") };
    const janeAuth = { Authorization: "Basic " + btoa("jane@example.com:password1!") };
    const fd = (o: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(o)) f.append(k, v);
      return f;
    };
    const cidFromLocation = (loc: string) => {
      const m = loc.match(/^\/c\/(\d+)/);
      if (!m) throw new Error(`bad location: ${loc}`);
      return +m[1];
    };

    await t.step("POST /c root happy path", async () => {
      const res = await app.request("/c", {
        method: "POST",
        body: fd({ body: "hello world", tags: "#pub" }),
        headers: jAuth,
      });
      assertEquals(res.status, 302);
      const cid = cidFromLocation(res.headers.get("location")!);
      const [row] = await sql`select body, tags, orgs, thumb from com where cid = ${cid}`;
      assertEquals(row.body, "hello world");
      assertEquals(row.tags, ["pub"]);
      assertEquals(row.orgs, []);
      assertEquals(row.thumb, null);
    });

    await t.step("POST /c root 403 when no tag", async () => {
      const res = await app.request("/c", { method: "POST", body: fd({ body: "no tag", tags: "" }), headers: jAuth });
      assertEquals(res.status, 403);
    });

    await t.step("POST /c root 403 when *org not in orgs_w", async () => {
      const res = await app.request("/c", {
        method: "POST",
        body: fd({ body: "x", tags: "#pub *nonmember" }),
        headers: jAuth,
      });
      assertEquals(res.status, 403);
    });

    await t.step("POST /c root 302 when *org IS in orgs_w", async () => {
      const res = await app.request("/c", {
        method: "POST",
        body: fd({ body: "y", tags: "#pub *secret" }),
        headers: jAuth,
      });
      assertEquals(res.status, 302);
      const cid = cidFromLocation(res.headers.get("location")!);
      const [row] = await sql`select orgs from com where cid = ${cid}`;
      assertEquals(row.orgs, ["secret"]);
    });

    await t.step("POST /c root unauthed redirects to /u?next=", async () => {
      const res = await app.request("/c", { method: "POST", body: fd({ body: "x", tags: "#pub" }) });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location")?.startsWith("/u?next="), true);
    });

    await t.step("POST /c root extracts thumbnail from image URL", async () => {
      const res = await app.request("/c", {
        method: "POST",
        body: fd({ body: "look https://example.com/pic.jpg", tags: "#pub" }),
        headers: jAuth,
      });
      assertEquals(res.status, 302);
      const cid = cidFromLocation(res.headers.get("location")!);
      const [row] = await sql`select thumb from com where cid = ${cid}`;
      assertEquals(row.thumb, "https://example.com/pic.jpg");
    });

    await t.step("POST /c/:p reply happy path + c_comments increments", async () => {
      const [before] = await sql`select c_comments from com where cid = 301`;
      const res = await app.request("/c/301", { method: "POST", body: fd({ body: "reply text" }), headers: jAuth });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location")?.startsWith("/c/301#"), true);
      const [after] = await sql`select c_comments from com where cid = 301`;
      assertEquals(+after.c_comments, +before.c_comments + 1);
    });

    await t.step("POST /c/:p reaction updates c_reactions", async () => {
      const [before] = await sql`select (c_reactions->'▲') as r from com where cid = 301`;
      const res = await app.request("/c/301", { method: "POST", body: fd({ body: "▲" }), headers: jAuth });
      assertEquals(res.status, 302);
      const [after] = await sql`select (c_reactions->'▲') as r from com where cid = 301`;
      assertEquals(+after.r, +(before.r ?? 0) + 1);
    });

    await t.step("POST /c/:p flag updates c_flags, records flagger, no com row", async () => {
      const [seed] =
        await sql`insert into com (created_by, body, tags) values ('BugHunter42', 'flag me', '{humor}') returning cid`;
      const [childrenBefore] = await sql`select count(*)::int as n from com where parent_cid = ${seed.cid}`;
      const res = await app.request(`/c/${seed.cid}`, { method: "POST", body: fd({ body: "flag" }), headers: jAuth });
      assertEquals(res.status, 302);
      const [after] = await sql`select c_flags, c_comments, flaggers from com where cid = ${seed.cid}`;
      assertEquals(+after.c_flags, 1);
      assertEquals(+after.c_comments, 0);
      assertEquals(after.flaggers, ["john_doe"]);
      const [childrenAfter] = await sql`select count(*)::int as n from com where parent_cid = ${seed.cid}`;
      assertEquals(childrenAfter.n, childrenBefore.n);
    });

    await t.step("POST /c/:p flag is idempotent per-user", async () => {
      const [seed] =
        await sql`insert into com (created_by, body, tags) values ('BugHunter42', 'flag once', '{humor}') returning cid`;
      await app.request(`/c/${seed.cid}`, { method: "POST", body: fd({ body: "flag" }), headers: jAuth });
      await app.request(`/c/${seed.cid}`, { method: "POST", body: fd({ body: "flag" }), headers: jAuth });
      const [row] = await sql`select c_flags, flaggers from com where cid = ${seed.cid}`;
      assertEquals(+row.c_flags, 1);
      assertEquals(row.flaggers, ["john_doe"]);
    });

    await t.step("POST /c/:p self-flag blocked with err=self-flag", async () => {
      const [seed] =
        await sql`insert into com (created_by, body, tags) values ('jane_doe', 'mine', '{humor}') returning cid`;
      const res = await app.request(`/c/${seed.cid}`, {
        method: "POST",
        body: fd({ body: "flag" }),
        headers: janeAuth,
      });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location")?.includes("err=self-flag"), true);
      const [row] = await sql`select c_flags, flaggers from com where cid = ${seed.cid}`;
      assertEquals(+row.c_flags, 0);
      assertEquals(row.flaggers, []);
    });

    await t.step("GET /c/:cid hides body when c_flags >= threshold for non-author", async () => {
      const [seed] =
        await sql`insert into com (created_by, body, tags, c_flags, flaggers) values ('BugHunter42', 'secret body text', '{humor}', 3, '{a,b,c}') returning cid`;
      const res = await app.request(`/c/${seed.cid}`, { headers: jAuth });
      const html = await res.text();
      assertEquals(html.includes(`class="body"`), true);
      assertEquals(html.includes("[flagged]"), true);
      assertEquals(
        /class="body">\s*secret body text/.test(html),
        false,
      );
    });

    await t.step("POST /c/:p reply 403 on private parent from non-member", async () => {
      const res = await app.request("/c/355", { method: "POST", body: fd({ body: "sneaky" }), headers: janeAuth });
      assertEquals(res.status, 403);
    });

    await t.step("POST /c/:cid/delete owner soft-deletes", async () => {
      const [seed] =
        await sql`insert into com (created_by, body, tags) values ('john_doe', 'to delete', '{humor}') returning cid`;
      const res = await app.request(`/c/${seed.cid}/delete`, { method: "POST", body: new FormData(), headers: jAuth });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/");
      const [row] = await sql`select body from com where cid = ${seed.cid}`;
      assertEquals(row.body, "");
    });

    await t.step("POST /c/:cid/delete non-owner no-op", async () => {
      const [before] = await sql`select body from com where cid = 301`;
      const res = await app.request("/c/301/delete", { method: "POST", body: new FormData(), headers: jAuth });
      assertEquals(res.status, 302);
      const [after] = await sql`select body from com where cid = 301`;
      assertEquals(after.body, before.body);
    });

    await t.step("GET /c/355 returns 200 for member (positive private access)", async () => {
      const boot = await app.request("/login", {
        method: "POST",
        body: fd({ email: "john@example.com", password: "password1!" }),
      });
      const setCookie = boot.headers.get("set-cookie");
      if (!setCookie) throw new Error("no set-cookie on login");
      const cookie = setCookie.split(";")[0];
      const res = await app.request("/c/355", { headers: { cookie } });
      assertEquals(res.status, 200);
    });

    await t.step("POST /api/stripe-webhook customer.subscription.deleted cleans up", async () => {
      await sql`insert into org (name, created_by, stripe_sub_id) values ('WipeMe', 'john_doe', 'sub_wipe')`;
      await sql`update usr set orgs_r = array_append(orgs_r, 'WipeMe'), orgs_w = array_append(orgs_w, 'WipeMe') where name = 'john_doe'`;
      const body = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_wipe" } } });
      const res = await app.request("/api/stripe-webhook", {
        method: "POST",
        body,
        headers: { "stripe-signature": "valid" },
      });
      assertEquals(res.status, 200);
      assertEquals(await res.text(), "Received");
      const [{ count }] = await sql`select count(*)::int as count from org where name = 'WipeMe'`;
      assertEquals(count, 0);
      const [usr] = await sql`select orgs_r, orgs_w from usr where name = 'john_doe'`;
      assertEquals(usr.orgs_r.includes("WipeMe"), false);
      assertEquals(usr.orgs_w.includes("WipeMe"), false);
      assertEquals(usr.orgs_r.includes("secret"), true);
      assertEquals(usr.orgs_w.includes("secret"), true);
    });

    await t.step("POST /api/stripe-webhook invalid signature returns 400", async () => {
      const body = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "whatever" } } });
      const res = await app.request("/api/stripe-webhook", {
        method: "POST",
        body,
        headers: { "stripe-signature": "bad" },
      });
      assertEquals(res.status, 400);
    });

    await t.step("GET /verify valid token sets email_verified_at only on matching email", async () => {
      await sql`insert into usr (name, email, bio, invited_by, email_verified_at) values ('verify_me', 'verify@example.com', 'bio', 'john_doe', null)`;
      await sql`insert into usr (name, email, bio, invited_by, email_verified_at) values ('canary_me', 'canary@example.com', 'bio', 'john_doe', null)`;
      const tok = await emailToken(new Date(), "verify@example.com");
      const res = await app.request(
        `/verify?email=${encodeURIComponent("verify@example.com")}&token=${encodeURIComponent(tok)}`,
      );
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/u");
      const [row] = await sql`select email_verified_at from usr where name = 'verify_me'`;
      assertEquals(row.email_verified_at !== null, true);
      const [canary] = await sql`select email_verified_at from usr where name = 'canary_me'`;
      assertEquals(canary.email_verified_at, null);
    });

    await t.step("GET /verify rejects valid token with wrong email", async () => {
      const tok = await emailToken(new Date(), "verify@example.com");
      const res = await app.request(
        `/verify?email=${encodeURIComponent("canary@example.com")}&token=${encodeURIComponent(tok)}`,
      );
      assertEquals(res.status, 400);
      const [canary] = await sql`select email_verified_at from usr where name = 'canary_me'`;
      assertEquals(canary.email_verified_at, null);
    });

    await t.step("POST /c/:p reaction toggle removes on second click", async () => {
      const [seed] =
        await sql`insert into com (created_by, body, tags) values ('BugHunter42', 'toggle test', '{humor}') returning cid`;
      const res1 = await app.request(`/c/${seed.cid}`, { method: "POST", body: fd({ body: "👍" }), headers: janeAuth });
      assertEquals(res1.status, 302);
      const [after1] = await sql`select (c_reactions->'👍') as r from com where cid = ${seed.cid}`;
      assertEquals(after1.r, "1");
      const res2 = await app.request(`/c/${seed.cid}`, { method: "POST", body: fd({ body: "👍" }), headers: janeAuth });
      assertEquals(res2.status, 302);
      const [after2] = await sql`select (c_reactions->'👍') as r from com where cid = ${seed.cid}`;
      assertEquals(after2.r, "0");
      const [gone] =
        await sql`select count(*)::int as c from com where parent_cid = ${seed.cid} and body = '👍' and created_by = 'jane_doe'`;
      assertEquals(gone.c, 0);
    });

    await t.step("POST /c/:p self-reaction blocked with error feedback", async () => {
      const [seed] =
        await sql`insert into com (created_by, body, tags) values ('jane_doe', 'jane own post', '{humor}') returning cid`;
      const res = await app.request(`/c/${seed.cid}`, { method: "POST", body: fd({ body: "▲" }), headers: janeAuth });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location")?.includes("err=self-react"), true);
      const [cnt] = await sql`select count(*)::int as c from com where parent_cid = ${seed.cid} and body = '▲'`;
      assertEquals(cnt.c, 0);
      const [row] = await sql`select (c_reactions->'▲') as r from com where cid = ${seed.cid}`;
      assertEquals(row.r, null);
    });

    await t.step("GET /c/:cid shows backlinks from posts linking to it", async () => {
      const [p1] =
        await sql`insert into com (created_by, body, tags) values ('john_doe', 'target post', '{backtest}') returning cid`;
      await sql`insert into com (created_by, body, tags, links) values ('john_doe', ${
        "check out https://ding.bar/c/" + p1.cid + " cool"
      }, '{backtest}', ${[p1.cid]}) returning cid`;
      const res = await app.request(`/c/${p1.cid}`);
      assertEquals(res.status, 200);
      const text = await res.text();
      assertEquals(text.includes("backlinks"), true);
      assertEquals(text.includes(`check out https://ding.bar/c/${p1.cid}`), true);
    });

    await t.step("GET /c/:cid no backlinks when no posts link to it", async () => {
      const [p] =
        await sql`insert into com (created_by, body, tags) values ('john_doe', 'lonely post', '{uniquetag_xyz}') returning cid`;
      const res = await app.request(`/c/${p.cid}`);
      assertEquals(res.status, 200);
      const text = await res.text();
      assertEquals(text.includes("backlinks"), false);
    });

    await t.step("GET /c/:cid no false backlink match on similar cid", async () => {
      const [p1] =
        await sql`insert into com (created_by, body, tags) values ('john_doe', 'post A', '{advtest}') returning cid`;
      const fakeCid = p1.cid * 10 + 9;
      await sql`insert into com (created_by, body, tags, links) values ('john_doe', ${
        "see https://ding.bar/c/" + fakeCid
      }, '{advtest}', ${[fakeCid]}) returning cid`;
      const res = await app.request(`/c/${p1.cid}`);
      assertEquals(res.status, 200);
      const text = await res.text();
      assertEquals(text.includes("backlinks"), false);
    });

    await t.step("POST /c rate-limits after 10 posts per 60s", async () => {
      await sql`insert into usr (name, email, password, bio, invited_by, email_verified_at) values ('rate_tester', 'rate@example.com', 'hashed:rate!', 'bio', 'john_doe', now())`;
      const auth = { Authorization: "Basic " + btoa("rate@example.com:rate!") };
      for (let i = 0; i < 10; i++) {
        const res = await app.request("/c", {
          method: "POST",
          body: fd({ body: `post ${i}`, tags: "#pub" }),
          headers: auth,
        });
        assertEquals(res.status, 302);
      }
      const res = await app.request("/c", {
        method: "POST",
        body: fd({ body: "overflow", tags: "#pub" }),
        headers: auth,
      });
      assertEquals(res.status, 429);
    });
  }),
);

//// RECOMMENDATION SCORING TESTS //////////////////////////////////////////////

Deno.test(
  "recommendation scoring",
  pglite((sql) => async (t) => {
    const mkPost = async (author: string, body: string, tags: string[], domains: string[] = []) => {
      const [r] =
        await sql`insert into com (created_by, body, tags, domains) values (${author}, ${body}, ${tags}, ${domains}) returning cid`;
      await sql`select refresh_score(array(select cid from com where created_by = ${author}))`;
      return r.cid as number;
    };
    const react = async (reactor: string, pid: number, body: string) => {
      await sql`insert into com (parent_cid, created_by, body, tags) values (${pid}, ${reactor}, ${body}, '{x}')`;
      await sql`update com set c_reactions = c_reactions || hstore(${body}, (coalesce((c_reactions->${body})::int,0)+1)::text) where cid = ${pid}`;
      const [p] = await sql`select created_by, tags, domains from com where cid = ${pid}`;
      await sql`select refresh_score(array(
        select cid from com where cid = ${pid} or created_by = ${p.created_by} or tags && ${p.tags}::text[]
          ${p.domains.length ? sql`or domains && ${p.domains}::text[]` : sql``}
      ))`;
    };
    const unreact = async (reactor: string, pid: number, body: string) => {
      await sql`delete from com where parent_cid = ${pid} and created_by = ${reactor} and body = ${body}`;
      await sql`update com set c_reactions = c_reactions || hstore(${body}, greatest(coalesce((c_reactions->${body})::int,0)-1, 0)::text) where cid = ${pid}`;
      const [p] = await sql`select created_by, tags, domains from com where cid = ${pid}`;
      await sql`select refresh_score(array(
        select cid from com where cid = ${pid} or created_by = ${p.created_by} or tags && ${p.tags}::text[]
          ${p.domains.length ? sql`or domains && ${p.domains}::text[]` : sql``}
      ))`;
    };
    const score = async (cid: number) => {
      const [r] = await sql`select score from com where cid = ${cid}`;
      return new Date(r.score).getTime();
    };
    const mkUser = async (name: string) => {
      await sql`insert into usr (name, email, password, bio, email_verified_at, invited_by) values (${name}, ${
        name + "@x.com"
      }, 'x', 'x', now(), 'john_doe') on conflict do nothing`;
    };

    await t.step("heavily-upvoted author ranks above new author", async () => {
      for (const u of ["rep_high", "rep_low", "rater1", "rater2"]) await mkUser(u);
      const seed = await mkPost("rep_high", "old", ["aa"]);
      await react("rater1", seed, "▲");
      await react("rater2", seed, "▲");
      const hi = await mkPost("rep_high", "new hi", ["bb"]);
      const lo = await mkPost("rep_low", "new lo", ["bb"]);
      assertEquals((await score(hi)) > (await score(lo)), true);
    });

    await t.step("downvotes on own post outweigh upvotes (3x)", async () => {
      for (const u of ["postA1", "postB1", "voter1", "voter2", "voter3"]) await mkUser(u);
      const up = await mkPost("postA1", "a", ["cc"]);
      const down = await mkPost("postB1", "b", ["dd"]);
      for (const v of ["voter1", "voter2", "voter3"]) await react(v, up, "▲");
      for (const v of ["voter1", "voter2"]) await react(v, down, "▼");
      assertEquals((await score(down)) < (await score(up)), true);
    });

    await t.step("mass-downvoted author drags their other posts down", async () => {
      for (const u of ["dragged", "cleanuser", "dvoter1", "dvoter2", "dvoter3"]) await mkUser(u);
      const other = await mkPost("cleanuser", "clean", ["ff"]);
      const first = await mkPost("dragged", "first", ["gg"]);
      for (const v of ["dvoter1", "dvoter2", "dvoter3"]) await react(v, first, "▼");
      const second = await mkPost("dragged", "second", ["hh"]);
      assertEquals((await score(second)) < (await score(other)), true);
    });

    await t.step("post on reputable domain beats post on unknown domain", async () => {
      for (const u of ["domA1", "domB1", "ranker1", "ranker2"]) await mkUser(u);
      const seed = await mkPost("domA1", "good", ["ii"], ["good.example"]);
      await react("ranker1", seed, "▲");
      await react("ranker2", seed, "▲");
      const reputable = await mkPost("domB1", "news", ["jj"], ["good.example"]);
      const fresh = await mkPost("domB1", "news2", ["jj"], ["unknown.example"]);
      assertEquals((await score(reputable)) > (await score(fresh)), true);
    });

    await t.step("heavy poster ranks below infrequent poster", async () => {
      for (const u of ["heavy", "light"]) await mkUser(u);
      for (let i = 0; i < 20; i++)
        await sql`insert into com (created_by, body, tags) values ('heavy', ${"filler " + i}, '{kk}')`;
      await sql`select refresh_score(array(select cid from com where created_by = 'heavy'))`;
      const h = await mkPost("heavy", "hot take", ["ll"]);
      const l = await mkPost("light", "hot take", ["ll"]);
      assertEquals((await score(h)) < (await score(l)), true);
    });

    await t.step("repost (linking to upvoted post) ranks below original content", async () => {
      for (const u of ["origauth", "repostr", "upvtr1", "upvtr2", "upvtr3"]) await mkUser(u);
      const original = await mkPost("origauth", "original content", ["nn"]);
      for (const v of ["upvtr1", "upvtr2", "upvtr3"]) await react(v, original, "▲");
      const [r] = await sql`insert into com (created_by, body, tags, links) values ('repostr', 'see this', '{oo}', ${[
        original,
      ]}::int[]) returning cid`;
      await sql`select refresh_score(array[${r.cid}]::int[])`;
      const fresh = await mkPost("repostr", "own thought", ["pp"]);
      assertEquals((await score(r.cid as number)) < (await score(fresh)), true);
    });

    await t.step("reaction remove restores score (idempotent)", async () => {
      for (const u of ["idemuser", "idemvote"]) await mkUser(u);
      const p = await mkPost("idemuser", "ping", ["mm"]);
      const before = await score(p);
      await react("idemvote", p, "▲");
      assertEquals((await score(p)) > before, true);
      await unreact("idemvote", p, "▲");
      assertEquals(await score(p), before);
    });
  }),
);

//// BOT INTERACTION TESTS //////////////////////////////////////////////////////

Deno.test(
  "bot interactions",
  pglite((sql) => async (t) => {
    // Create a bot user
    await sql`insert into usr (name, email, password, bio, invited_by, email_verified_at)
      values ('bot_test', 'bot-test@ding.bar', 'hashed:botpass!', 'I am a test bot', 'john_doe', now())`;
    const botAuth = { Authorization: "Basic " + btoa("bot-test@ding.bar:botpass!") };
    const jAuth = { Authorization: "Basic " + btoa("john@example.com:password1!") };
    const janeAuth = { Authorization: "Basic " + btoa("jane@example.com:password1!") };
    const fd = (o: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(o)) f.append(k, v);
      return f;
    };
    const cidFromLocation = (loc: string) => {
      const m = loc.match(/^\/c\/(\d+)/);
      if (!m) throw new Error(`bad location: ${loc}`);
      return +m[1];
    };

    await t.step("bot can post via Basic Auth", async () => {
      const res = await app.request("/c", {
        method: "POST",
        body: fd({ body: "bot post 1\n\nhttps://example.com/1", tags: "#test #bot" }),
        headers: botAuth,
      });
      assertEquals(res.status, 302);
      const cid = cidFromLocation(res.headers.get("location")!);
      const [row] = await sql`select body, created_by, tags from com where cid = ${cid}`;
      assertEquals(row.created_by, "bot_test");
      assertEquals(row.tags, ["test", "bot"]);
    });

    await t.step("bot can read own posts as JSON", async () => {
      // Post a second item
      await app.request("/c", {
        method: "POST",
        body: fd({ body: "bot post 2\n\nhttps://example.com/2", tags: "#test #bot" }),
        headers: botAuth,
      });

      const res = await app.request("/c?usr=bot_test&limit=10", {
        headers: { Accept: "application/json", ...botAuth },
      });
      assertEquals(res.status, 200);
      const posts = await res.json();
      assertEquals(posts.length >= 2, true);
      assertEquals(posts[0].created_by, "bot_test");
      assertEquals(typeof posts[0].body, "string");
      assertEquals(Array.isArray(posts[0].tags), true);
    });

    await t.step("bot can read child_comments as JSON", async () => {
      // Create root post, add replies from different users
      const r1 = await app.request("/c", {
        method: "POST",
        body: fd({ body: "game post", tags: "#game #bot" }),
        headers: botAuth,
      });
      const rootCid = cidFromLocation(r1.headers.get("location")!);

      await app.request(`/c/${rootCid}`, {
        method: "POST",
        body: fd({ body: "player guess 1" }),
        headers: jAuth,
      });
      await app.request(`/c/${rootCid}`, {
        method: "POST",
        body: fd({ body: "player guess 2" }),
        headers: janeAuth,
      });

      const res = await app.request(`/c/${rootCid}`, {
        headers: { Accept: "application/json", ...botAuth },
      });
      assertEquals(res.status, 200);
      const items = await res.json();
      const post = items[0];
      assertEquals(post.cid, rootCid);
      assertEquals(post.child_comments.length, 2);
      assertEquals(
        post.child_comments[0].created_by === "john_doe" || post.child_comments[0].created_by === "jane_doe",
        true,
      );
      assertEquals(typeof post.child_comments[0].cid, "number");
      assertEquals(typeof post.child_comments[0].created_at, "string");
    });

    await t.step("bot can reply to a comment", async () => {
      // Get a post with child_comments
      const listRes = await app.request("/c?usr=bot_test&tag=game&limit=1", {
        headers: { Accept: "application/json", ...botAuth },
      });
      const posts = await listRes.json();
      const playerComment = posts[0].child_comments[0];

      // Bot replies to the player's comment
      const res = await app.request(`/c/${playerComment.cid}`, {
        method: "POST",
        body: fd({ body: `@${playerComment.created_by} Correct!` }),
        headers: botAuth,
      });
      assertEquals(res.status, 302);

      // Verify reply exists
      const [reply] =
        await sql`select body, created_by, parent_cid from com where created_by = 'bot_test' and parent_cid = ${playerComment.cid}`;
      assertEquals(reply.created_by, "bot_test");
      assertEquals(reply.body.includes("Correct!"), true);
    });

    await t.step("bot can discover posts by tag", async () => {
      // Users invoke utility bots via tags like #8ball or #dice
      const res = await app.request("/c", {
        method: "POST",
        body: fd({ body: "Will it ship on time?", tags: "#8ball #fun" }),
        headers: jAuth,
      });
      assertEquals(res.status, 302);

      // Bot searches by tag to find posts needing a response
      const tagRes = await app.request("/c?tag=8ball&limit=10", {
        headers: { Accept: "application/json" },
      });
      assertEquals(tagRes.status, 200);
      const posts = await tagRes.json();
      assertEquals(posts.length >= 1, true);
      assertEquals(posts.some((p: { body: string }) => p.body === "Will it ship on time?"), true);
    });

    await t.step("bot dedup: can detect own prior reply in child_comments", async () => {
      // Create a post the bot already replied to
      const r1 = await app.request("/c", {
        method: "POST",
        body: fd({ body: "question post", tags: "#trivia #bot" }),
        headers: botAuth,
      });
      const rootCid = cidFromLocation(r1.headers.get("location")!);

      // User replies
      await app.request(`/c/${rootCid}`, {
        method: "POST",
        body: fd({ body: "my answer" }),
        headers: jAuth,
      });

      // Bot grades
      await app.request(`/c/${rootCid}`, {
        method: "POST",
        body: fd({ body: "@john_doe Correct!" }),
        headers: botAuth,
      });

      // Now fetch and check: bot can see its own reply in child_comments
      const res = await app.request(`/c/${rootCid}`, {
        headers: { Accept: "application/json", ...botAuth },
      });
      const items = await res.json();
      const children = items[0].child_comments;
      const botReplies = children.filter((c: { created_by: string }) => c.created_by === "bot_test");
      assertEquals(botReplies.length, 1);
      assertEquals(botReplies[0].body, "@john_doe Correct!");
    });

    await t.step("bot reply inherits parent tags/orgs", async () => {
      // Use DB directly to avoid rate limiter (which is in-memory and shared across test suites)
      const [root] =
        await sql`insert into com (created_by, body, tags) values ('bot_test', 'tagged post', '{alpha,beta}') returning cid`;
      await sql`insert into com (parent_cid, created_by, body, tags, orgs, usrs) values (${root.cid}, 'john_doe', 'reply inherits tags', '{alpha,beta}', '{}', '{}')`;
      const [reply] = await sql`select tags from com where parent_cid = ${root.cid} and created_by = 'john_doe'`;
      assertEquals(reply.tags, ["alpha", "beta"]);
    });

    await t.step("reactions don't appear in child_comments", async () => {
      // Seed directly to avoid rate limiter
      const [root] =
        await sql`insert into com (created_by, body, tags) values ('bot_test', 'react to me', '{test}') returning cid`;
      // Add reaction via DB
      await sql`insert into com (parent_cid, created_by, body, tags, orgs, usrs) values (${root.cid}, 'john_doe', '▲', '{test}', '{}', '{}')`;
      await sql`update com set c_reactions = c_reactions || hstore('▲', '1') where cid = ${root.cid}`;
      // Add regular comment via DB
      await sql`insert into com (parent_cid, created_by, body, tags, orgs, usrs) values (${root.cid}, 'jane_doe', 'real comment', '{test}', '{}', '{}')`;
      await sql`update com set c_comments = c_comments + 1 where cid = ${root.cid}`;

      const res = await app.request(`/c/${root.cid}`, {
        headers: { Accept: "application/json" },
      });
      const items = await res.json();
      const post = items[0];
      assertEquals(post.child_comments.length, 1);
      assertEquals(post.child_comments[0].body, "real comment");
      assertEquals(+post.reaction_counts["▲"], 1);
    });

    await t.step("post view returns grandchildren two levels deep", async () => {
      const [root] =
        await sql`insert into com (created_by, body, tags) values ('bot_test', 'root for depth', '{depth}') returning cid`;
      const [child] =
        await sql`insert into com (parent_cid, created_by, body, tags) values (${root.cid}, 'john_doe', 'child reply', '{depth}') returning cid`;
      await sql`insert into com (parent_cid, created_by, body, tags) values (${child.cid}, 'jane_doe', 'grandchild reply', '{depth}')`;

      const res = await app.request(`/c/${root.cid}`, {
        headers: { Accept: "application/json", ...botAuth },
      });
      const [post] = await res.json();
      assertEquals(post.child_comments.length, 1);
      assertEquals(post.child_comments[0].body, "child reply");
      assertEquals(post.child_comments[0].child_comments.length, 1);
      assertEquals(post.child_comments[0].child_comments[0].body, "grandchild reply");
    });

    await t.step("post view HTML renders grandchild without click-through", async () => {
      const [root] =
        await sql`insert into com (created_by, body, tags) values ('bot_test', 'html depth root', '{depth2}') returning cid`;
      const [child] =
        await sql`insert into com (parent_cid, created_by, body, tags) values (${root.cid}, 'john_doe', 'html child reply', '{depth2}') returning cid`;
      await sql`insert into com (parent_cid, created_by, body, tags) values (${child.cid}, 'jane_doe', 'html grandchild reply', '{depth2}')`;

      const res = await app.request(`/c/${root.cid}`, { headers: botAuth });
      const html = await res.text();
      assertEquals(html.includes("html child reply"), true);
      assertEquals(html.includes("html grandchild reply"), true);
    });

    await t.step("bot can't post to private org without membership", async () => {
      const res = await app.request("/c", {
        method: "POST",
        body: fd({ body: "sneaky bot", tags: "#test *secret" }),
        headers: botAuth,
      });
      assertEquals(res.status, 403);
    });

    await t.step("bot can't reply to inaccessible private post", async () => {
      // Post 355 is in *secret org (only john has access)
      const res = await app.request("/c/355", {
        method: "POST",
        body: fd({ body: "sneaky reply" }),
        headers: botAuth,
      });
      assertEquals(res.status, 403);
    });

    await t.step("malformed Basic Auth doesn't crash", async () => {
      const res = await app.request("/c", {
        method: "POST",
        body: fd({ body: "test", tags: "#pub" }),
        headers: { Authorization: "Basic !!!invalid-base64!!!" },
      });
      // Should redirect to login, not 500
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location")?.startsWith("/u?next="), true);
    });

    await t.step("empty Basic Auth doesn't crash", async () => {
      const res = await app.request("/c", {
        method: "POST",
        body: fd({ body: "test", tags: "#pub" }),
        headers: { Authorization: "Basic " },
      });
      assertEquals(res.status, 302);
    });
  }),
);

Deno.test(
  "synthetic domain tags",
  pglite((sql) => async (t) => {
    const jAuth = { Authorization: "Basic " + btoa("john@example.com:password1!") };
    const fd = (o: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(o)) f.append(k, v);
      return f;
    };
    const cidFromLocation = (loc: string) => +loc.match(/^\/c\/(\d+)/)![1];

    await t.step("POST /c root stores a distinct ~host tag per URL", async () => {
      const res = await app.request("/c", {
        method: "POST",
        body: fd({
          body: "links https://example.com/a and https://taylor.town/foo.png plus https://example.com/b",
          tags: "#pub",
        }),
        headers: jAuth,
      });
      assertEquals(res.status, 302);
      const cid = cidFromLocation(res.headers.get("location")!);
      const [row] = await sql`select domains from com where cid = ${cid}`;
      assertEquals((row.domains as string[]).sort(), ["example.com", "taylor.town"]);
    });

    await t.step("POST /c reply also stores domains (not just root posts)", async () => {
      const res = await app.request("/c/301", {
        method: "POST",
        body: fd({ body: "see https://taylor.town/thing" }),
        headers: jAuth,
      });
      assertEquals(res.status, 302);
      const newCid = +res.headers.get("location")!.match(/#(\d+)$/)![1];
      const [row] = await sql`select domains from com where cid = ${newCid}`;
      assertEquals(row.domains, ["taylor.town"]);
    });

    await t.step("GET /c?www=host returns posts whose domains contain host", async () => {
      const res = await app.request("/c?www=taylor.town", { headers: { Accept: "application/json", ...jAuth } });
      assertEquals(res.status, 200);
      const items = await res.json();
      assertEquals(items.length >= 1, true);
      for (const i of items) assertEquals((i.domains as string[]).includes("taylor.town"), true);
    });

    await t.step("GET /c?www=host returns empty for unused host", async () => {
      const res = await app.request("/c?www=nonexistent.invalid", {
        headers: { Accept: "application/json", ...jAuth },
      });
      assertEquals(res.status, 200);
      assertEquals((await res.json()).length, 0);
    });

    await t.step("GET /c?www=host1&www=host2 returns posts on either host (array overlap)", async () => {
      await app.request("/c", {
        method: "POST",
        body: fd({ body: "one https://alpha.example/x", tags: "#pub" }),
        headers: jAuth,
      });
      await app.request("/c", {
        method: "POST",
        body: fd({ body: "two https://beta.example/y", tags: "#pub" }),
        headers: jAuth,
      });
      const res = await app.request("/c?www=alpha.example&www=beta.example", {
        headers: { Accept: "application/json", ...jAuth },
      });
      const items = await res.json();
      const bodies = items.map((i: { body: string }) => i.body);
      assertEquals(bodies.some((b: string) => b.includes("alpha.example")), true);
      assertEquals(bodies.some((b: string) => b.includes("beta.example")), true);
    });
  }),
);

Deno.test(
  "notifications inbox",
  pglite((_sql) => async (t) => {
    const jAuth = { Authorization: "Basic " + btoa("john@example.com:password1!") };
    const janeAuth = { Authorization: "Basic " + btoa("jane@example.com:password1!") };
    const fd = (o: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(o)) f.append(k, v);
      return f;
    };

    await t.step("mention shows up as unread in /n", async () => {
      // jane posts mentioning john
      const r = await app.request("/c", {
        method: "POST",
        body: fd({ body: "hey @john_doe check this out", tags: "#hi @john_doe" }),
        headers: janeAuth,
      });
      assertEquals(r.status, 302);

      const res = await app.request("/n", { headers: { Accept: "application/json", ...jAuth } });
      assertEquals(res.status, 200);
      const items = await res.json();
      assertEquals(items.length >= 1, true);
      const mention = items.find((i: { body: string }) => i.body.includes("@john_doe check"));
      assertEquals(mention?.unread, true);
      assertEquals(mention?.kind, "mention");
      assertEquals(mention?.created_by, "jane_doe");
    });

    await t.step("second GET /n shows prior mention as read", async () => {
      // Previous call updated last_seen_at; a fresh call with no new posts should show unread=false
      const res = await app.request("/n", { headers: { Accept: "application/json", ...jAuth } });
      const items = await res.json();
      const mention = items.find((i: { body: string }) => i.body.includes("@john_doe check"));
      assertEquals(mention?.unread, false);
    });

    await t.step("reply to john's post shows up in /n", async () => {
      // john posts
      const r1 = await app.request("/c", {
        method: "POST",
        body: fd({ body: "john post body", tags: "#johntag" }),
        headers: jAuth,
      });
      const cid = +r1.headers.get("location")!.match(/\/c\/(\d+)/)![1];

      // jane replies
      await app.request(`/c/${cid}`, {
        method: "POST",
        body: fd({ body: "reply from jane" }),
        headers: janeAuth,
      });

      const res = await app.request("/n", { headers: { Accept: "application/json", ...jAuth } });
      const items = await res.json();
      const reply = items.find((i: { body: string }) => i.body === "reply from jane");
      assertEquals(reply?.kind, "reply");
      assertEquals(reply?.unread, true);
    });

    await t.step("own replies are excluded from /n", async () => {
      const r1 = await app.request("/c", {
        method: "POST",
        body: fd({ body: "jane root post", tags: "#solo" }),
        headers: janeAuth,
      });
      const cid = +r1.headers.get("location")!.match(/\/c\/(\d+)/)![1];
      await app.request(`/c/${cid}`, { method: "POST", body: fd({ body: "jane replies to self" }), headers: janeAuth });

      const res = await app.request("/n", { headers: { Accept: "application/json", ...janeAuth } });
      const items = await res.json();
      assertEquals(items.some((i: { body: string }) => i.body === "jane replies to self"), false);
    });

    await t.step("/n/unread returns count and latest", async () => {
      // fresh post mentioning john
      await app.request("/c", {
        method: "POST",
        body: fd({ body: "hi @john_doe again", tags: "#hi @john_doe" }),
        headers: janeAuth,
      });
      const res = await app.request("/n/unread", { headers: jAuth });
      assertEquals(res.status, 200);
      const d = await res.json();
      assertEquals(d.count >= 1, true);
      assertEquals(d.latest[0].url.startsWith("/c/"), true);
      assertEquals(d.latest[0].title.includes("@jane_doe"), true);
    });

    await t.step("/n requires auth", async () => {
      const res = await app.request("/n");
      assertEquals(res.status, 401);
    });

    await t.step("/c?mention= matches body @refs (top-level, no usrs)", async () => {
      // jane posts a top-level with @john_doe only in body; tags field has no @
      await app.request("/c", {
        method: "POST",
        body: fd({ body: "shout out to @john_doe here", tags: "#shout" }),
        headers: janeAuth,
      });

      const res = await app.request("/c?mention=john_doe", {
        headers: { Accept: "application/json", ...jAuth },
      });
      assertEquals(res.status, 200);
      const items = await res.json();
      assertEquals(items.some((i: { body: string }) => i.body === "shout out to @john_doe here"), true);
    });

    await t.step("/c?mention=&comments=1 matches body @refs in replies", async () => {
      // john posts a tagged root
      const r1 = await app.request("/c", {
        method: "POST",
        body: fd({ body: "john root", tags: "#rootx" }),
        headers: jAuth,
      });
      const parent = +r1.headers.get("location")!.match(/\/c\/(\d+)/)![1];
      // jane replies summoning a bot-style handle
      await app.request(`/c/${parent}`, {
        method: "POST",
        body: fd({ body: "@bot_dither" }),
        headers: janeAuth,
      });

      const res = await app.request("/c?mention=bot_dither&comments=1", {
        headers: { Accept: "application/json", ...jAuth },
      });
      assertEquals(res.status, 200);
      const items = await res.json();
      assertEquals(items.some((i: { body: string }) => i.body === "@bot_dither"), true);
    });
  }),
);

//// LABEL PARSING TESTS ///////////////////////////////////////////////////////

Deno.test("parseLabels", async (t) => {
  await t.step("parses all label types", () => {
    const result = parseLabels("#pub *org @User ~example.com lorem ipsum");
    assertEquals(result.tag, ["pub"]);
    assertEquals(result.org, ["org"]);
    assertEquals(result.usr, ["User"]);
    assertEquals(result.www, ["example.com"]);
    assertEquals(result.text, "lorem ipsum");
  });

  await t.step("lowercases tags, orgs, and www but preserves usr case", () => {
    const result = parseLabels("#PUB *ORG @UserName ~EXAMPLE.COM");
    assertEquals(result.tag, ["pub"]);
    assertEquals(result.org, ["org"]);
    assertEquals(result.usr, ["UserName"]);
    assertEquals(result.www, ["example.com"]);
  });

  await t.step("handles empty input", () => {
    const result = parseLabels("");
    assertEquals(result.tag, []);
    assertEquals(result.org, []);
    assertEquals(result.usr, []);
    assertEquals(result.www, []);
    assertEquals(result.text, "");
  });

  await t.step("handles multiple of same type", () => {
    const result = parseLabels("#tag1 #tag2 *org1 *org2");
    assertEquals(result.tag, ["tag1", "tag2"]);
    assertEquals(result.org, ["org1", "org2"]);
  });
});

Deno.test("encodeLabels", async (t) => {
  await t.step("encodes labels to URLSearchParams", () => {
    const labels = { tag: ["pub"], org: ["org"], usr: ["user"], www: ["example.com"], text: "query" };
    const params = encodeLabels(labels);
    assertEquals(params.getAll("tag"), ["pub"]);
    assertEquals(params.getAll("org"), ["org"]);
    assertEquals(params.getAll("usr"), ["user"]);
    assertEquals(params.getAll("www"), ["example.com"]);
    assertEquals(params.get("q"), "query");
  });

  await t.step("handles empty text", () => {
    const labels = { tag: ["pub"], org: [], usr: [], www: [], text: "" };
    const params = encodeLabels(labels);
    assertEquals(params.get("q"), null);
  });
});

Deno.test("decodeLabels", async (t) => {
  await t.step("decodes URLSearchParams to search string", () => {
    const params = new URLSearchParams("tag=pub&org=org&usr=user&www=example.com&q=query");
    const result = decodeLabels(params);
    assertEquals(result, "#pub *org @user ~example.com query");
  });

  await t.step("handles empty params", () => {
    const params = new URLSearchParams();
    const result = decodeLabels(params);
    assertEquals(result, "");
  });
});

Deno.test("formatLabels", async (t) => {
  await t.step("formats database record to display strings", () => {
    const record = { tags: ["humor", "coding"], orgs: ["secret"], usrs: ["john"] };
    const result = formatLabels(record);
    assertEquals(result, ["#humor", "#coding", "*secret", "@john"]);
  });

  await t.step("handles missing fields", () => {
    const record = { tags: ["humor"] };
    const result = formatLabels(record);
    assertEquals(result, ["#humor"]);
  });

  await t.step("emits ~host chips for domains", () => {
    const record = { tags: ["news"], domains: ["example.com", "taylor.town"] };
    const result = formatLabels(record);
    assertEquals(result, ["#news", "~example.com", "~taylor.town"]);
  });
});

Deno.test("label encoding round-trip", () => {
  const input = "#pub *org @User ~example.com lorem ipsum";
  const labels = parseLabels(input);
  const params = encodeLabels(labels);
  const decoded = decodeLabels(params);
  // Note: order may differ and case is normalized
  assertEquals(decoded, "#pub *org @User ~example.com lorem ipsum");
});

//// EXTRACT DOMAINS TESTS ////////////////////////////////////////////////////

Deno.test("extractDomains", async (t) => {
  await t.step("returns empty array when no URLs", () => {
    assertEquals(extractDomains("just some text"), []);
    assertEquals(extractDomains(""), []);
  });

  await t.step("extracts single host", () => {
    assertEquals(extractDomains("see https://example.com/foo"), ["example.com"]);
  });

  await t.step("extracts all distinct hosts", () => {
    assertEquals(
      extractDomains("links https://example.com and https://taylor.town/foo.png").sort(),
      ["example.com", "taylor.town"],
    );
  });

  await t.step("dedupes repeated host", () => {
    assertEquals(
      extractDomains("https://example.com/a and https://example.com/b"),
      ["example.com"],
    );
  });

  await t.step("lowercases host", () => {
    assertEquals(extractDomains("visit https://EXAMPLE.com/x"), ["example.com"]);
  });

  await t.step("handles http and https", () => {
    assertEquals(
      extractDomains("http://a.example https://b.example").sort(),
      ["a.example", "b.example"],
    );
  });

  await t.step("skips malformed URLs", () => {
    assertEquals(extractDomains("https:// not-a-url"), []);
  });

  await t.step("strips trailing punctuation via URL parse", () => {
    assertEquals(extractDomains("See https://example.com/path. Done."), ["example.com"]);
  });

  await t.step("strips www. prefix", () => {
    assertEquals(extractDomains("https://www.example.com/x"), ["example.com"]);
    assertEquals(
      extractDomains("https://www.example.com/a https://example.com/b"),
      ["example.com"],
    );
  });
});

//// IMAGE URL EXTRACTION TESTS ////////////////////////////////////////////////

Deno.test("extractImageUrl", async (t) => {
  await t.step("extracts .jpg URLs", () => {
    assertEquals(extractImageUrl("Check this https://i.imgur.com/abc.jpg out"), "https://i.imgur.com/abc.jpg");
  });

  await t.step("extracts .jpeg URLs", () => {
    assertEquals(extractImageUrl("https://example.com/photo.jpeg"), "https://example.com/photo.jpeg");
  });

  await t.step("extracts .png URLs", () => {
    assertEquals(extractImageUrl("Image: https://cdn.site.com/img.png"), "https://cdn.site.com/img.png");
  });

  await t.step("extracts .gif URLs", () => {
    assertEquals(extractImageUrl("https://i.redd.it/animation.gif"), "https://i.redd.it/animation.gif");
  });

  await t.step("extracts .webp URLs", () => {
    assertEquals(extractImageUrl("https://images.site.com/photo.webp"), "https://images.site.com/photo.webp");
  });

  await t.step("extracts .svg URLs", () => {
    assertEquals(extractImageUrl("https://example.com/icon.svg"), "https://example.com/icon.svg");
  });

  await t.step("is case-insensitive", () => {
    assertEquals(extractImageUrl("https://example.com/photo.JPG"), "https://example.com/photo.JPG");
    assertEquals(extractImageUrl("https://example.com/photo.PNG"), "https://example.com/photo.PNG");
  });

  await t.step("handles query params", () => {
    assertEquals(
      extractImageUrl("https://cdn.site.com/img.jpg?w=800&h=600"),
      "https://cdn.site.com/img.jpg?w=800&h=600",
    );
  });

  await t.step("returns null when no image URL", () => {
    assertEquals(extractImageUrl("Just text with https://example.com link"), null);
    assertEquals(extractImageUrl("No URLs here"), null);
  });

  await t.step("returns first match when multiple exist", () => {
    const body = "First https://a.com/one.jpg then https://b.com/two.png";
    assertEquals(extractImageUrl(body), "https://a.com/one.jpg");
  });

  await t.step("prefers image URL over regular URL in body", () => {
    const body = `Test post

https://www.reddit.com/r/hmmm/comments/abc

https://i.redd.it/xyz123.jpg

via /u/someone`;
    assertEquals(extractImageUrl(body), "https://i.redd.it/xyz123.jpg");
  });
});

//// EXTRACT LINKS TESTS ///////////////////////////////////////////////////////

Deno.test("extractLinks", async (t) => {
  await t.step("extracts cid from ding.bar URL", () => {
    assertEquals(extractLinks("see https://ding.bar/c/42 cool"), [42]);
  });

  await t.step("extracts multiple links", () => {
    assertEquals(extractLinks("https://ding.bar/c/1 and https://ding.bar/c/2"), [1, 2]);
  });

  await t.step("returns empty for no links", () => {
    assertEquals(extractLinks("no links here"), []);
  });

  await t.step("ignores non-ding.bar URLs", () => {
    assertEquals(extractLinks("https://example.com/c/42"), []);
  });

  await t.step("ignores relative /c/ paths", () => {
    assertEquals(extractLinks("see /c/42"), []);
  });
});

//// FORMAT BODY TESTS ////////////////////////////////////////////////////////

// Render formatBody output inside a real JSX element so Hono's text-escaping
// applies, matching what users actually see.
// deno-lint-ignore no-explicit-any
const render = (body: string): string => String((jsx as any)("div", {}, formatBody(body)));

Deno.test("formatBody", async (t) => {
  await t.step("preserves symbols around italic, bold, code", () => {
    const out = render("_foo_ and **bar** and `baz`");
    assertEquals(out.includes("<em>_foo_</em>"), true);
    assertEquals(out.includes("<strong>**bar**</strong>"), true);
    assertEquals(out.includes("<code>`baz`</code>"), true);
  });

  await t.step("renders link with brackets and parens kept", () => {
    const out = render("see [site](https://example.com) now");
    assertEquals(out.includes(`href="https://example.com"`), true);
    assertEquals(out.includes("[site](https://example.com)"), true);
  });

  await t.step("fenced code becomes <pre> with fences kept", () => {
    const out = render("text\n```\ncode here\n```\nafter");
    assertEquals(out.includes("<pre>```\ncode here\n```</pre>"), true);
  });

  await t.step("indented code becomes <pre>", () => {
    const out = render("para\n\n    indent1\n    indent2\n\nafter");
    assertEquals(out.includes("<pre>    indent1\n    indent2</pre>"), true);
  });

  await t.step("heading preserves # symbols", () => {
    const out = render("# title");
    assertEquals(out.includes("<h3>"), true);
    assertEquals(out.includes("# title"), true);
  });

  await t.step("blockquote wraps content in <blockquote>", () => {
    const out = render("> quoted line");
    assertEquals(out.includes("<blockquote>"), true);
    assertEquals(out.includes("quoted line"), true);
  });

  await t.step("blockquote recurses: list inside quote", () => {
    const out = render("> - item");
    assertEquals(/<blockquote>\s*<ul class="body-list">/.test(out), true);
    assertEquals(out.includes("<li>- item</li>"), true);
  });

  await t.step("blockquote recurses: nested quote", () => {
    const out = render("> > nested");
    assertEquals(/<blockquote>\s*<blockquote>/.test(out), true);
    assertEquals(out.includes("nested"), true);
  });

  await t.step("nested inline emphasis keeps both sets of symbols", () => {
    const out = render("**_both_**");
    assertEquals(out.includes("<strong>**<em>_both_</em>**</strong>"), true);
  });

  await t.step("bare URL becomes clickable link", () => {
    const out = render("see https://example.com now");
    assertEquals(out.includes(`href="https://example.com"`), true);
    assertEquals(out.includes(">https://example.com</a>"), true);
  });

  await t.step("bare URL trailing punctuation trimmed", () => {
    const out = render("visit https://example.com.");
    assertEquals(out.includes(`href="https://example.com"`), true);
    assertEquals(out.includes("https://example.com.</a>"), false);
  });

  await t.step("bare URL with balanced parens keeps closing paren", () => {
    const out = render("see https://en.wikipedia.org/wiki/Foo_(bar) now");
    assertEquals(out.includes(`href="https://en.wikipedia.org/wiki/Foo_(bar)"`), true);
  });

  await t.step("bare URL wrapped in parens keeps parens outside link", () => {
    const out = render("(see https://example.com)");
    assertEquals(out.includes(`href="https://example.com"`), true);
    assertEquals(out.includes("https://example.com)</a>"), false);
  });

  await t.step("list renders <ul class=body-list> with items", () => {
    const out = render("- one\n- two");
    assertEquals(out.includes(`class="body-list"`), true);
    assertEquals(out.includes("<li>- one</li>"), true);
    assertEquals(out.includes("<li>- two</li>"), true);
  });

  await t.step("escapes HTML injection in body", () => {
    const out = render("<script>alert(1)</script>");
    assertEquals(out.includes("<script>"), false);
    assertEquals(out.includes("&lt;script&gt;"), true);
  });

  await t.step("unmatched markers render literally", () => {
    const out = render("**bold without close and _italic without close");
    assertEquals(out.includes("<strong>"), false);
    assertEquals(out.includes("<em>"), false);
  });

  await t.step("non-http link schemes not linkified", () => {
    const out = render("[x](javascript:alert(1))");
    assertEquals(out.includes(`href="javascript:`), false);
  });
});
