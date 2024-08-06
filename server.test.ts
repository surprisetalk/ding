//// IMPORTS ///////////////////////////////////////////////////////////////////

// TODO: Switch to pg-mem when postgres.js package is available.

import app, { sql } from "./server.tsx";

import { assertEquals } from "jsr:@std/assert@1";

//// TESTS /////////////////////////////////////////////////////////////////////

Deno.test("TODO", async t => {
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

  await t.step("GET /u/:usr_id valid usr_id", async () => {
    const res = await app.request("/u/101");
    assertEquals(res.status, 200);
  });

  await t.step("GET /u/:usr_id invalid usr_id", async () => {
    const res = await app.request("/u/0");
    assertEquals(res.status, 404);
  });

  await t.step("GET /c/:comment_id valid comment_id", async () => {
    const res = await app.request("/c/201");
    assertEquals(res.status, 200);
  });

  await t.step("GET /c all comments", async () => {
    const res = await app.request("/c");
    assertEquals(res.status, 200);
  });

  await t.step("GET /verify invalid token", async () => {
    const res = await app.request("/verify?email=john@example.com&token=123:invalid_token");
    assertEquals(res.status, 302);
  });

  await t.step("GET /u with valid credentials", async () => {
    const res = await app.request("/u", { headers: { Authorization: "Basic " + btoa("john@example.com:password1!") } });
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

  await t.step("GET /u (api) with missing credentials", async () => {
    const res = await app.request("/u/101", { headers: { Host: "api", Authorization: "Basic " + btoa("john@example.com:password1!") } });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { bio: "sample bio", name: "john doe", usr_id: 101 });
  });

  await sql.end();
});
