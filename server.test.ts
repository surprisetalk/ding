//// IMPORTS ///////////////////////////////////////////////////////////////////

import { assertEquals } from "jsr:@std/assert@1";
import pg from "https://deno.land/x/postgresjs@v3.4.8/mod.js";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { hstore } from "@electric-sql/pglite/contrib/hstore";
import { PostgresConnection } from "pg-gateway";
import dbSql from "./db.sql" with { type: "text" };
import app, {
  decodeLabels,
  emailToken,
  encodeLabels,
  extractImageUrl,
  formatLabels,
  parseLabels,
  setSql,
  stripe,
} from "./server.tsx";

// Ensure STRIPE_SECRET_KEY is set for tests to prevent import-time crashes in server.tsx
if (!Deno.env.get("STRIPE_SECRET_KEY"))
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");

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
  (stripe as any).checkout = {
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
  (stripe as any).__updateCalls = [];
  (stripe as any).subscriptions = {
    retrieve: () => Promise.resolve({ items: { data: [{ id: "si_123", quantity: 1 }] } }),
    update: (subId: string, args: any) => {
      (stripe as any).__updateCalls.push({ subId, args });
      return Promise.resolve({});
    },
  };
  (stripe as any).webhooks = {
    constructEventAsync: (body: string, sig: string) =>
      sig === "valid" ? Promise.resolve(JSON.parse(body)) : Promise.reject(new Error("bad sig")),
  };

  setSql(testSql);
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

    await t.step("POST /signup duplicate name redirects to ?error=conflict", async () => {
      const body = new FormData();
      body.append("name", "john_doe");
      body.append("email", "different@example.com");
      const res = await app.request("/signup", { method: "POST", body });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/signup?error=conflict");
      const [{ count }] = await sql`select count(*)::int as count from usr where name = 'john_doe'`;
      assertEquals(count, 1);
    });

    await t.step("POST /signup duplicate email redirects to ?error=conflict", async () => {
      const body = new FormData();
      body.append("name", "different_name");
      body.append("email", "john@example.com");
      const res = await app.request("/signup", { method: "POST", body });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/signup?error=conflict");
      const [{ count }] = await sql`select count(*)::int as count from usr where name = 'different_name'`;
      assertEquals(count, 0);
    });

    await t.step("GET /verify with valid token sets email_verified_at for signup user", async () => {
      const tok = await emailToken(new Date(), "fresh@example.com");
      const res = await app.request(`/verify?email=${encodeURIComponent("fresh@example.com")}&token=${encodeURIComponent(tok)}`);
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

    await t.step("GET /u (api) with valid credentials", async () => {
      const res = await app.request("/u/john_doe", {
        headers: {
          Accept: "application/json",
          Authorization: "Basic " + btoa("john@example.com:password1!"),
        },
      });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), {
        invited_by: "john_doe",
        name: "john_doe",
        bio: "sample bio",
      });
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
  }),
);

//// ORG TESTS /////////////////////////////////////////////////////////////////

