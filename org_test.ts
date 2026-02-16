import app, { setSql, stripe } from "./server.tsx";
import { assertEquals } from "jsr:@std/assert@1";
import pg from "https://deno.land/x/postgresjs@v3.4.8/mod.js";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { hstore } from "@electric-sql/pglite/contrib/hstore";
import { PostgresConnection } from "pg-gateway";
import dbSql from "./db.sql" with { type: "text" };

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

  await db.exec(`
    create or replace function gen_salt(text, int default 8) returns text language sql as $$ select 'salt' $$;
    create or replace function crypt(password text, salt text) returns text language sql as $$
      select case when salt like '$%' then password else 'hashed:' || password end
    $$;
  `);

  const schema = dbSql.replace(/create extension if not exists pgcrypto;/i, "");
  await db.exec(schema);

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

  setSql(testSql);

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
  (stripe as any).subscriptions = {
    retrieve: () => Promise.resolve({ items: { data: [{ id: "si_123", quantity: 1 }] } }),
    update: () => Promise.resolve({}),
  };

  await f(testSql)(t);

  await testSql.end();
  listener.close();
  await db.close();
};

Deno.test(
  "Org Management",
  pglite(sql => async t => {
    // Helper to login
    // Actually the server checks signed cookie using a secret.
    // In test environment, we can't easily generate valid signature without the secret.
    // server.tsx uses: const cookieSecret = Deno.env.get("COOKIE_SECRET") ?? Math.random().toString();
    // Tests unfortunately don't have access to the random secret generated inside server.tsx.
    // However, server.test.ts uses Basic Auth or just relies on loose checking?
    // server.test.ts uses: Authorization: "Basic " + btoa("john@example.com:password1!")

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

    await t.step("POST /org/:name/invite adds member", async () => {
      const body = new FormData();
      body.append("name", "jane_doe");
      const res = await app.request("/org/TestOrg/invite", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 302);

      const [usr] = await sql`select orgs_r from usr where name = 'jane_doe'`;
      assertEquals(usr.orgs_r.includes("TestOrg"), true);
    });

    await t.step("POST /org/:name/remove removes member", async () => {
      const body = new FormData();
      body.append("name", "jane_doe");
      const res = await app.request("/org/TestOrg/remove", { method: "POST", body, headers: authHeaders });
      assertEquals(res.status, 302);

      const [usr] = await sql`select orgs_r from usr where name = 'jane_doe'`;
      assertEquals(usr.orgs_r.includes("TestOrg"), false);
    });
  }),
);
