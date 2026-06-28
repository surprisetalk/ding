import { assertEquals } from "@std/assert";
import { dnsDingId, githubDingId, parseLink } from "./checkmark.ts";

Deno.test("parseLink", () => {
  assertEquals(parseLink("taylor.town"), { host: "taylor.town", handle: "" });
  assertEquals(parseLink("https://github.com/surprisetalk"), { host: "github.com", handle: "surprisetalk" });
  assertEquals(parseLink("www.NBA.com/teams/lakers"), { host: "nba.com", handle: "teams" });
  assertEquals(parseLink(""), null);
});

Deno.test("dnsDingId reads ding_id from a _ding TXT record", async () => {
  const id = "a".repeat(64);
  const orig = Deno.resolveDns;
  try {
    Deno.resolveDns = (() => Promise.resolve([[`ding_id=${id}`]])) as unknown as typeof Deno.resolveDns;
    assertEquals(await dnsDingId("taylor.town"), id);
    Deno.resolveDns = (() => Promise.resolve([["unrelated"]])) as unknown as typeof Deno.resolveDns;
    assertEquals(await dnsDingId("taylor.town"), null);
    Deno.resolveDns = (() => Promise.reject(new Error("NXDOMAIN"))) as unknown as typeof Deno.resolveDns;
    assertEquals(await dnsDingId("taylor.town"), null);
  } finally {
    Deno.resolveDns = orig;
  }
});

Deno.test("githubDingId matches bio and sanitizes the handle", async () => {
  const id = "b".repeat(64);
  const orig = globalThis.fetch;
  let fetched = "";
  try {
    globalThis.fetch = ((url: string) => {
      fetched = url;
      return Promise.resolve(new Response(JSON.stringify({ bio: `hi ding_id=${id} bye` }), { status: 200 }));
    }) as unknown as typeof fetch;
    assertEquals(await githubDingId("surprisetalk", id), true);
    assertEquals(await githubDingId("surprisetalk", "c".repeat(64)), false); // id not in bio
    fetched = "";
    assertEquals(await githubDingId("bad handle!", id), false); // rejected BEFORE any fetch
    assertEquals(fetched, ""); // sanitization short-circuits — no request made
  } finally {
    globalThis.fetch = orig;
  }
});
