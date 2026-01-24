//// IMPORTS ///////////////////////////////////////////////////////////////////

import app, { setSql, parseLabels, encodeLabels, decodeLabels, formatLabels } from "./server.tsx";
import { assertEquals } from "jsr:@std/assert@1";
import pg from "https://deno.land/x/postgresjs@v3.4.8/mod.js";
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

  // Insert test user with default tag permissions
  await db.exec(`
    insert into usr (name, email, password, bio, email_verified_at, invited_by, orgs_r, orgs_w)
    values ('john_doe', 'john@example.com', 'hashed:password1!', 'sample bio', now(), 'john_doe', '{secret}', '{secret}')
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
      assertEquals(res.status, 400); // Invalid or expired token
    });

    await t.step("GET /u with invalid session", async () => {
      const res = await app.request("/u");
      assertEquals(res.status, 401);
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
      const res = await app.request(
        "/verify?email=john@example.com&token=123:invalid_token",
      );
      assertEquals(res.status, 400); // Invalid or expired token
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