Deno.test(
  "Org Management",
  pglite((sql) => async (t) => {
    const authHeaders = {
      Authorization: "Basic " + btoa("john@example.com:password1!"),
    };

    await t.step("POST /org/new creates Checkout Session", async () => {
      const body = new FormData();
      body.append("name", "TestOrg");
      const res = await app.request("/org/new", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "https://stripe.com/checkout");
    });

    await t.step("POST /api/stripe-webhook checkout.session.completed creates org", async () => {
      const body = JSON.stringify({
        type: "checkout.session.completed",
        data: { object: { subscription: "sub_webhook", metadata: { orgName: "WebhookOrg", creatorName: "john_doe" } } },
      });
      const res = await app.request("/api/stripe-webhook", { method: "POST", body, headers: { "stripe-signature": "valid" } });
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

    await t.step("GET /org/success creates org and updates user", async () => {
      const res = await app.request("/org/success?session_id=cs_test_123", { headers: authHeaders });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/org/TestOrg");

      // Verify DB
      const [org] = await sql`select * from org where name = 'TestOrg'`;
      assertEquals(org.name, "TestOrg");
      assertEquals(org.created_by, "john_doe");
      assertEquals(org.stripe_sub_id, "sub_123");

      const [usr] = await sql`select orgs_r, orgs_w from usr where name = 'john_doe'`;
      assertEquals(usr.orgs_r.includes("TestOrg"), true);
      assertEquals(usr.orgs_w.includes("TestOrg"), true);
    });

    await t.step("POST /org/:name/invite adds member and bumps Stripe quantity", async () => {
      (stripe as any).__updateCalls.length = 0;
      const body = new FormData();
      body.append("name", "jane_doe");
      const res = await app.request("/org/TestOrg/invite", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 302);

      const [usr] = await sql`select orgs_r, orgs_w from usr where name = 'jane_doe'`;
      assertEquals(usr.orgs_r.includes("TestOrg"), true);
      assertEquals(usr.orgs_w.includes("TestOrg"), true);

      const calls = (stripe as any).__updateCalls;
      assertEquals(calls.length, 1);
      assertEquals(calls[0].args.items[0].quantity, 2);
    });

    await t.step("POST /org/:name/invite 404 for missing user, no Stripe call", async () => {
      (stripe as any).__updateCalls.length = 0;
      const body = new FormData();
      body.append("name", "ghost_user");
      const res = await app.request("/org/TestOrg/invite", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 404);
      assertEquals((stripe as any).__updateCalls.length, 0);
    });

    await t.step("POST /org/:name/invite duplicate is no-op, no Stripe call, no duped array entry", async () => {
      (stripe as any).__updateCalls.length = 0;
      const body = new FormData();
      body.append("name", "jane_doe");
      const res = await app.request("/org/TestOrg/invite", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 302);
      assertEquals((stripe as any).__updateCalls.length, 0);
      const [usr] = await sql`select orgs_r from usr where name = 'jane_doe'`;
      assertEquals(usr.orgs_r.filter((o: string) => o === "TestOrg").length, 1);
    });

    await t.step("POST /org/:name/invite 403 for non-owner", async () => {
      const janeAuth = { Authorization: "Basic " + btoa("jane@example.com:password1!") };
      (stripe as any).__updateCalls.length = 0;
      const body = new FormData();
      body.append("name", "john_doe");
      const res = await app.request("/org/TestOrg/invite", { method: "POST", body, headers: janeAuth });
      assertEquals(res.status, 403);
      assertEquals((stripe as any).__updateCalls.length, 0);
    });

    await t.step("POST /org/:name/remove removes member", async () => {
      const body = new FormData();
      body.append("name", "jane_doe");
      const res = await app.request("/org/TestOrg/remove", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 302);

      const [usr] = await sql`select orgs_r, orgs_w from usr where name = 'jane_doe'`;
      assertEquals(usr.orgs_r.includes("TestOrg"), false);
      assertEquals(usr.orgs_w.includes("TestOrg"), false);
    });

    await t.step("POST /org/:name/remove non-member returns 404, no Stripe call", async () => {
      (stripe as any).__updateCalls.length = 0;
      const body = new FormData();
      body.append("name", "jane_doe");
      const res = await app.request("/org/TestOrg/remove", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 404);
      assertEquals((stripe as any).__updateCalls.length, 0);
    });

    await t.step("POST /org/new with taken name returns 409, no Stripe Checkout", async () => {
      const stripeCreateCalls: any[] = [];
      const origCreate = (stripe as any).checkout.sessions.create;
      (stripe as any).checkout.sessions.create = (args: any) => {
        stripeCreateCalls.push(args);
        return origCreate(args);
      };
      const body = new FormData();
      body.append("name", "TestOrg");
      const res = await app.request("/org/new", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 409);
      assertEquals(stripeCreateCalls.length, 0);
      (stripe as any).checkout.sessions.create = origCreate;
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
      const res = await app.request("/c", { method: "POST", body: fd({ body: "hello world", tags: "#pub" }), headers: jAuth });
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
      const res = await app.request("/c", { method: "POST", body: fd({ body: "x", tags: "#pub *nonmember" }), headers: jAuth });
      assertEquals(res.status, 403);
    });

    await t.step("POST /c root 302 when *org IS in orgs_w", async () => {
      const res = await app.request("/c", { method: "POST", body: fd({ body: "y", tags: "#pub *secret" }), headers: jAuth });
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
      const res = await app.request("/c", { method: "POST", body: fd({ body: "look https://example.com/pic.jpg", tags: "#pub" }), headers: jAuth });
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

    await t.step("POST /c/:p flag updates c_flags not c_comments or c_reactions", async () => {
      const [before] = await sql`select c_flags, c_comments, c_reactions from com where cid = 301`;
      const res = await app.request("/c/301", { method: "POST", body: fd({ body: "flag" }), headers: jAuth });
      assertEquals(res.status, 302);
      const [after] = await sql`select c_flags, c_comments, c_reactions from com where cid = 301`;
      assertEquals(+after.c_flags, +before.c_flags + 1);
      assertEquals(+after.c_comments, +before.c_comments);
      assertEquals(after.c_reactions, before.c_reactions);
    });

    await t.step("POST /c/:p reply 403 on private parent from non-member", async () => {
      const res = await app.request("/c/355", { method: "POST", body: fd({ body: "sneaky" }), headers: janeAuth });
      assertEquals(res.status, 403);
    });

    await t.step("POST /c/:cid/delete owner soft-deletes", async () => {
      const [seed] = await sql`insert into com (created_by, body, tags) values ('john_doe', 'to delete', '{humor}') returning cid`;
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
      const boot = await app.request("/login", { method: "POST", body: fd({ email: "john@example.com", password: "password1!" }) });
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
      const res = await app.request("/api/stripe-webhook", { method: "POST", body, headers: { "stripe-signature": "valid" } });
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
      const res = await app.request("/api/stripe-webhook", { method: "POST", body, headers: { "stripe-signature": "bad" } });
      assertEquals(res.status, 400);
    });

    await t.step("GET /verify valid token sets email_verified_at only on matching email", async () => {
      await sql`insert into usr (name, email, bio, invited_by, email_verified_at) values ('verify_me', 'verify@example.com', 'bio', 'john_doe', null)`;
      await sql`insert into usr (name, email, bio, invited_by, email_verified_at) values ('canary_me', 'canary@example.com', 'bio', 'john_doe', null)`;
      const tok = await emailToken(new Date(), "verify@example.com");
      const res = await app.request(`/verify?email=${encodeURIComponent("verify@example.com")}&token=${encodeURIComponent(tok)}`);
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/u");
      const [row] = await sql`select email_verified_at from usr where name = 'verify_me'`;
      assertEquals(row.email_verified_at !== null, true);
      const [canary] = await sql`select email_verified_at from usr where name = 'canary_me'`;
      assertEquals(canary.email_verified_at, null);
    });

    await t.step("GET /verify rejects valid token with wrong email", async () => {
      const tok = await emailToken(new Date(), "verify@example.com");
      const res = await app.request(`/verify?email=${encodeURIComponent("canary@example.com")}&token=${encodeURIComponent(tok)}`);
      assertEquals(res.status, 400);
      const [canary] = await sql`select email_verified_at from usr where name = 'canary_me'`;
      assertEquals(canary.email_verified_at, null);
    });

    await t.step("POST /c rate-limits after 10 posts per 60s", async () => {
      await sql`insert into usr (name, email, password, bio, invited_by, email_verified_at) values ('rate_tester', 'rate@example.com', 'hashed:rate!', 'bio', 'john_doe', now())`;
      const auth = { Authorization: "Basic " + btoa("rate@example.com:rate!") };
      for (let i = 0; i < 10; i++) {
        const res = await app.request("/c", { method: "POST", body: fd({ body: `post ${i}`, tags: "#pub" }), headers: auth });
        assertEquals(res.status, 302);
      }
      const res = await app.request("/c", { method: "POST", body: fd({ body: "overflow", tags: "#pub" }), headers: auth });
      assertEquals(res.status, 429);
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
});

Deno.test("label encoding round-trip", () => {
  const input = "#pub *org @User ~example.com lorem ipsum";
  const labels = parseLabels(input);
  const params = encodeLabels(labels);
  const decoded = decodeLabels(params);
  // Note: order may differ and case is normalized
  assertEquals(decoded, "#pub *org @User ~example.com lorem ipsum");
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
