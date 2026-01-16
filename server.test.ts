//// IMPORTS ///////////////////////////////////////////////////////////////////

import app, { setSql } from "./server.tsx";
import { assertEquals } from "jsr:@std/assert@1";
import pg from "https://deno.land/x/postgresjs@v3.4.3/mod.js";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { PostgresConnection } from "pg-gateway";
import dbSql from "./db.sql" with { type: "text" };

//// PGLITE WRAPPER ////////////////////////////////////////////////////////////

const pglite = (f: (sql: pg.Sql) => (t: Deno.TestContext) => Promise<void>) => async (t: Deno.TestContext) => {
  const port = 2000 + Math.floor(Math.random() * 8000);
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  const db = new PGlite({ extensions: { citext } });
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

  // Load schema (skip pgcrypto extension since we mocked it)
  const schema = dbSql.replace(/create extension if not exists pgcrypto;/i, "");
  await db.exec(schema);

  // Insert test user
  await db.exec(`
    insert into usr (uid, name, email, password, bio, email_verified_at, invited_by)
    values (101, 'john_doe', 'john@example.com', 'hashed:password1!', 'sample bio', now(), 101)
    on conflict do nothing;
  `);

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
      assertEquals(res.status, 302);
    });

    await t.step("GET /u with invalid session", async () => {
      const res = await app.request("/u");
      assertEquals(res.status, 401);
    });

    await t.step("GET /u/:uid valid uid", async () => {
      const res = await app.request("/u/101");
      assertEquals(res.status, 200);
    });

    await t.step("GET /u/:uid invalid uid", async () => {
      const res = await app.request("/u/0");
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
      const res = await app.request(
        "/verify?email=john@example.com&token=123:invalid_token",
      );
      assertEquals(res.status, 404); // Route is currently commented out
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

    await t.step("GET /u with missing credentials", async () => {
      const res = await app.request("/u");
      assertEquals(res.status, 401);
    });

    await t.step("GET /u (api) with valid credentials", async () => {
      const res = await app.request("/u/101", {
        headers: {
          Accept: "application/json",
          Authorization: "Basic " + btoa("john@example.com:password1!"),
        },
      });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), {
        uid: 101,
        invited_by: 101,
        name: "john_doe",
        bio: "sample bio",
      });
    });
  }),
);
