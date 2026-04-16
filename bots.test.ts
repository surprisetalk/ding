import { assertEquals } from "@std/assert";
import { isLinkPost } from "./bots.ts";

Deno.test("isLinkPost: bare url → true", () => {
  assertEquals(isLinkPost("https://example.com/foo"), true);
});

Deno.test("isLinkPost: url + short blurb → true", () => {
  assertEquals(isLinkPost("fascinating read: https://example.com/foo"), true);
});

Deno.test("isLinkPost: no url → false", () => {
  assertEquals(isLinkPost("just some prose with no links at all here"), false);
});

Deno.test("isLinkPost: url + long commentary → false", () => {
  const body = "Here is a deep analysis of the piece. The author argues " +
    "three distinct points, each worth examining. First, the epistemic frame. " +
    "Second, the causal claim. Third, the implications. See https://example.com/a";
  assertEquals(isLinkPost(body), false);
});

Deno.test("isLinkPost: empty body → false", () => {
  assertEquals(isLinkPost(""), false);
});

Deno.test("isLinkPost: multiple urls, minimal text → true", () => {
  assertEquals(isLinkPost("https://a.com https://b.com see"), true);
});
