//// IMPORTS ///////////////////////////////////////////////////////////////////

import app, { sql } from "./server.tsx";

import { assertEquals } from "jsr:@std/assert@1";

//// TESTS /////////////////////////////////////////////////////////////////////

Deno.test("GET /robots.txt should return 200 and the expected text", async () => {
  const res = await app.request("/robots.txt");
  assertEquals(res.status, 200);
});

Deno.test("POST /login with incorrect credentials should return 401 and the expected HTML", async () => {
  const body = new FormData();
  body.append("email", "john@example.com");
  body.append("password", "wrong!");
  const res = await app.request("/login", { method: "post", body });
  assertEquals(res.status, 401);
});

Deno.test("POST /login with correct credentials should redirect to /u", async () => {
  const body = new FormData();
  body.append("email", "john@example.com");
  body.append("password", "password1!");
  const res = await app.request("/login", { method: "post", body });
  assertEquals(res.status, 204);
});

/*
Deno.test("POST /logout should delete the cookie and return 204", async () => {
  await superdeno(app.fetch)
    .post("/logout")
    .set("Cookie", "usr_id=valid_cookie") // Replace with a valid cookie
    .expect(204);
});

Deno.test("GET /verify with valid token should redirect to /u", async () => {
  await superdeno(app.fetch)
    .get("/verify")
    .query({ email: "test@example.com", token: "valid_token" }) // Replace with a valid token
    .expect(302)
    .expect("Location", "/u");
});

Deno.test("GET /forgot should return 200 and the expected HTML form", async () => {
  await superdeno(app.fetch)
    .get("/forgot")
    .expect(200)
    .expect(/<form method="post" action="\/forgot">/);
});

Deno.test("POST /forgot with valid email should return 204", async () => {
  await superdeno(app.fetch)
    .post("/forgot")
    .send({ email: "test@example.com" }) // Update with valid email
    .expect(204);
});

Deno.test("POST /password with valid data should set the new password and redirect to /u", async () => {
  await superdeno(app.fetch)
    .post("/password")
    .send({
      email: "test@example.com",
      token: "valid_token",
      password: "newpassword1!",
    }) // Update with valid data
    .expect(302)
    .expect("Location", "/u");
});

Deno.test("POST /invite with valid data should send an invite and return 204", async () => {
  await superdeno(app.fetch)
    .post("/invite")
    .set("Cookie", "usr_id=valid_cookie") // Replace with a valid cookie
    .send({ email: "invite@example.com" }) // Update with valid email
    .expect(204);
});

Deno.test("GET /u with valid session should return 200 and the expected HTML", async () => {
  await superdeno(app.fetch)
    .get("/u")
    .set("Cookie", "usr_id=valid_cookie") // Replace with a valid cookie
    .expect(200)
    .expect(/TODO/);
});

Deno.test("GET /u with valid session should return 200 and the expected HTML", async () => {
  await superdeno(app.fetch)
    .get("/u")
    .set("Cookie", "usr_id=valid_cookie") // Replace with a valid cookie
    .expect(200)
    .expect(/TODO/);
});

Deno.test("GET /u with invalid session should return 401", async () => {
  await superdeno(app.fetch).get("/u").expect(401);
});

Deno.test("GET / should return 200 and the expected HTML", async () => {
  await superdeno(app.fetch)
    .get("/")
    .expect(200)
    .expect(/<title>future of coding<\/title>/);
});

Deno.test("POST /c without auth should return 401", async () => {
  await superdeno(app.fetch).post("/c").send({ body: "Test comment" }).expect(
    401,
  );
});

Deno.test("POST /c with auth should return 204", async () => {
  await superdeno(app.fetch)
    .post("/c")
    .set("Cookie", "usr_id=valid_cookie") // Replace with a valid cookie
    .send({ body: "Test comment" })
    .expect(204);
});

Deno.test("GET /u/:usr_id with valid usr_id should return 200 and the expected HTML", async () => {
  await superdeno(app.fetch)
    .get("/u/valid_usr_id") // Replace with a valid usr_id
    .expect(200)
    .expect(/TODO/);
});

Deno.test("GET /u/:usr_id with invalid usr_id should return 404", async () => {
  await superdeno(app.fetch).get("/u/invalid_usr_id").expect(404);
});

Deno.test("POST /password with expired token should return 400", async () => {
  await superdeno(app.fetch)
    .post("/password")
    .send({
      email: "test@example.com",
      token: "expired_token",
      password: "newpassword1!",
    }) // Replace with expired token
    .expect(400);
});

Deno.test("GET /c/:comment_id with valid comment_id should return 200 and the expected HTML", async () => {
  await superdeno(app.fetch)
    .get("/c/valid_comment_id") // Replace with a valid comment_id
    .expect(200)
    .expect(/TODO/);
});

Deno.test("GET /c/:comment_id with invalid comment_id should return 404", async () => {
  await superdeno(app.fetch).get("/c/invalid_comment_id").expect(404);
});

Deno.test("GET /verify with invalid token should return 400", async () => {
  await superdeno(app.fetch)
    .get("/verify")
    .query({ email: "test@example.com", token: "invalid_token" }) // Replace with invalid token
    .expect(400);
});

Deno.test("GET /sitemap.txt should return 501", async () => {
  await superdeno(app.fetch).get("/sitemap.txt").expect(501);
});
*/
