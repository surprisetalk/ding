//// IMPORTS ///////////////////////////////////////////////////////////////////

import { assertEquals, assertExists, assertStringIncludes, assertThrows } from "@std/assert";
import {
  buildMark,
  buildMsg,
  canon,
  genKey,
  hex,
  idOf,
  importPriv,
  nowSec,
  pubHexOf,
  type Row,
  signRow,
  verifyRow,
} from "./dht.ts";
import { backfill } from "./backfill.ts";
import { type Api, directImageUrl, getPostedUrls, imageMentionBot, post, reply, unansweredMentions } from "./bots.ts";
import cowsayBot from "./bots/cowsay.ts";
import { BOTS } from "./bots/mod.ts";
import { jsx } from "@hono/hono/jsx";
import { pgtemp } from "@surprisetalk/pgtemp";
import pg from "postgres";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { hstore } from "@electric-sql/pglite/contrib/hstore";
import "./test_env.ts"; // sets env BEFORE server.tsx module evaluation (ES import order)
import dbSql from "./db.sql" with { type: "text" };

import app, {
  AI_CRAWLERS,
  badSignupEmail,
  botFetch,
  dbIngestRate,
  decodeLabels,
  discoverPeers,
  emailToken,
  encodeLabels,
  extractDomains,
  extractImageUrl,
  extractLinks,
  formatBody,
  formatLabels,
  matchesQ,
  paging,
  parseLabels,
  postRate,
  prefRate,
  publishPeer,
  r2,
  refreshStats,
  replicate,
  resend,
  resolveName,
  setAssetV,
  setSql,
  signupRate,
  stripe,
  verified,
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

//// SEED FIXTURES ////////////////////////////////////////////////////////////
// Test fixtures live here (not db.sql) so prod schema applies stay data-free.
// Hardcoded cids (301-357) — many tests reference them by number.

const seedSql = `
insert into usr (name, email, password, bio, email_verified_at, invited_by, orgs_r, orgs_w) values
('BugHunter42', 'bughunter42@example.com', crypt('bugzapper123!', gen_salt('bf', 8)), 'I squash bugs for fun and profit.', null, 'BugHunter42', '{secret,internal}', '{secret}'),
('NullPointerQueen', 'nullpointerqueen@example.com', crypt('segfaults4ever!', gen_salt('bf', 8)), 'Segfaults are my specialty.', null, 'NullPointerQueen', '{secret}', '{secret}'),
('CodeWarrior007', 'codewarrior007@example.com', crypt('goldeneye$', gen_salt('bf', 8)), 'Writing code faster than a speeding bullet.', null, 'CodeWarrior007', '{internal}', '{internal}'),
('StackOverflowLord', 'solord@example.com', crypt('downvote_this!', gen_salt('bf', 8)), 'Living on the edge of recursion.', null, 'StackOverflowLord', '{}', '{}'),
('DebuggerDiva', 'debuggerdiva@example.com', crypt('breakpoint@!', gen_salt('bf', 8)), 'I can debug anything, even your life choices.', null, 'DebuggerDiva', '{secret,internal}', '{secret,internal}'),
('SyntaxSamurai', 'syntaxsamurai@example.com', crypt('semicolon&samurai', gen_salt('bf', 8)), 'Syntax errors fear me.', null, 'SyntaxSamurai', '{}', '{}');

insert into com (cid, parent_cid, created_by, body, tags, orgs, usrs) values
(301, null, 'BugHunter42', 'Why do bugs always show up on Fridays?', '{humor,bugs}', '{}', '{}'),
(302, null, 'NullPointerQueen', 'Just had a null pointer exception. Classic!', '{humor,exceptions}', '{}', '{}'),
(303, 0301, 'NullPointerQueen', 'Bugs love weekends too!', '{humor,bugs}', '{}', '{}'),
(304, null, 'CodeWarrior007', 'Anyone else feel like a coding ninja today?', '{motivation,coding}', '{}', '{}'),
(305, null, 'StackOverflowLord', 'Just downvoted my own answer for fun.', '{humor,meta}', '{}', '{}'),
(306, 0304, 'DebuggerDiva', 'Only when I finally solve that pesky bug.', '{motivation,coding}', '{}', '{}'),
(307, null, 'SyntaxSamurai', 'Semicolon misplaced. It''s a tragedy.', '{humor,syntax}', '{}', '{}'),
(308, 0307, 'CodeWarrior007', 'I feel your pain, syntax samurai.', '{humor,syntax}', '{}', '{}'),
(309, null, 'DebuggerDiva', 'Breakpoints are like checkpoints in life.', '{motivation,debugging}', '{}', '{}'),
(310, 0309, 'BugHunter42', 'And stepping through code is like meditation.', '{motivation,debugging}', '{}', '{}'),
(311, null, 'BugHunter42', 'Just found a bug that only occurs on leap years. FML.', '{humor,bugs}', '{}', '{}'),
(312, 0311, 'NullPointerQueen', 'Those are the best kind. Totally worth the wait.', '{humor,bugs}', '{}', '{}'),
(313, null, 'NullPointerQueen', 'Segfaults are like surprise parties, but with more panic.', '{humor,exceptions}', '{}', '{}'),
(314, null, 'CodeWarrior007', 'Just optimized a function from O(n^2) to O(n log n). I feel like a superhero.', '{motivation,coding}', '{}', '{}'),
(315, 0314, 'SyntaxSamurai', 'Teach me your ways, CodeWarrior007!', '{motivation,coding}', '{}', '{}'),
(316, null, 'StackOverflowLord', 'Just saw someone use a global variable... in 2024. Cringe.', '{humor,coding}', '{}', '{}'),
(317, 0316, 'DebuggerDiva', 'Yikes. That''s a crime against programming.', '{humor,coding}', '{}', '{}'),
(318, null, 'DebuggerDiva', 'Spent 3 hours debugging only to find out I misspelled a variable. Classic.', '{humor,debugging}', '{}', '{}'),
(319, 0318, 'CodeWarrior007', 'Been there, done that. Welcome to the club.', '{humor,debugging}', '{}', '{}'),
(320, null, 'SyntaxSamurai', 'Autocomplete is both a blessing and a curse.', '{humor,coding}', '{}', '{}'),
(321, 0320, 'BugHunter42', 'True, but more blessing when it actually works.', '{humor,coding}', '{}', '{}'),
(322, null, 'BugHunter42', 'Why does every tutorial say "it''s simple" and then proceed to confuse you for hours?', '{humor,learning}', '{}', '{}'),
(323, 0322, 'StackOverflowLord', 'Because they are written by people who forgot how hard it is to learn from scratch.', '{humor,learning}', '{}', '{}'),
(324, null, 'NullPointerQueen', 'My code works. I have no idea why. But it works.', '{humor,coding}', '{}', '{}'),
(325, 0324, 'CodeWarrior007', 'If it ain''t broke, don''t fix it.', '{humor,coding}', '{}', '{}'),
(326, null, 'StackOverflowLord', 'Just spent 2 hours fixing a bug that turned out to be a typo.', '{humor,debugging}', '{}', '{}'),
(327, 0326, 'NullPointerQueen', 'Typos: the silent killers.', '{humor,debugging}', '{}', '{}'),
(328, null, 'DebuggerDiva', 'Breakpoints are my best friends.', '{humor,debugging}', '{}', '{}'),
(329, 0328, 'BugHunter42', 'Especially when you''re deep into spaghetti code.', '{humor,debugging}', '{}', '{}'),
(330, null, 'SyntaxSamurai', 'Why do code reviews feel like therapy sessions?', '{humor,coding}', '{}', '{}'),
(331, 0330, 'DebuggerDiva', 'Because they are! Code is personal.', '{humor,coding}', '{}', '{}'),
(332, null, 'CodeWarrior007', 'Just finished a project without any merge conflicts. Feels like winning the lottery.', '{motivation,coding}', '{}', '{}'),
(333, 0332, 'StackOverflowLord', 'You should definitely buy a lottery ticket today.', '{motivation,coding}', '{}', '{}'),
(334, 0311, 'CodeWarrior007', 'Leap year bugs are like finding Easter eggs... painful ones.', '{humor,bugs}', '{}', '{}'),
(335, 0313, 'StackOverflowLord', 'More panic and less cake, unfortunately.', '{humor,exceptions}', '{}', '{}'),
(336, 0313, 'BugHunter42', 'Segfaults: the ultimate surprise gift from your code.', '{humor,exceptions}', '{}', '{}'),
(337, 0314, 'NullPointerQueen', 'That''s some next-level optimization. Hats off!', '{motivation,coding}', '{}', '{}'),
(338, 0314, 'StackOverflowLord', 'O(n log n)? You must have used some dark magic.', '{motivation,coding}', '{}', '{}'),
(339, 0316, 'BugHunter42', 'Global variables are so last century.', '{humor,coding}', '{}', '{}'),
(340, 0318, 'SyntaxSamurai', 'Nothing like a good variable name typo to humble you.', '{humor,debugging}', '{}', '{}'),
(341, 0318, 'StackOverflowLord', 'Variable typos: the bane of every coder''s existence.', '{humor,debugging}', '{}', '{}'),
(342, 0320, 'NullPointerQueen', 'Autocomplete is the friend who tries too hard.', '{humor,coding}', '{}', '{}'),
(343, 0320, 'DebuggerDiva', 'And sometimes, it''s that annoying friend who finishes your sentences wrong.', '{humor,coding}', '{}', '{}'),
(344, 0322, 'CodeWarrior007', 'It''s their way of saying "Welcome to the real world."', '{humor,learning}', '{}', '{}'),
(345, 0322, 'SyntaxSamurai', 'Because simplicity is a complex concept.', '{humor,learning}', '{}', '{}'),
(346, 0324, 'BugHunter42', 'The mystery of working code: embrace it.', '{humor,coding}', '{}', '{}'),
(347, 0324, 'StackOverflowLord', 'Sometimes code just wants to be mysterious.', '{humor,coding}', '{}', '{}'),
(348, 0326, 'DebuggerDiva', 'Typo bugs: 1, Human: 0.', '{humor,debugging}', '{}', '{}'),
(349, 0328, 'NullPointerQueen', 'Breakpoints are the unsung heroes of debugging.', '{humor,debugging}', '{}', '{}'),
(350, 0328, 'CodeWarrior007', 'Breakpoints and coffee: the ultimate combo.', '{humor,debugging}', '{}', '{}'),
(351, 0330, 'BugHunter42', 'Because they reveal your deepest coding secrets.', '{humor,coding}', '{}', '{}'),
(352, 0330, 'StackOverflowLord', 'It''s a safe space to discuss your code crimes.', '{humor,coding}', '{}', '{}'),
(353, 0332, 'NullPointerQueen', 'Merge conflicts are the worst. Congrats on avoiding them!', '{motivation,coding}', '{}', '{}'),
(354, 0332, 'DebuggerDiva', 'That''s a rare achievement! Celebrate it.', '{motivation,coding}', '{}', '{}'),
(355, null, 'BugHunter42', 'This is a secret post only visible to users with secret tag.', '{humor}', '{secret}', '{}'),
(356, null, 'DebuggerDiva', 'Internal team discussion about upcoming features.', '{coding}', '{internal}', '{}'),
(357, null, 'BugHunter42', 'Direct message to BugHunter42 and DebuggerDiva.', '{general}', '{}', '{BugHunter42,DebuggerDiva}');

insert into usr (name, email, password, bio, email_verified_at, invited_by, orgs_r, orgs_w)
values ('john_doe', 'john@example.com', 'hashed:password1!', 'sample bio', now(), 'john_doe', '{secret}', '{secret}')
on conflict do nothing;

insert into usr (name, email, password, bio, email_verified_at, invited_by, orgs_r, orgs_w)
values ('jane_doe', 'jane@example.com', 'hashed:password1!', 'sample bio', now(), 'john_doe', '{}', '{}')
on conflict do nothing;

select setval('com_cid_seq', (select max(cid) from com));

update com set domains = coalesce((
  select array_agg(distinct regexp_replace(lower(rtrim(m[1], '.,;:)]}>')), '^www\\.', ''))
  from regexp_matches(body, 'https?://([^/\\s:?#]+)', 'g') as m
), '{}');

-- stat_tag is materialized, so it is an empty snapshot until refreshed — and refresh_score
-- reads it, so this has to land first or every seeded score loses its tag term.
refresh materialized view stat_tag;

select refresh_score(array(select cid from com));
`;

//// PGLITE WRAPPER ////////////////////////////////////////////////////////////

// Signup's MX check calls Deno.resolveDns; stub it so tests never touch the network. Real-looking
// domains "resolve"; `.invalid` (RFC 2606, never resolves) throws NotFound to exercise the reject
// path. The fail-open step swaps in its own thrower and restores this.
const fakeResolveDns =
  ((domain: string, recordType: "MX" | "A") =>
    domain.endsWith(".invalid")
      ? Promise.reject(new Deno.errors.NotFound(`no ${recordType} for ${domain}`))
      : Promise.resolve(
        recordType === "MX" ? [{ preference: 10, exchange: "mx.test" }] : ["1.2.3.4"],
      )) as typeof Deno.resolveDns;

// PGlite has no pgcrypto, so gen_salt/crypt are mocked; the schema's own
// `create extension pgcrypto` is stripped for the same reason.
const setup = [
  `create or replace function gen_salt(text, int default 8) returns text language sql as $$ select 'salt' $$;
   create or replace function crypt(password text, salt text) returns text language sql as $$
     select case when salt like '$%' then password else 'hashed:' || password end
   $$;`,
  dbSql.replace(/create extension if not exists pgcrypto;/i, ""),
  seedSql,
];

// Schema + seed cost the same on every test, so pay once and boot the rest from the
// tarball — pgtemp restores a snapshot ~3x faster than replaying the DDL.
const snapshot = await (async () => {
  await using seed = await pgtemp({ extensions: { citext, hstore }, setup });
  return await seed.snapshot();
})();

const pgtest = (f: (sql: pg.Sql) => (t: Deno.TestContext) => Promise<void>) => async (t: Deno.TestContext) => {
  await using db = await pgtemp({ extensions: { citext, hstore }, snapshot });

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

  setSql(db.sql);
  postRate.clear();
  prefRate.clear();
  dbIngestRate.ip.clear();
  dbIngestRate.key.clear();
  signupRate.ip.clear();
  signupRate.perHour = 10_000; // don't throttle the general suite; a dedicated step tests it low
  Deno.resolveDns = fakeResolveDns; // hermetic MX check (no live DNS)
  await f(db.sql)(t);
};

//// TESTS /////////////////////////////////////////////////////////////////////

const basic = (email: string, pass: string) => ({ Authorization: "Basic " + btoa(`${email}:${pass}`) });

// DATABASE_URL is Neon's transaction-mode `-pooler`, where a named prepared statement outlives
// the client that made it. With prepare on, `alter table ... drop column` invalidates the cached
// plans and every isolate 500s with "cached plan must not change result type". That took ding.bar
// down on 2026-08-09; this pins the setting so it can't be dropped by accident.
Deno.test("postgres client disables prepared statements (Neon pooler is transaction-mode)", () => {
  const src = Deno.readTextFileSync(new URL("./server.tsx", import.meta.url));
  const opts = src.slice(src.indexOf("export let sql: Sql = pg("), src.indexOf("export const setSql"));
  assertStringIncludes(opts, "prepare: false");
});

Deno.test(
  "routes",
  pgtest((sql) => async (t) => {
    await t.step("GET /robots.txt", async () => {
      const res = await app.request("/robots.txt");
      assertEquals(res.status, 200);
    });

    await t.step("POST /login wrong credentials redirects to /u with error and prefilled email", async () => {
      const body = new FormData();
      body.append("email", "john@example.com");
      body.append("password", "wrong!");
      const res = await app.request("/login", { method: "post", body });
      assertEquals(res.status, 302);
      const location = res.headers.get("location")!;
      assertEquals(location, `/u?error=bad_login&email=${encodeURIComponent("john@example.com")}`);
      const followed = await app.request(location);
      assertEquals(followed.status, 200);
      const html = await followed.text();
      assertStringIncludes(html, "wrong email or password");
      assertStringIncludes(html, `value="john@example.com"`);
    });

    await t.step("POST /login unknown email redirects to /signup with prefilled email", async () => {
      const body = new FormData();
      body.append("email", "nobody@example.com");
      body.append("password", "anything");
      const res = await app.request("/login", { method: "post", body });
      assertEquals(res.status, 302);
      const location = res.headers.get("location")!;
      assertEquals(location, `/signup?error=email_not_found&email=${encodeURIComponent("nobody@example.com")}`);
      const followed = await app.request(location);
      assertEquals(followed.status, 200);
      const html = await followed.text();
      assertStringIncludes(html, "No account with that email");
      assertStringIncludes(html, `value="nobody@example.com"`);
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
      assertStringIncludes(await res.text(), "expired");
    });

    await t.step("GET /password with no query params shows expired-link page", async () => {
      const res = await app.request("/password");
      assertEquals(res.status, 200);
      const html = await res.text();
      assertStringIncludes(html, "invalid or expired");
      assertEquals(html.includes(`name="password"`), false);
    });

    await t.step("GET /password with stale token shows expired-link page", async () => {
      const res = await app.request("/password?email=john@example.com&token=123:bogus");
      assertEquals(res.status, 200);
      const html = await res.text();
      assertStringIncludes(html, "invalid or expired");
      assertEquals(html.includes(`name="password"`), false);
    });

    await t.step("GET /password with valid token shows password form", async () => {
      const tok = await emailToken(new Date(), "john@example.com");
      const res = await app.request(
        `/password?email=${encodeURIComponent("john@example.com")}&token=${encodeURIComponent(tok)}`,
      );
      assertEquals(res.status, 200);
      const html = await res.text();
      assertStringIncludes(html, `name="password"`);
      assertStringIncludes(html, "john@example.com");
    });

    await t.step("HTML 404 renders styled error page (not blank)", async () => {
      const res = await app.request("/u/nonexistent_user", { headers: { accept: "text/html" } });
      assertEquals(res.status, 404);
      const html = await res.text();
      assertStringIncludes(html, "Not found.");
      assertStringIncludes(html, "<html"); // full layout, not bare response
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

    await t.step("GET / and /c tolerate malformed p/limit (no 500)", async () => {
      for (const u of ["/?p=notanumber", "/?p=-5", "/c?p=notanumber", "/c?p=-9", "/c?limit=garbage", "/c?limit=-3"])
        assertEquals((await app.request(u)).status, 200, u);
    });

    // OFFSET is a scan postgres cannot skip, so an unbounded ?p= is a request to walk the
    // whole table. The cap is on p * limit, so it means the same depth at any page size.
    await t.step("a page past the offset cap is refused, not silently clamped", async () => {
      for (const u of ["/?p=99999999", "/c?p=99999999", "/?p=201", "/c?p=201"]) {
        const res = await app.request(u);
        assertEquals(res.status, 400, u);
        assertStringIncludes(await res.text(), "past the last reachable page");
      }
      // ?limit= moves the page count but not the depth: 5000/100 = 50 pages.
      assertEquals((await app.request("/c?limit=100&p=50")).status, 200);
      assertEquals((await app.request("/c?limit=100&p=51")).status, 400);
      // The last page inside the cap still works, so the bound is off-by-one clean.
      assertEquals((await app.request("/?p=200")).status, 200);
    });

    // A browser must never be able to click its way into that 400. Shrink the cap rather
    // than seeding 5000 rows: at the default a page that deep returns nothing, so `more`
    // would be false anyway and the assertion would prove nothing.
    await t.step("the next link disappears at the cap", async () => {
      // Two full pages of public roots, so `more` turns on the item count and the cap is
      // the only thing that can turn it back off.
      await sql`insert into com (created_by, body, tags, created_at, score)
                select 'BugHunter42', 'pagecap ' || g, '{pagecap}', now(), now()
                  from generate_series(1, 30) g`;
      try {
        paging.maxOffset = 25; // last reachable page is p=1
        assertStringIncludes(await (await app.request("/")).text(), "p=1", "page 0 should still offer next");
        const atCap = await (await app.request("/?p=1")).text();
        assertStringIncludes(atCap, 'class="posts"'); // still a full page of results...
        assertEquals(atCap.includes("p=2"), false, "rendered a next link past the cap");
        // ...and the page it would have linked to is exactly what the handler refuses.
        assertEquals((await app.request("/?p=2")).status, 400);
      } finally {
        paging.maxOffset = 5000;
        await sql`delete from com where tags @> '{pagecap}'`;
      }
    });

    // This file shipped as one string containing "\\n", i.e. LITERAL backslash-n, so every
    // crawler saw a single unparseable line and ding had no rules at all.
    await t.step("robots.txt is a real multi-line file", async () => {
      const res = await app.request("/robots.txt");
      assertEquals(res.status, 200);
      const txt = await res.text();
      assertEquals(txt.includes("\\n"), false, "robots.txt contains a literal backslash-n again");
      const lines = txt.split("\n").map((l) => l.trim());
      assertEquals(lines[0], "User-agent: *");
      assertEquals(lines.includes("Disallow: /*?"), true);
      assertEquals(lines.includes("Sitemap: https://ding.bar/sitemap.txt"), true);
      // Every blocked crawler needs its own User-agent line followed by a Disallow.
      for (const ua of AI_CRAWLERS) {
        const at = lines.indexOf(`User-agent: ${ua}`);
        assertEquals(at >= 0, true, `${ua} missing from robots.txt`);
        assertEquals(lines[at + 1], "Disallow: /", `${ua} has no Disallow`);
      }
    });

    // robots.txt is advisory and the heaviest scrapers ignore it, so the same policy is
    // enforced in the middleware — unlike botRe's, this block is not query-string-only.
    await t.step("training scrapers are refused on every path", async () => {
      for (const ua of AI_CRAWLERS) {
        for (const path of ["/", "/c", "/c/301", "/u/BugHunter42"]) {
          const res = await app.request(path, { headers: { "User-Agent": `Mozilla/5.0 (compatible; ${ua}/1.0)` } });
          assertEquals(res.status, 403, `${ua} got ${res.status} on ${path}`);
        }
      }
    });

    // A 403 to a search engine delists the site, so the hard block must never catch one.
    await t.step("search engines still reach content URLs", async () => {
      for (
        const ua of [
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
          "Mozilla/5.0 (compatible; DuckDuckBot/1.1)",
        ]
      ) {
        assertEquals((await app.request("/", { headers: { "User-Agent": ua } })).status, 200, ua);
        assertEquals((await app.request("/c/301", { headers: { "User-Agent": ua } })).status, 200, ua);
        // ...but the infinite filter space still costs them a 403, as before.
        assertEquals((await app.request("/c?tag=humor", { headers: { "User-Agent": ua } })).status, 403, ua);
      }
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

    await t.step("POST /signup honeypot filled → silent ?ok, no account created", async () => {
      const body = new FormData();
      body.append("name", "hp_bot_user");
      body.append("email", "hpbot@example.com");
      body.append("url", "http://spam.example"); // bots fill the hidden field
      const res = await app.request("/signup", { method: "POST", body });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/signup?ok");
      const [{ count }] = await sql`select count(*)::int as count from usr where name = 'hp_bot_user'`;
      assertEquals(count, 0);
    });

    await t.step("POST /signup disposable domain → ?error=bad_email, no account created", async () => {
      const body = new FormData();
      body.append("name", "disposable_user");
      body.append("email", "throwaway@mailinator.com");
      const res = await app.request("/signup", { method: "POST", body });
      assertEquals(res.status, 302);
      assertEquals(
        res.headers.get("location"),
        `/signup?error=bad_email&email=${encodeURIComponent("throwaway@mailinator.com")}`,
      );
      const [{ count }] = await sql`select count(*)::int as count from usr where name = 'disposable_user'`;
      assertEquals(count, 0);
    });

    await t.step("POST /signup domain with no MX/A → ?error=bad_email, no account created", async () => {
      const body = new FormData();
      body.append("name", "nomx_user");
      body.append("email", "someone@nxdomain.invalid"); // fakeResolveDns throws NotFound for .invalid
      const res = await app.request("/signup", { method: "POST", body });
      assertEquals(res.status, 302);
      assertStringIncludes(res.headers.get("location") ?? "", "/signup?error=bad_email");
      const [{ count }] = await sql`select count(*)::int as count from usr where name = 'nomx_user'`;
      assertEquals(count, 0);
    });

    await t.step("badSignupEmail fails OPEN on a transient resolver error", async () => {
      Deno.resolveDns = (() => Promise.reject(new Error("resolver timeout"))) as typeof Deno.resolveDns;
      try {
        // Non-disposable domain, resolver errors non-NotFound → must NOT be rejected.
        assertEquals(await badSignupEmail("real@some-legit-domain.com"), null);
      } finally {
        Deno.resolveDns = fakeResolveDns;
      }
    });

    await t.step("POST /signup per-IP throttle → Nth+1 attempt from same IP is 429", async () => {
      const saved = signupRate.perHour;
      signupRate.perHour = 3;
      signupRate.ip.clear();
      const ip = "203.0.113.7";
      try {
        for (let i = 0; i < 3; i++) {
          const body = new FormData();
          body.append("name", `ratelimited_${i}`);
          body.append("email", `rl${i}@example.com`);
          const res = await app.request("/signup", {
            method: "POST",
            body,
            headers: { "cf-connecting-ip": ip },
          });
          assertEquals(res.status, 302, `attempt ${i} should pass`);
        }
        const body = new FormData();
        body.append("name", "ratelimited_over");
        body.append("email", "rlover@example.com");
        const res = await app.request("/signup", {
          method: "POST",
          body,
          headers: { "cf-connecting-ip": ip },
        });
        assertEquals(res.status, 429);
      } finally {
        signupRate.perHour = saved;
        signupRate.ip.clear();
      }
    });

    await t.step("GET /us lists verified accounts and excludes unverified", async () => {
      // john_doe is verified (john@example.com); fresh_user was created unverified earlier.
      const res = await app.request("/us");
      assertEquals(res.status, 200);
      const names = ((await res.json()) as { name: string }[]).map((u) => u.name);
      assertEquals(names.includes("john_doe"), true);
      assertEquals(names.includes("fresh_user"), false);
    });

    await t.step(
      "sendVerify cooldown: two POSTs to /signup/resend within 5min trigger only one Resend send",
      async () => {
        const body = new FormData();
        body.append("name", "cooldown_user");
        body.append("email", "cooldown@example.com");
        await app.request("/signup", { method: "POST", body }); // creates + first send

        const before = sentEmails.filter((m) => m.to === "cooldown@example.com").length;
        const r1 = new FormData();
        r1.append("email", "cooldown@example.com");
        const res1 = await app.request("/signup/resend", { method: "POST", body: r1 });
        assertEquals(res1.status, 302);
        assertEquals(res1.headers.get("location"), "/signup?resent");
        const r2 = new FormData();
        r2.append("email", "cooldown@example.com");
        const res2 = await app.request("/signup/resend", { method: "POST", body: r2 });
        assertEquals(res2.status, 302);
        assertEquals(res2.headers.get("location"), "/signup?resent");

        const after = sentEmails.filter((m) => m.to === "cooldown@example.com").length;
        assertEquals(after - before, 0); // both extra calls suppressed by cooldown

        // Backdating verify_sent_at past the cooldown allows another send.
        await sql`update usr set verify_sent_at = now() - interval '10 minutes' where email = 'cooldown@example.com'`;
        const r3 = new FormData();
        r3.append("email", "cooldown@example.com");
        const res3 = await app.request("/signup/resend", { method: "POST", body: r3 });
        assertEquals(res3.status, 302);
        const afterReset = sentEmails.filter((m) => m.to === "cooldown@example.com").length;
        assertEquals(afterReset - after, 1);
      },
    );

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
          ...basic("john@example.com", "password1!"),
        },
      });
      assertEquals(res.status, 200);
    });

    await t.step("GET /u with invalid credentials", async () => {
      const res = await app.request("/u", {
        headers: basic("john@example.com", "wrong!"),
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

    await t.step("pages load client.js from /public, not inline", async () => {
      const text = await (await app.request("/")).text();
      assertStringIncludes(text, `<script src="/client.js" defer></script>`);
      assertEquals(text.includes("document.querySelectorAll"), false);
      const js = await app.request("/client.js");
      assertEquals(js.status, 200);
      assertStringIncludes(await js.text(), "ding:compose-body");
    });

    // Unversioned (local dev): assets must stay revalidated so edits show up.
    await t.step("assets are not cached without a deploy version", async () => {
      for (const p of ["/client.js", "/style.css", "/client.js?v=whatever"])
        assertEquals((await app.request(p)).headers.get("cache-control"), null, p);
    });

    // Versioned (deployed): ?v=<DENO_DEPLOYMENT_ID> is a fresh URL every deploy, so the old
    // one is never requested again and immutable is safe. Tests can't set the real env var —
    // that would make Deno.cron register the bot fleet — hence setAssetV.
    await t.step("a versioned asset URL is immutable, a bare or stale one is not", async () => {
      setAssetV("deploy123");
      try {
        const html = await (await app.request("/")).text();
        assertStringIncludes(html, `<script src="/client.js?v=deploy123" defer></script>`);
        assertStringIncludes(html, `<link rel="stylesheet" href="/style.css?v=deploy123" />`);
        assertStringIncludes(
          await (await app.request("/embed?url=https://x.example/a")).text(),
          `href="https://ding.bar/style.css?v=deploy123"`,
        );

        const cc = async (p: string) => (await app.request(p)).headers.get("cache-control");
        assertEquals(await cc("/client.js?v=deploy123"), "public, max-age=31536000, immutable");
        assertEquals(await cc("/style.css?v=deploy123"), "public, max-age=31536000, immutable");
        assertEquals(await cc("/client.js"), null); // bare path must not be pinned for a year
        assertEquals(await cc("/client.js?v=olddeploy"), null); // a stale version must revalidate
      } finally {
        setAssetV("");
      }
    });

    await t.step("data-unread is present only for logged-in viewers", async () => {
      assertEquals((await (await app.request("/")).text()).includes("data-unread"), false);
      const loginBody = new FormData();
      loginBody.append("email", "john@example.com");
      loginBody.append("password", "password1!");
      const boot = await app.request("/login", { method: "POST", body: loginBody });
      const cookie = boot.headers.get("set-cookie")!.split(";")[0];
      assertStringIncludes(await (await app.request("/", { headers: { cookie } })).text(), `data-unread="`);
    });

    // Regression: the p param must be REPLACED, not appended. c.req.query reads the first
    // value, so an appended p made every prev/next link back to the page you were on.
    await t.step("pagination links replace p instead of appending it", async () => {
      const html = await (await app.request("/?p=1&sort=new")).text();
      const links = [...html.matchAll(/<a href="([^"]*p=[^"]*)"[^>]*>(prev|next)</g)].map((m) => m[1]);
      assertEquals(links.length > 0, true);
      for (const href of links) {
        const ps = new URLSearchParams(href.split("?")[1]).getAll("p");
        assertEquals(ps.length, 1);
        assertEquals(ps[0] === "1", false);
      }
      assertStringIncludes(html, "sort=new");
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
          ...basic("john@example.com", "password1!"),
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
          ...basic("john@example.com", "wrong!"),
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
  pgtest((sql) => async (t) => {
    const authHeaders = {
      ...basic("john@example.com", "password1!"),
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
      const janeAuth = basic("jane@example.com", "password1!");
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

      const janeAuth = basic("jane@example.com", "password1!");
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
      const janeAuth = basic("jane@example.com", "password1!");
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
  pgtest((sql) => async (t) => {
    const jAuth = basic("john@example.com", "password1!");
    const janeAuth = basic("jane@example.com", "password1!");
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

    await t.step("POST /c root 400 with helpful message when no tag and no recipient", async () => {
      const res = await app.request("/c", { method: "POST", body: fd({ body: "no tag", tags: "" }), headers: jAuth });
      assertEquals(res.status, 400);
      const body = await res.text();
      assertStringIncludes(body, "#tag, *org, or @user");
    });

    await t.step("POST /c root DM happy path: tagless post with @recipient", async () => {
      const res = await app.request("/c", {
        method: "POST",
        body: fd({ body: "psst", tags: "@john_doe" }),
        headers: janeAuth,
      });
      assertEquals(res.status, 302);
      const cid = cidFromLocation(res.headers.get("location")!);
      const [row] = await sql`select tags, usrs, created_by from com where cid = ${cid}`;
      assertEquals(row.tags, []);
      assertEquals(row.usrs, ["john_doe"]);
      assertEquals(row.created_by, "jane_doe");

      const senderView = await app.request(`/c/${cid}`, { headers: janeAuth });
      assertEquals(senderView.status, 200);
      assertStringIncludes(await senderView.text(), "psst");

      const recipientView = await app.request(`/c/${cid}`, { headers: jAuth });
      assertEquals(recipientView.status, 200);
      assertStringIncludes(await recipientView.text(), "psst");

      const anonView = await app.request(`/c/${cid}`);
      assertEquals(anonView.status, 404);
    });

    await t.step("POST /c root mixed tag + recipient still works", async () => {
      const res = await app.request("/c", {
        method: "POST",
        body: fd({ body: "hi all", tags: "#pub @john_doe" }),
        headers: janeAuth,
      });
      assertEquals(res.status, 302);
      const cid = cidFromLocation(res.headers.get("location")!);
      const [row] = await sql`select tags, usrs from com where cid = ${cid}`;
      assertEquals(row.tags, ["pub"]);
      assertEquals(row.usrs, ["john_doe"]);
    });

    await t.step("DB constraint still rejects raw tagless + recipientless root insert", async () => {
      let threw = false;
      try {
        await sql`insert into com (created_by, body, tags, usrs) values ('john_doe', 'nope', '{}', '{}')`;
      } catch {
        threw = true;
      }
      assertEquals(threw, true);
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
      assertEquals(html.includes(`class="body body-full"`), true);
      assertEquals(html.includes("[flagged]"), true);
      assertEquals(
        /class="body[^"]*">\s*secret body text/.test(html),
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
      const auth = basic("rate@example.com", "rate!");
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
  pgtest((sql) => async (t) => {
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

    await t.step("burst-poster (5+ posts in 1h) ranks below calm poster", async () => {
      for (const u of ["bursty", "calm"]) await mkUser(u);
      // bursty floods 5 posts within minutes
      for (let i = 0; i < 5; i++)
        await sql`insert into com (created_by, body, tags) values ('bursty', ${"flood " + i}, '{burst1}')`;
      await sql`select refresh_score(array(select cid from com where created_by = 'bursty'))`;
      const b = await mkPost("bursty", "buried?", ["burst2"]);
      const c = await mkPost("calm", "single", ["burst2"]);
      assertEquals((await score(b)) < (await score(c)), true);
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

    await t.step("bot_ user posts rank below regular user posts", async () => {
      for (const u of ["bot_demo", "human_demo"]) await mkUser(u);
      const botPost = await mkPost("bot_demo", "bot post", ["zz"]);
      const humanPost = await mkPost("human_demo", "human post", ["zz"]);
      assertEquals((await score(botPost)) < (await score(humanPost)), true);
    });
  }),
);

//// BOT INTERACTION TESTS //////////////////////////////////////////////////////

Deno.test(
  "bot interactions",
  pgtest((sql) => async (t) => {
    // Create a bot user
    await sql`insert into usr (name, email, password, bio, invited_by, email_verified_at)
      values ('bot_test', 'bot-test@ding.bar', 'hashed:botpass!', 'I am a test bot', 'john_doe', now())`;
    const botAuth = basic("bot-test@ding.bar", "botpass!");
    const jAuth = basic("john@example.com", "password1!");
    const janeAuth = basic("jane@example.com", "password1!");
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
      assertEquals(row.tags, ["test", "bot"]); // com.tags keeps submission order (dht.tags is sorted)
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
  pgtest((sql) => async (t) => {
    const jAuth = basic("john@example.com", "password1!");
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
  pgtest((_sql) => async (t) => {
    const jAuth = basic("john@example.com", "password1!");
    const janeAuth = basic("jane@example.com", "password1!");
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

    // /c is the only feed that exposes child bodies (HTML and JSON). GET / renders roots only,
    // so it must not pay for a child_comments subquery it throws away.
    await t.step("a private reply under a public root never reaches a stranger", async () => {
      const [root] = await _sql`
        insert into com (parent_cid, created_by, tags, body)
        values (null, 'jane_doe', array['leaktest'], 'public root here') returning cid`;
      await _sql`
        insert into com (parent_cid, created_by, orgs, body)
        values (${root.cid}, 'john_doe', array['secret'], 'org-only reply body')`;
      // authored by jane, addressed to a third party: john is neither author nor recipient
      await _sql`
        insert into com (parent_cid, created_by, usrs, body)
        values (${root.cid}, 'jane_doe', array['BugHunter42'], 'dm-only reply body')`;

      const bodies = async (headers: Record<string, string>) => {
        const feed = await (await app.request("/c?tag=leaktest", { headers })).json();
        assertEquals(feed.length, 1);
        return (feed[0].child_comments ?? []).map((ch: { body: string }) => ch.body);
      };
      const asJson = { Accept: "application/json" };
      assertEquals(await bodies(asJson), []); // stranger sees neither
      // the *secret member sees the org reply, still not jane's DM
      assertEquals(await bodies({ ...asJson, ...basic("john@example.com", "password1!") }), ["org-only reply body"]);

      // GET / renders roots only — it must not even fetch children
      assertEquals((await (await app.request("/?tag=leaktest")).text()).includes("org-only reply body"), false);
    });

    await t.step("/n requires auth", async () => {
      const res = await app.request("/n");
      assertEquals(res.status, 401);
    });

    // The nav badge, GET /n and GET /n/unread share one predicate (notifWhere). If they drift,
    // the header count disagrees with the inbox. The badge must also not fire on /n/unread
    // itself — that request renders no nav, so counting there is pure duplicate work.
    await t.step("nav badge count agrees with /n/unread", async () => {
      const loginBody = new FormData();
      loginBody.append("email", "john@example.com");
      loginBody.append("password", "password1!");
      const boot = await app.request("/login", { method: "POST", body: loginBody });
      const cookie = boot.headers.get("set-cookie")!.split(";")[0];

      const { count } = await (await app.request("/n/unread", { headers: jAuth })).json();
      const html = await (await app.request("/", { headers: { cookie } })).text();
      assertStringIncludes(html, `data-unread="${count}"`);
      assertStringIncludes(html, count ? `inbox (${count})` : ">inbox<");
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

//// UPLOAD TESTS /////////////////////////////////////////////////////////////

Deno.test(
  "uploads",
  pgtest((_sql) => async (t) => {
    const jAuth = basic("john@example.com", "password1!");
    type Call = { filename: string; contentType: string; prefix: string; size: number };
    const calls: Call[] = [];
    const original = r2.uploadToR2;
    r2.uploadToR2 = (data, filename, contentType, keyPrefix = "bots/") => {
      calls.push({ filename, contentType, prefix: keyPrefix, size: data.byteLength });
      return Promise.resolve(`mock://${keyPrefix}${filename}`);
    };

    try {
      await t.step("POST /i happy path image", async () => {
        calls.length = 0;
        const fd = new FormData();
        fd.append("id", "abc12345.png");
        fd.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "test.png");
        const res = await app.request("/i", { method: "POST", body: fd, headers: jAuth });
        assertEquals(res.status, 204);
        assertEquals(calls.length, 1);
        assertEquals(calls[0].filename, "abc12345.png");
        assertEquals(calls[0].contentType, "image/png");
        assertEquals(calls[0].prefix, "i/");
        assertEquals(calls[0].size, 3);
      });

      await t.step("POST /i happy path pdf", async () => {
        calls.length = 0;
        const fd = new FormData();
        fd.append("id", "Xy7Zq8Aa.pdf");
        fd.append("file", new Blob([new Uint8Array([4, 5])], { type: "application/pdf" }), "doc.pdf");
        const res = await app.request("/i", { method: "POST", body: fd, headers: jAuth });
        assertEquals(res.status, 204);
        assertEquals(calls[0].contentType, "application/pdf");
      });

      await t.step("POST /i bad id (too short)", async () => {
        const fd = new FormData();
        fd.append("id", "abc.png");
        fd.append("file", new Blob([new Uint8Array([1])], { type: "image/png" }), "x.png");
        const res = await app.request("/i", { method: "POST", body: fd, headers: jAuth });
        assertEquals(res.status, 400);
      });

      await t.step("POST /i unsupported ext", async () => {
        const fd = new FormData();
        fd.append("id", "abc12345.exe");
        fd.append("file", new Blob([new Uint8Array([1])]), "x.exe");
        const res = await app.request("/i", { method: "POST", body: fd, headers: jAuth });
        assertEquals(res.status, 400);
      });

      await t.step("POST /i path traversal id rejected", async () => {
        const fd = new FormData();
        fd.append("id", "../etc/pw.png");
        fd.append("file", new Blob([new Uint8Array([1])], { type: "image/png" }), "x.png");
        const res = await app.request("/i", { method: "POST", body: fd, headers: jAuth });
        assertEquals(res.status, 400);
      });

      await t.step("POST /i missing file", async () => {
        const fd = new FormData();
        fd.append("id", "abc12345.png");
        const res = await app.request("/i", { method: "POST", body: fd, headers: jAuth });
        assertEquals(res.status, 400);
      });

      await t.step("POST /i oversized 413", async () => {
        const big = new Uint8Array(26 * 1024 * 1024);
        const fd = new FormData();
        fd.append("id", "xyz98765.png");
        fd.append("file", new Blob([big], { type: "image/png" }), "big.png");
        const res = await app.request("/i", { method: "POST", body: fd, headers: jAuth });
        assertEquals(res.status, 413);
      });

      // The reported prod 500: a client that goes away mid-upload makes formData() throw
      // "error reading a body from connection", which became a bare 500 and a stack trace.
      // It is a truncated request, so it must read as one.
      await t.step("POST /i names a truncated upload instead of 500ing", async () => {
        const body = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode('--x\r\nContent-Disposition: form-data; name="id"\r\n\r\n'));
            ctrl.error(new Error("connection reset"));
          },
        });
        const res = await app.request("/i", {
          method: "POST",
          body,
          headers: { ...jAuth, "content-type": "multipart/form-data; boundary=x" },
          // @ts-expect-error: required by fetch whenever the body is a stream
          duplex: "half",
        });
        assertEquals(res.status, 400, "a dropped upload must not be a 500");
        assertStringIncludes(await res.text(), "upload did not finish");
      });

      // The size checks all run after the body is buffered, so a caller that skips the
      // client-side guard would otherwise make the isolate read the whole thing to refuse it.
      // The size checks all run after the body is buffered, so a caller that skips the
      // client-side guard would otherwise make the isolate read the whole thing to refuse it.
      // The body here fails if read, so 413 (rather than the truncated-upload 400 above) is
      // what proves the declared-length check ran first.
      await t.step("POST /i refuses an oversized declared length before reading the body", async () => {
        const body = new ReadableStream({
          pull: (ctrl) => ctrl.error(new Error("body should never have been read")),
        });
        const res = await app.request("/i", {
          method: "POST",
          body,
          headers: {
            ...jAuth,
            "content-type": "multipart/form-data; boundary=x",
            "content-length": String(500 * 1024 * 1024),
          },
          // @ts-expect-error: required by fetch whenever the body is a stream
          duplex: "half",
        });
        assertEquals(res.status, 413, "the body was read before the declared length was checked");
        assertStringIncludes(await res.text(), "the limit is 25 MB");
      });

      await t.step("POST /i bad id says what shape it wanted", async () => {
        const fd = new FormData();
        fd.append("id", "nope.exe");
        fd.append("file", new Blob([new Uint8Array([1])], { type: "image/png" }), "x.png");
        const res = await app.request("/i", { method: "POST", body: fd, headers: jAuth });
        assertEquals(res.status, 400);
        const msg = await res.text();
        assertStringIncludes(msg, "nope.exe");
        assertStringIncludes(msg, "a1b2c3d4.png");
      });

      await t.step("POST /i unauthed 401", async () => {
        const fd = new FormData();
        fd.append("id", "abc12345.png");
        fd.append("file", new Blob([new Uint8Array([1])], { type: "image/png" }), "x.png");
        const res = await app.request("/i", { method: "POST", body: fd });
        assertEquals(res.status, 401);
      });

      await t.step("i.ding.bar proxy serves valid path", async () => {
        const orig = globalThis.fetch;
        Deno.env.set("R2_PUBLIC_URL", "https://r2-pub.example");
        globalThis.fetch = ((input: string | URL | Request) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === "https://r2-pub.example/i/abc12345.png") {
            return Promise.resolve(
              new Response(new Uint8Array([7, 8, 9]), {
                status: 200,
                headers: { "content-type": "image/png" },
              }),
            );
          }
          return orig(input as RequestInfo);
        }) as typeof fetch;
        try {
          const res = await app.request("/abc12345.png", { headers: { Host: "i.ding.bar" } });
          assertEquals(res.status, 200);
          assertEquals(res.headers.get("content-type"), "image/png");
          assertEquals(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
        } finally {
          globalThis.fetch = orig;
        }
      });

      await t.step("i.ding.bar proxy 404 for malformed path", async () => {
        const res = await app.request("/not-valid", { headers: { Host: "i.ding.bar" } });
        assertEquals(res.status, 404);
      });

      await t.step("i.ding.bar proxy 404 for traversal attempt", async () => {
        const res = await app.request("/..%2Fetc%2Fpw.png", { headers: { Host: "i.ding.bar" } });
        assertEquals(res.status, 404);
      });

      await t.step("post body containing i.ding.bar URL round-trips", async () => {
        const url = "https://i.ding.bar/abc12345.png";
        const fd = new FormData();
        fd.append("body", `look at this ${url}`);
        fd.append("tags", "#pics");
        const r = await app.request("/c", { method: "POST", body: fd, headers: jAuth });
        assertEquals(r.status, 302);
        const cid = +r.headers.get("location")!.match(/\/c\/(\d+)/)![1];
        const [row] = await _sql`select body from com where cid = ${cid}`;
        assertStringIncludes(row.body, url);
      });

      await t.step("POST /i rejects svg (XSS vector)", async () => {
        const fd = new FormData();
        fd.append("id", "abc12345.svg");
        fd.append("file", new Blob([new Uint8Array([1])], { type: "image/svg+xml" }), "x.svg");
        const res = await app.request("/i", { method: "POST", body: fd, headers: jAuth });
        assertEquals(res.status, 400);
      });

      await t.step("i.ding.bar proxy 500 when R2_PUBLIC_URL unset", async () => {
        const prev = Deno.env.get("R2_PUBLIC_URL");
        Deno.env.delete("R2_PUBLIC_URL");
        try {
          const res = await app.request("/abc12345.png", { headers: { Host: "i.ding.bar" } });
          assertEquals(res.status, 500);
        } finally {
          if (prev) Deno.env.set("R2_PUBLIC_URL", prev);
        }
      });
    } finally {
      r2.uploadToR2 = original;
    }
  }),
);

//// TAG DISCOVERY TESTS ///////////////////////////////////////////////////////

// Seeded tag facts these steps lean on: `general` appears ONLY on the DM (357), `secret`/
// `internal` orgs own 355/356, and BugHunter42's public roots are 301/311 (humor,bugs) +
// 322 (humor,learning) — 355 (*secret, humor) and 357 (DM, general) must never count.
Deno.test(
  "tag discovery",
  pgtest((sql) => async (t) => {
    // `GET /` reads the signed cookie, not Basic Auth — the compose form (and with it the
    // preset chips) only renders for a cookie session.
    const login = async (email: string) => {
      const body = new FormData();
      body.append("email", email);
      body.append("password", "password1!");
      const boot = await app.request("/login", { method: "POST", body });
      const setCookie = boot.headers.get("set-cookie");
      if (!setCookie) throw new Error(`no set-cookie on login as ${email}`);
      return setCookie.split(";")[0];
    };
    // The chips live in one `.tag-presets` div; the feed below renders its own label links,
    // so a whole-page substring search would happily match the wrong thing.
    const presetsOf = (html: string) => html.match(/<div class="tag-presets">([\s\S]*?)<\/div>/)?.[1] ?? "";
    const frontpage = async (cookie: string) =>
      presetsOf(await (await app.request("/", { headers: { cookie } })).text());

    await t.step("stat_tag counts public root posts only", async () => {
      const rows = await sql<
        { tag: string; posts_count: number }[]
      >`select tag, posts_count from stat_tag order by tag`;
      const byTag = Object.fromEntries(rows.map((r) => [r.tag, r.posts_count]));
      assertEquals(byTag.general, undefined, "DM-only tag leaked into stat_tag");
      assertEquals(byTag.humor, 14); // 355 is *secret-scoped and also tagged #humor
      assertEquals(byTag.coding, 7); // 356 is *internal-scoped and tagged #coding
    });

    await t.step("GET /u/:name shows top tags, ranked by ups, public posts only", async () => {
      // Two upvotes on 322 (#humor #learning) lift `learning` above `bugs` (2 posts, 0 ups)
      // and above `humor`, which shares the same 2 ups but is otherwise tied on ups.
      await sql`insert into com (parent_cid, created_by, body) values
        (322, 'DebuggerDiva', '▲'), (322, 'SyntaxSamurai', '▲')`;
      const res = await app.request("/u/BugHunter42");
      assertEquals(res.status, 200);
      const html = await res.text();
      assertStringIncludes(html, `href="/c?tag=humor" class="tag-preset"`);
      assertStringIncludes(html, `href="/c?tag=learning" class="tag-preset"`);
      assertStringIncludes(html, `href="/c?tag=bugs" class="tag-preset"`);
      assertEquals(html.includes(`href="/c?tag=general"`), false, "DM-only tag rendered on a public profile");

      const order = ["humor", "learning", "bugs"].map((tg) => html.indexOf(`/c?tag=${tg}`));
      assertEquals(order[0] < order[1] && order[1] < order[2], true, `ups-first ordering broken: ${order}`);
      assertStringIncludes(html, "▲2"); // count chip renders when ups > 0
      assertEquals(html.includes("▲0"), false, "zero-up tags should render no count");
    });

    // stat_tag is a snapshot, so a brand-new tag is invisible to discovery until the cron
    // refreshes. That is the trade this materialization buys, and it should stay deliberate:
    // if someone reverts it to a plain view this step starts failing on the first assertion.
    await t.step("a new tag reaches discovery only after refreshStats", async () => {
      await sql`insert into com (parent_cid, created_by, body, tags) values
        (null, 'SyntaxSamurai', 'fresh a', '{freshtag}'),
        (null, 'SyntaxSamurai', 'fresh b', '{freshtag}'),
        (null, 'SyntaxSamurai', 'fresh c', '{freshtag}')`;
      assertEquals(
        (await sql`select 1 from stat_tag where tag = 'freshtag'`).length,
        0,
        "stat_tag is not a snapshot — the refresh cron is now pointless",
      );
      await refreshStats();
      assertEquals((await sql`select posts_count from stat_tag where tag = 'freshtag'`)[0].posts_count, 3);
      await sql`delete from com where tags @> '{freshtag}'`;
      await refreshStats();
    });

    await t.step("GET /u/:name for a user with no posts renders no tag chips", async () => {
      const html = await (await app.request("/u/jane_doe")).text();
      assertEquals(html.includes("tag-preset"), false);
    });

    await t.step("frontpage presets keep personal tags past the alphabetical cutoff", async () => {
      // The old query was `distinct on (tag) … order by tag … limit 20`, which kept the
      // alphabetically-FIRST 20 and silently dropped the ranking. These z-tags sort last.
      const zTags = Array.from({ length: 25 }, (_, i) => `zz_own_${String(i).padStart(2, "0")}`);
      for (const tg of zTags) {
        await sql`insert into com (parent_cid, created_by, body, tags) values (null, 'john_doe', ${"post " + tg}, ${[
          tg,
        ]})`;
      }
      const chips = await frontpage(await login("john@example.com"));
      assertEquals(zTags.some((tg) => chips.includes(`>#${tg}<`)), true, "personal tags lost to alphabetical cutoff");
      assertStringIncludes(chips, `>*secret<`); // writable org still pinned first
    });

    await t.step("frontpage presets never leak a private-only tag", async () => {
      await sql`insert into com (parent_cid, created_by, body, tags, orgs) values
        (null, 'BugHunter42', 'roadmap a', '{roadmap}', '{secret}'),
        (null, 'BugHunter42', 'roadmap b', '{roadmap}', '{secret}'),
        (null, 'BugHunter42', 'roadmap c', '{roadmap}', '{secret}')`;
      await refreshStats(); // else a stale snapshot hides #roadmap and the step proves nothing
      // jane_doe reads no orgs, so #roadmap must be invisible to her however the dice fall.
      const cookie = await login("jane@example.com");
      for (let i = 0; i < 12; i++) {
        assertEquals(
          (await frontpage(cookie)).includes(">#roadmap<"),
          false,
          "private-only tag surfaced as a public chip",
        );
      }
    });

    await t.step("frontpage presets reserve discovery slots behind capped personal tags", async () => {
      // john_doe now owns 25 z-tags + *secret. Personal chips must cap at 12 so the
      // discovery slice can't be crowded out, and the whole row stays within 20.
      const labels = [...(await frontpage(await login("john@example.com"))).matchAll(/class="tag-preset">([^<]*)/g)]
        .map((m) => m[1]);
      assertEquals(labels.length <= 20, true, `too many chips: ${labels.length}`);
      assertEquals(labels.filter((l) => l.startsWith("#zz_own_") || l === "*secret").length, 12);
      assertEquals(labels.some((l) => !l.startsWith("#zz_own_") && l !== "*secret"), true, "no discovery chips");
    });

    // An explicit ▲ on a tag is the user naming it; `own`/`affinity` only infer interest from
    // having posted or upvoted. So a pref must surface as a chip on its own, with no post and
    // no upvote behind it.
    await t.step("an explicit ▲ on a tag surfaces as a compose chip", async () => {
      await sql`delete from pref where uid = 'jane_doe'`;
      const cookie = await login("jane@example.com");
      assertEquals((await frontpage(cookie)).includes(">#astronomy<"), false, "precondition: not already a chip");
      await sql`insert into pref (uid, kind, val, vote) values ('jane_doe', 'tag', 'astronomy', 1)`;
      assertStringIncludes(await frontpage(cookie), ">#astronomy<");
      await sql`delete from pref where uid = 'jane_doe'`;
    });

    // top_mine caps at 12, so priority decides who gets the slots. john owns 25 z-tags; an
    // explicitly picked tag must not have to win a recency race against them.
    await t.step("an explicit ▲ outranks own posts for the capped personal slots", async () => {
      await sql`delete from pref where uid = 'john_doe'`;
      await sql`insert into pref (uid, kind, val, vote) values ('john_doe', 'tag', 'zz_picked', 1)`;
      const chips = await frontpage(await login("john@example.com"));
      assertStringIncludes(chips, ">#zz_picked<");
      const labels = [...chips.matchAll(/class="tag-preset">([^<]*)/g)].map((m) => m[1]);
      assertEquals(labels.indexOf("#zz_picked"), 1, `picked tag should sit right after *secret: ${labels.slice(0, 3)}`);
      await sql`delete from pref where uid = 'john_doe'`;
    });

    // A ▼ is "less of this". It has to suppress the tag on every path into the row, or the
    // chip the user just muted comes straight back through `own`.
    await t.step("a ▼ on a tag removes it from the chips it would otherwise reach", async () => {
      await sql`delete from pref where uid = 'john_doe'`;
      // john's newest root post, so `own` ranks this tag first and it clears the 12-slot cap
      // that the 25 seeded z-tags are competing for.
      await sql`insert into com (parent_cid, created_by, body, tags)
                values (null, 'john_doe', 'mute me', '{zz_muteme}')`;
      const cookie = await login("john@example.com");
      assertStringIncludes(await frontpage(cookie), ">#zz_muteme<"); // reaches the row via own
      await sql`insert into pref (uid, kind, val, vote) values ('john_doe', 'tag', 'zz_muteme', -1)`;
      assertEquals((await frontpage(cookie)).includes(">#zz_muteme<"), false, "a muted tag came back as a chip");
      await sql`delete from pref where uid = 'john_doe'`;
      await sql`delete from com where tags @> '{zz_muteme}'`;
    });

    await t.step("a ▼ on a tag also keeps it out of the discovery slice", async () => {
      await sql`delete from pref where uid = 'jane_doe'`;
      await sql`insert into com (parent_cid, created_by, body, tags) values
        (null, 'SyntaxSamurai', 'mute a', '{mutedisco}'),
        (null, 'SyntaxSamurai', 'mute b', '{mutedisco}'),
        (null, 'SyntaxSamurai', 'mute c', '{mutedisco}')`;
      await refreshStats();
      await sql`insert into pref (uid, kind, val, vote) values ('jane_doe', 'tag', 'mutedisco', -1)`;
      // disco is a weighted random sample, so one draw proves nothing — take many.
      const cookie = await login("jane@example.com");
      for (let i = 0; i < 20; i++)
        assertEquals((await frontpage(cookie)).includes(">#mutedisco<"), false, "muted tag surfaced via discovery");
      await sql`delete from pref where uid = 'jane_doe'`;
      await sql`delete from com where tags @> '{mutedisco}'`;
      await refreshStats();
    });

    await t.step("frontpage discovery samples a rotating subset of an oversized pool", async () => {
      // The seed only has 4 tags clearing `posts_count >= 3`, which is under the 8 disco
      // slots — every load would return all 4 and the sampling would be untested. Widen the
      // pool to 20 so selection genuinely has to choose.
      for (let i = 0; i < 20; i++) {
        const tg = `pool_${String(i).padStart(2, "0")}`;
        await sql`insert into com (parent_cid, created_by, body, tags) values
          (null, 'SyntaxSamurai', ${"a " + tg}, ${[tg]}),
          (null, 'SyntaxSamurai', ${"b " + tg}, ${[tg]}),
          (null, 'SyntaxSamurai', ${"c " + tg}, ${[tg]})`;
      }
      await refreshStats();
      // jane_doe has no posts, orgs or upvotes, so every chip she sees is a discovery chip.
      const cookie = await login("jane@example.com");
      const union = new Set<string>();
      for (let i = 0; i < 30; i++) {
        const chips = [...(await frontpage(cookie)).matchAll(/class="tag-preset">([^<]*)/g)].map((m) => m[1]);
        assertEquals(chips.length, 8, `discovery slice should fill its 8 slots, got ${chips.length}`);
        assertEquals(new Set(chips).size, 8, `duplicate chips in one row: ${chips}`);
        chips.forEach((ch) => union.add(ch));
      }
      assertEquals(union.size > 8, true, `discovery never rotated past one slate: ${[...union]}`);
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

// i.ding.bar is this same Deno Deploy project (the `host(c) === "i"` middleware proxies R2), and
// an isolate cannot fetch its own origin — so every in-isolate image fetch must go to R2 directly.
Deno.test("directImageUrl", async (t) => {
  const prev = Deno.env.get("R2_PUBLIC_URL");
  try {
    Deno.env.set("R2_PUBLIC_URL", "https://r2-pub.example");

    await t.step("rewrites i.ding.bar to the R2 origin", () => {
      assertEquals(
        directImageUrl("https://i.ding.bar/UUvGLX1G.png"),
        "https://r2-pub.example/i/UUvGLX1G.png",
      );
    });

    await t.step("leaves external hosts alone", () => {
      assertEquals(directImageUrl("https://i.redd.it/xyz.jpg"), "https://i.redd.it/xyz.jpg");
      assertEquals(directImageUrl("https://r2-pub.example/i/a.png"), "https://r2-pub.example/i/a.png");
    });

    await t.step("does not rewrite other ding.bar hosts", () => {
      assertEquals(directImageUrl("https://ding.bar/c/92802"), "https://ding.bar/c/92802");
      assertEquals(directImageUrl("https://r2.ding.bar/i/a.png"), "https://r2.ding.bar/i/a.png");
    });

    await t.step("passes through when R2_PUBLIC_URL is unset (standalone bot run)", () => {
      Deno.env.delete("R2_PUBLIC_URL");
      assertEquals(directImageUrl("https://i.ding.bar/UUvGLX1G.png"), "https://i.ding.bar/UUvGLX1G.png");
    });
  } finally {
    if (prev) Deno.env.set("R2_PUBLIC_URL", prev);
    else Deno.env.delete("R2_PUBLIC_URL");
  }
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
    assertEquals(out.includes(`<span class="md-syntax">[</span>`), true);
    assertEquals(out.includes(`<span class="md-syntax">](https://example.com)</span>`), true);
    assertEquals(out.includes(">site<"), true);
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

//// DHT ////////////////////////////////////////////////////////////////////////

// Committed ALICE identity + golden vectors. Ed25519 is deterministic, so these are
// frozen: server, CLI, and node MUST hash/sign byte-identically or dedup breaks.
const ALICE = {
  jwk: {
    kty: "OKP",
    crv: "Ed25519",
    d: "cbihUYW3AuCfyH0P7-sWjvsiWnspAKhLFtPxvrJtEtY",
    x: "Uaodxp4LE7S2G3jiPqqkJYgP9yRBH1u5ZSQLbv0ir4g",
    key_ops: ["sign"],
    ext: true,
  } as JsonWebKey,
  pub: "51aa1dc69e0b13b4b61b78e23eaaa425880ff724411f5bb965240b6efd22af88",
  id: "0dd317d1fef8965ff8e820e71c2f5f643795b6057ef05e2c5b8c2066f63d8022",
};
const GOLDEN_TS = 1782000000;
const GOLDEN_K = "919d0441e507957cc8934a22b6d0cabbc8704b3858d29a9b1a82150ac338fbac";
const GOLDEN_SIG =
  "d3cf25ac12ba2607ecf082273bf616218698bf2497ee9c9e3fe7972ab67a82c57e2d65ebdbbd7ee2f0122b718164740a81a0b2a87bb3eec5d56056a53201fb02";
const GOLDEN_CANON = '["msg","51aa1dc69e0b13b4b61b78e23eaaa425880ff724411f5bb965240b6efd22af88",1782000000,' +
  '{"body":"hello world https://nba.com","orgs":[],"tags":["lol","nba"],"usrs":[]}]';
// tags in mixed case/order/dupes — buildMsg must lowercase, dedupe, sort to ["lol","nba"]
const goldenPayload = () => buildMsg({ tags: ["Nba", "lol", "LOL"], body: "hello world https://nba.com" });

// The trust root configured in test_env.ts (DING_ORG_PK/SK).
const ORG = {
  jwk: {
    kty: "OKP",
    crv: "Ed25519",
    d: "NABeVHyPQWWdaQvpli3ixdKtUYox7vboFd4U83kF2fQ",
    x: "dcfETT6D78jBMqb8X_kzT8JVnHh_Zgj-w0CrJaJwIhw",
    key_ops: ["sign"],
    ext: true,
  } as JsonWebKey,
  pub: "75c7c44d3e83efc8c132a6fc5ff9334fc2559c787f6608fec340ab25a270221c",
};

const mkKey = async () => {
  const kp = await genKey();
  const pub = await pubHexOf(kp);
  return { kp, priv: kp.privateKey, pub, id: await idOf(pub) };
};

// Reset rate budgets per call so many same-IP test posts don't trip the limiter
// (the dedicated rate-limit step exercises the per-pubkey drop explicitly).
const postDb = (rows: Row[]) => {
  dbIngestRate.ip.clear();
  dbIngestRate.key.clear();
  return app.request("http://db.ding.bar/", {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: rows.map((r) => JSON.stringify(r)).join("\n"),
  });
};

// Prove an identity to the drain: sign a fresh single-use challenge nonce.
const authAs = async (kp: CryptoKeyPair, pub: string) => {
  const { nonce } = await (await app.request("http://db.ding.bar/challenge")).json();
  const sig = hex(
    new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(nonce))),
  );
  return { Authorization: `Ding ${pub} ${nonce} ${sig}` };
};

Deno.test("dht golden vectors (canon/hash/sig frozen across server+CLI+node)", async () => {
  assertEquals(await idOf(ALICE.pub), ALICE.id);
  assertEquals(canon(["msg", ALICE.pub, GOLDEN_TS, goldenPayload()]), GOLDEN_CANON);
  const row = await signRow("msg", GOLDEN_TS, goldenPayload(), await importPriv(ALICE.jwk), ALICE.pub);
  assertEquals(row.k, GOLDEN_K);
  assertEquals(row.sig, GOLDEN_SIG);
  await verifyRow(row); // throws if invalid
});

Deno.test("dht canon rejects floats and unsafe ints (strict interfaces)", () => {
  assertThrows(() => canon({ x: 1.5 }), Error, "floats forbidden");
  assertThrows(() => canon({ x: Number.MAX_SAFE_INTEGER + 1 }), Error, "unsafe integer");
});

Deno.test("WS shared-listener matchesQ mirrors the q-filter containment semantics", () => {
  const row = { kind: "msg" as const, tags: ["lol", "nba"], orgs: [], usrs: [] };
  const q = (kind: string, tags: string[] = []) => ({ kind, tags, orgs: [] as string[], usrs: [] as string[] });
  assertEquals(matchesQ(row, []), true); // no filter → fan out to all
  assertEquals(matchesQ(row, [q("msg", ["lol"])]), true); // tag subset matches
  assertEquals(matchesQ(row, [q("msg", ["lol", "nba"])]), true); // exact tag set
  assertEquals(matchesQ(row, [q("msg", ["xyz"])]), false); // tag not present
  assertEquals(matchesQ(row, [q("usr")]), false); // kind mismatch
  assertEquals(matchesQ(row, [q("peer"), q("msg", ["nba"])]), true); // any-of
});

Deno.test(
  "dht ingest + projection + adversarial",
  pgtest((sql) => async (t) => {
    await sql`insert into usr (name, email, bio, invited_by, pubkey)
      values ('alice', 'alice@x.com', 'hi, i am alice', 'john_doe', ${ALICE.pub})`;
    await sql`insert into usr (name, email, password, bio, invited_by)
      values ('carol', 'carol@x.com', 'hashed:carolpass', 'hi, i am carol', 'john_doe')`;
    const priv = await importPriv(ALICE.jwk);
    const golden = await signRow("msg", GOLDEN_TS, goldenPayload(), priv, ALICE.pub);
    await t.step("POST /db ingests a signed msg and projects into com", async () => {
      const res = await postDb([golden]);
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: 1, bad: 0, errors: [] });
      const [d] = await sql`select kind, pubkey from dht where k = ${GOLDEN_K}`;
      assertEquals(d.kind, "msg");
      const [com] = await sql`select created_by, author_id, hash, body, tags from com where hash = ${GOLDEN_K}`;
      assertEquals(com.created_by, "alice"); // pubkey -> local name
      assertEquals(com.author_id, ALICE.id);
      assertEquals(com.tags, ["lol", "nba"]);
    });

    await t.step("GET /c?tag=lol renders the projected post for an anonymous viewer", async () => {
      const res = await app.request("http://api.ding.bar/c?tag=lol");
      const items = await res.json();
      assertEquals(items[0].body, "hello world https://nba.com");
      assertEquals(items[0].created_by, "alice");
      assertEquals(items[0].author_id, ALICE.id);
    });

    await t.step("GET /db drains the row verbatim as NDJSON", async () => {
      const res = await app.request("http://db.ding.bar/?q=" + encodeURIComponent("$msg #lol"));
      const lines = (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assertEquals(lines.length, 1);
      assertEquals(lines[0].k, GOLDEN_K);
      assertEquals(lines[0].sig, GOLDEN_SIG);
      assertEquals(lines[0].body, "hello world https://nba.com");
    });

    await t.step("replay is a no-op (dedup by content hash; counts not doubled)", async () => {
      assertEquals((await (await postDb([golden])).json()).ok, 1);
      const [{ count }] = await sql`select count(*)::int as count from com where hash = ${GOLDEN_K}`;
      assertEquals(count, 1);
    });

    await t.step("forged signature is dropped", async () => {
      const forged = { ...golden, sig: golden.sig.slice(0, -2) + "00" } as Row;
      const body = await (await postDb([forged])).json();
      assertEquals(body.ok, 0);
      assertStringIncludes(body.errors[0], "bad signature");
    });

    await t.step("tampered body (content-hash mismatch) is dropped", async () => {
      const tampered = { ...golden, body: "tampered" } as Row;
      const body = await (await postDb([tampered])).json();
      assertEquals(body.ok, 0);
      assertStringIncludes(body.errors[0], "content-hash mismatch");
    });

    await t.step("far-future ts is dropped on skew (no com row created)", async () => {
      const future = await signRow(
        "msg",
        nowSec() + 99 * 365 * 86400,
        buildMsg({ tags: ["future"], body: "from the year 9999" }),
        priv,
        ALICE.pub,
      );
      const body = await (await postDb([future])).json();
      assertEquals(body.ok, 0);
      assertStringIncludes(body.errors[0], "future");
      const [{ count }] = await sql`select count(*)::int as count from com where body = 'from the year 9999'`;
      assertEquals(count, 0);
    });

    await t.step("custodial web post signs into the dht log (com.hash + dht row)", async () => {
      const f = new FormData();
      f.set("body", "custodial hello");
      f.set("tags", "#cust");
      const res = await app.request("/c", {
        method: "POST",
        body: f,
        headers: basic("carol@x.com", "carolpass"),
      });
      assertEquals(res.status, 302);
      const cid = res.headers.get("location")!.match(/\/c\/(\d+)/)![1];
      const [com] = await sql`select hash, author_id, created_by from com where cid = ${cid}`;
      assertExists(com.hash);
      assertEquals(com.created_by, "carol");
      const [d] = await sql`select k from dht where k = ${com.hash}`;
      assertExists(d);
    });

    await t.step("private @user DM stays OFF the public log (unsigned com, no dht row)", async () => {
      const f = new FormData();
      f.set("body", "a private note for john");
      f.set("tags", "@john_doe"); // DM recipient => private
      const res = await app.request("/c", {
        method: "POST",
        body: f,
        headers: basic("carol@x.com", "carolpass"),
      });
      assertEquals(res.status, 302);
      const cid = res.headers.get("location")!.match(/\/c\/(\d+)/)![1];
      const [com] = await sql`select hash, usrs from com where cid = ${cid}`;
      assertEquals(com.usrs, ["john_doe"]);
      assertEquals(com.hash, null); // never signed
      const [{ count }] =
        await sql`select count(*)::int as count from dht where val->>'body' = 'a private note for john'`;
      assertEquals(count, 0); // body never entered the log
    });

    await t.step("/db ingest refuses a *org msg whose org is a name, not an id", async () => {
      const org = await signRow(
        "msg",
        nowSec(),
        { tags: [], orgs: ["secret"], usrs: [], body: "an org post trying to sneak in" },
        priv,
        ALICE.pub,
      );
      const body = await (await postDb([org])).json();
      assertEquals(body.ok, 0);
      assertStringIncludes(body.errors[0], "64-hex ids");
      const [{ count }] = await sql`select count(*)::int as count from dht where k = ${org.k}`;
      assertEquals(count, 0);
    });

    await t.step("3 distinct flaggers suppress a post; one flagger ×3 does not", async () => {
      const flag = async (f: { priv: CryptoKey; pub: string }, dt = 0) =>
        postDb([await signRow("flag", nowSec() + dt, { target: GOLDEN_K }, f.priv, f.pub)]);
      const [a, b, cc] = await Promise.all([mkKey(), mkKey(), mkKey()]);

      // one flagger flags 3× (distinct rows by ts) → still ONE distinct flagger
      await flag(a, 0), await flag(a, 1), await flag(a, 2);
      assertEquals((await sql`select c_flags from com where hash = ${GOLDEN_K}`)[0].c_flags, 1);

      // two more distinct flaggers → 3 total → suppressed + dht target flagged
      await flag(b), await flag(cc);
      assertEquals((await sql`select c_flags from com where hash = ${GOLDEN_K}`)[0].c_flags, 3);
      assertEquals((await sql`select flagged from dht where k = ${GOLDEN_K}`)[0].flagged, true);
    });

    await t.step("only a valid, unexpired trust-root mark renders a ✓", async () => {
      const orgPriv = await importPriv(ORG.jwk);
      const now = nowSec();
      const checked = async () => (await (await app.request("http://api.ding.bar/c?tag=lol")).json())[0].checked;
      const orgMark = async (exp: number) =>
        postDb([await signRow("mark", now, buildMark(ALICE.id, "email", exp), orgPriv, ORG.pub)]);

      assertEquals(await checked(), false); // no mark yet
      // a mark from a NON-root key is ignored
      const stranger = await mkKey();
      await postDb([await signRow("mark", now, buildMark(ALICE.id, "email", now + YEAR), stranger.priv, stranger.pub)]);
      assertEquals(await checked(), false);
      // an EXPIRED trust-root mark is ignored
      await orgMark(now - 1);
      assertEquals(await checked(), false);
      // a valid, unexpired trust-root mark → ✓
      await orgMark(now + 100 * YEAR);
      assertEquals(await checked(), true);
    });

    await t.step("a verified handle renders a gray ✓ BEFORE the @name in HTML", async () => {
      verified.names = new Set(["jane_doe"]); // inject the cache; fresh `at` so the middleware skips re-query
      verified.at = Date.now();
      const html = await (await app.request("http://ding.bar/u/jane_doe")).text();
      const ci = html.indexOf('class="check"'), hi = html.indexOf("@jane_doe");
      assertEquals(ci !== -1 && ci < hi, true); // present AND before the handle
      verified.names = new Set(); // unverified → no ✓
      verified.at = Date.now();
      assertEquals((await (await app.request("http://ding.bar/u/jane_doe")).text()).includes('class="check"'), false);
      verified.at = 0; // restore normal refresh for later steps
    });

    await t.step("a flag that arrives before its target msg still suppresses (out-of-order)", async () => {
      const author = await mkKey();
      const post = await signRow(
        "msg",
        nowSec(),
        buildMsg({ tags: ["ooo"], body: "early-flagged" }),
        author.priv,
        author.pub,
      );
      // 3 distinct flags land FIRST, before the post is ingested
      for (let i = 0; i < 3; i++) {
        const f = await mkKey();
        await postDb([await signRow("flag", nowSec() + i, { target: post.k }, f.priv, f.pub)]);
      }
      assertEquals((await sql`select count(*)::int as n from com where hash = ${post.k}`)[0].n, 0); // not projected yet
      await postDb([post]); // now the msg arrives
      const [com] = await sql`select c_flags from com where hash = ${post.k}`;
      assertEquals(com.c_flags, 3); // backfilled from the pre-existing flags
      assertEquals((await sql`select flagged from dht where k = ${post.k}`)[0].flagged, true);
    });

    await t.step("the public $mark drain never exposes email addresses", async () => {
      const orgPriv = await importPriv(ORG.jwk);
      await postDb([
        await signRow("mark", nowSec(), buildMark(ALICE.id, "email", 9999999999), orgPriv, ORG.pub),
      ]);
      const drained = await (await app.request("http://db.ding.bar/?q=$mark")).text();
      assertEquals(drained.includes("@"), false); // no address anywhere in the served marks
    });

    await t.step("POST /db rate-limits per pubkey (drops rows over the budget)", async () => {
      dbIngestRate.key.clear();
      const saved = dbIngestRate.rowsPerKeyPerMin;
      dbIngestRate.rowsPerKeyPerMin = 2;
      try {
        const { priv, pub } = await mkKey();
        const now = nowSec();
        const rows = await Promise.all(
          [0, 1, 2].map((i) => signRow("msg", now + i, buildMsg({ tags: ["rl"], body: `rl ${i}` }), priv, pub)),
        );
        const res = await (await postDb(rows)).json(); // 3 rows, budget 2
        assertEquals(res.ok, 2);
        assertEquals(res.bad, 1);
        assertStringIncludes(res.errors[0], "rate limit");
      } finally {
        dbIngestRate.rowsPerKeyPerMin = saved;
      }
    });

    await t.step("/db refuses a mark with a non-integer exp (feed-cast safety)", async () => {
      const { priv, pub } = await mkKey();
      const bad = await signRow(
        "mark",
        nowSec(),
        { subject: "a".repeat(64), mark: { v: "email", exp: "soon" } },
        priv,
        pub,
      );
      const res = await (await postDb([bad])).json();
      assertEquals(res.ok, 0);
      assertStringIncludes(res.errors[0], "mark needs");
    });

    await t.step("a usr register (name/bio/links) is stored and drainable", async () => {
      const { priv, pub } = await mkKey();
      const reg = await signRow(
        "usr",
        nowSec(),
        { name: "taylor_town", bio: "hi", links: ["taylor.town", "github.com/surprisetalk"] },
        priv,
        pub,
      );
      assertEquals((await (await postDb([reg])).json()).ok, 1);
      const [d] = await sql`select kind, val from dht where k = ${reg.k}`;
      assertEquals(d.kind, "usr");
      assertEquals(d.val.name, "taylor_town");
      assertEquals(d.val.links, ["taylor.town", "github.com/surprisetalk"]);
    });

    await t.step("GET /db sets a resumable seq cursor and ?after= never re-fetches", async () => {
      const r1 = await app.request("http://db.ding.bar/?q=$msg");
      const cur = r1.headers.get("x-ding-cursor") ?? "";
      assertEquals(/^\d+$/.test(cur), true); // a dht seq
      // draining again from that cursor yields nothing — advances, never loops/re-fetches
      const r2 = await app.request(`http://db.ding.bar/?q=$msg&after=${cur}`);
      assertEquals((await r2.text()).trim(), "");
      assertEquals(r2.headers.get("x-ding-cursor"), null); // no rows → cursor unchanged
    });

    await t.step("replicate() pulls a bootstrap's rows and advances the cursor", async () => {
      const { priv, pub } = await mkKey();
      const row = await signRow(
        "msg",
        nowSec(),
        buildMsg({ tags: ["repl"], body: "replicated post, no links" }),
        priv,
        pub,
      );
      const orig = globalThis.fetch;
      let calledUrl = "";
      try {
        // a stand-in bootstrap drain: one row + a seq cursor header
        globalThis.fetch = ((u: string) => {
          calledUrl = u;
          return Promise.resolve(
            new Response(JSON.stringify(row), { status: 200, headers: { "x-ding-cursor": "42" } }),
          );
        }) as unknown as typeof fetch;
        const next = await replicate("http://boot.example", ["$msg #repl"], "0");
        assertEquals(next, "42"); // cursor advanced from the header
        assertStringIncludes(calledUrl, "after=0"); // resumes via the seq cursor
      } finally {
        globalThis.fetch = orig;
      }
      // the pulled row was verified, stored, and projected locally
      assertEquals((await sql`select kind from dht where k = ${row.k}`)[0].kind, "msg");
      assertEquals((await sql`select body from com where hash = ${row.k}`)[0].body, "replicated post, no links");
    });

    await t.step("a private @user DM is auth-gated: only the recipient can drain it", async () => {
      // dave is the recipient (custodial key + id); a sender DMs dave by id
      const dave = await mkKey();
      await sql`insert into usr (name, email, bio, invited_by, pubkey, id)
        values ('dave', 'dave@x.com', 'hi', 'john_doe', ${dave.pub}, ${dave.id})`;
      const sender = await mkKey();
      const dm = await signRow(
        "msg",
        nowSec(),
        buildMsg({ usrs: [dave.id], body: "secret for dave" }),
        sender.priv,
        sender.pub,
      );
      assertEquals((await (await postDb([dm])).json()).ok, 1);
      // dht keeps the id-scoped recipient; com projects it to dave's name
      assertEquals((await sql`select usrs from dht where k = ${dm.k}`)[0].usrs, [dave.id]);
      assertEquals((await sql`select usrs from com where hash = ${dm.k}`)[0].usrs, ["dave"]);

      const drainHas = async (headers: Record<string, string> = {}) =>
        (await (await app.request("http://db.ding.bar/?q=$msg", { headers })).text()).includes(dm.k);

      assertEquals(await drainHas(), false); // UNAUTHENTICATED: must NOT see the DM
      assertEquals(await drainHas(await authAs(dave.kp, dave.pub)), true); // the recipient sees it
      const stranger = await mkKey();
      assertEquals(await drainHas(await authAs(stranger.kp, stranger.pub)), false); // a third party does not
      // forge by FLIPPING the sig's last byte (always differs — appending a fixed "00"
      // collides with a real sig ending in 00 about 1 run in 256 and flaked)
      const bad = (await authAs(dave.kp, dave.pub)).Authorization;
      const flipped = (parseInt(bad.slice(-2), 16) ^ 0xff).toString(16).padStart(2, "0");
      assertEquals(await drainHas({ Authorization: bad.slice(0, -2) + flipped }), false); // forged sig → no access
    });

    await t.step("a DM to a NON-local recipient never renders publicly in the web feed", async () => {
      const remoteId = "f".repeat(64); // an id with no local usr row
      const sender = await mkKey();
      const dm = await signRow(
        "msg",
        nowSec(),
        buildMsg({ usrs: [remoteId], body: "offsite secret message" }),
        sender.priv,
        sender.pub,
      );
      assertEquals((await (await postDb([dm])).json()).ok, 1);
      // com.usrs falls back to the raw id (non-empty) → never the public '{}' branch
      assertEquals((await sql`select usrs from com where hash = ${dm.k}`)[0].usrs, [remoteId]);
      // anonymous viewers must NOT see it in the search feed or the homepage
      const feed = await (await app.request("http://api.ding.bar/c?q=offsite")).json();
      assertEquals(feed.some((p: { body: string }) => p.body === "offsite secret message"), false);
      assertEquals((await (await app.request("/")).text()).includes("offsite secret message"), false);
    });

    await t.step("/db refuses a private msg whose @recipient is a name, not an id", async () => {
      const { priv, pub } = await mkKey();
      const bad = await signRow(
        "msg",
        nowSec(),
        buildMsg({ usrs: ["dave"], body: "name-scoped, not allowed" }),
        priv,
        pub,
      );
      const res = await (await postDb([bad])).json();
      assertEquals(res.ok, 0);
      assertStringIncludes(res.errors[0], "64-hex ids");
    });

    await t.step("peer rows ingest, drain via $peer, and discoverPeers parses them", async () => {
      const { priv, pub } = await mkKey();
      const peer = await signRow("peer", nowSec(), { ips: ["https://node-b.example"], serves: ["$msg"] }, priv, pub);
      assertEquals((await (await postDb([peer])).json()).ok, 1);
      assertEquals((await sql`select kind from dht where k = ${peer.k}`)[0].kind, "peer");
      // discoverPeers reads them from a node's $peer drain
      const orig = globalThis.fetch;
      try {
        globalThis.fetch = (() =>
          Promise.resolve(new Response(JSON.stringify(peer), { status: 200 }))) as unknown as typeof fetch;
        const peers = await discoverPeers("http://boot.example");
        assertEquals(peers, [{ ips: ["https://node-b.example"], serves: ["$msg"] }]);
      } finally {
        globalThis.fetch = orig;
      }
    });

    await t.step("publishPeer signs and POSTs a verifiable peer row", async () => {
      const { priv, pub } = await mkKey();
      const orig = globalThis.fetch;
      let posted = "";
      try {
        globalThis.fetch = ((_u: string, init: { body: string }) => {
          posted = init.body;
          return Promise.resolve(new Response("{}", { status: 200 }));
        }) as unknown as typeof fetch;
        await publishPeer("http://boot.example", ["https://me.example"], ["$msg"], priv, pub);
      } finally {
        globalThis.fetch = orig;
      }
      // the posted row, fed back through /db ingest, verifies and stores
      assertEquals((await (await postDb([JSON.parse(posted)])).json()).ok, 1);
      assertEquals(JSON.parse(posted).ips, ["https://me.example"]);
    });

    await t.step("a *org msg is auth-gated by the org's signed member lease", async () => {
      const org = await mkKey(), member = await mkKey();
      await postDb([
        await signRow("org", nowSec(), { name: "nba", bio: "", links: [], members: [member.id] }, org.priv, org.pub),
      ]);
      assertEquals((await sql`select members from dht where pubkey = ${org.pub} and kind = 'org'`)[0].members, [
        member.id,
      ]);
      const sender = await mkKey();
      const post = await signRow(
        "msg",
        nowSec(),
        buildMsg({ orgs: [org.id], body: "team-only secret" }),
        sender.priv,
        sender.pub,
      );
      assertEquals((await (await postDb([post])).json()).ok, 1);
      assertEquals((await sql`select orgs from dht where k = ${post.k}`)[0].orgs, [org.id]);
      assertEquals((await sql`select count(*)::int as n from com where hash = ${post.k}`)[0].n, 0); // dht-only

      const drainHas = async (headers: Record<string, string> = {}) =>
        (await (await app.request("http://db.ding.bar/?q=$msg", { headers })).text()).includes(post.k);
      assertEquals(await drainHas(), false); // unauthenticated → no org content
      assertEquals(await drainHas(await authAs(member.kp, member.pub)), true); // a member sees it
      const outsider = await mkKey();
      assertEquals(await drainHas(await authAs(outsider.kp, outsider.pub)), false); // a non-member does not
    });

    await t.step("resolveName ranks contested @names by trust-root marks, then first-seen", async () => {
      const now = nowSec();
      const a = await mkKey(), b = await mkKey();
      await postDb([await signRow("usr", now, { name: "gwern", bio: "", links: [] }, a.priv, a.pub)]);
      await postDb([await signRow("usr", now + 1, { name: "gwern", bio: "", links: [] }, b.priv, b.pub)]);
      assertEquals(await resolveName("gwern"), a.id); // no marks → first-seen wins
      assertEquals(await resolveName("nobody-has-this-name"), null);
      // a trust-root mark on b flips the ranking
      const orgPriv = await importPriv(ORG.jwk);
      await postDb([await signRow("mark", now, buildMark(b.id, "email", now + YEAR), orgPriv, ORG.pub)]);
      assertEquals(await resolveName("gwern"), b.id);
    });
  }),
);

const YEAR = 365 * 86400;

Deno.test(
  "history backfill",
  pgtest((sql) => async (t) => {
    await t.step("signs legacy public posts into the dht; resumable + idempotent", async () => {
      const [{ n: pending }] =
        await sql`select count(*)::int as n from com where hash is null and char_length(body) > 1 and orgs = '{}' and usrs = '{}'`;
      assertEquals(pending > 0, true); // the seed has public posts to sign

      const { signed } = await backfill(sql, { concurrency: 1 }); // PGlite is single-connection
      assertEquals(signed > 0, true);

      // a backfilled post now carries the signed columns + a matching dht msg row
      const [c] =
        await sql`select hash, author_id, t from com where hash is not null and char_length(body) > 1 limit 1`;
      assertExists(c.hash);
      assertExists(c.author_id);
      assertExists(c.t);
      const [d] = await sql`select kind, pubkey from dht where k = ${c.hash}`;
      assertEquals(d.kind, "msg");
      assertEquals(c.author_id, await idOf(d.pubkey)); // author_id == sha256(author pubkey)

      // resumable / idempotent: re-running signs nothing new
      const { signed: again } = await backfill(sql, { concurrency: 1 });
      assertEquals(again, 0);
    });
  }),
);

// The bot fleet's cron path never touches the network: helpers dispatch through app.request.
// This pins that seam — Basic Auth, form POST, and JSON GET all have to work in-process,
// because a Deno Deploy isolate cannot fetch its own origin.
Deno.test(
  "bot fleet in-process transport (app.request)",
  pgtest(() => async (t) => {
    const api: Api = {
      apiUrl: "",
      auth: btoa("john@example.com:password1!"),
      botUsername: "john_doe",
      fetch: (input, init) => botFetch(input, init),
    };

    await t.step("post() writes through app.request with Basic Auth", async () => {
      assertEquals(await post(api, "transport check https://example.com/xyz", "#bot"), true);
    });

    await t.step("getPostedUrls() reads the same row back", async () => {
      assertEquals((await getPostedUrls(api)).has("https://example.com/xyz"), true);
    });

    await t.step("bad credentials cannot post", async () => {
      const bad = { ...api, auth: btoa("john@example.com:wrong!") };
      assertEquals(await post(bad, "should never land https://example.com/nope", "#bot"), false);
      assertEquals((await getPostedUrls(api)).has("https://example.com/nope"), false);
    });

    // The mocked bots.test.ts harness can't see this: only the real `/c` knows that
    // `comments=1` selects `parent_cid is not null` — comments INSTEAD OF roots. A
    // single-query unansweredMentions silently answers one kind and drops the other.
    await t.step("unansweredMentions sees BOTH a root mention and a reply mention", async () => {
      const botApi = { ...api, botUsername: "jane_doe" };
      const rootBody = new FormData();
      rootBody.append("body", "summoning the bot from a brand new post");
      rootBody.append("tags", "@jane_doe #bots");
      const rootRes = await app.request("/c", {
        method: "POST",
        body: rootBody,
        headers: basic("john@example.com", "password1!"),
      });
      const rootCid = Number(new URL(rootRes.headers.get("location")!, "http://x").pathname.split("/")[2]);

      const replyBody = new FormData();
      replyBody.append("body", "and again from a reply @jane_doe");
      await app.request(`/c/${rootCid}`, {
        method: "POST",
        body: replyBody,
        headers: basic("john@example.com", "password1!"),
      });

      const seen = await unansweredMentions(botApi);
      const bodies = seen.map((p) => p.body);
      assertEquals(bodies.some((b) => b.includes("brand new post")), true, `root mention dropped: ${bodies}`);
      assertEquals(bodies.some((b) => b.includes("from a reply")), true, `reply mention dropped: ${bodies}`);
    });
  }),
);

//// ACCOUNT HUB TESTS ////////////////////////////////////////////////////////

Deno.test(
  "account hub (/u)",
  pgtest((sql) => async (t) => {
    const loginBody = new FormData();
    loginBody.append("email", "john@example.com");
    loginBody.append("password", "password1!");
    const boot = await app.request("/login", { method: "POST", body: loginBody });
    const cookie = boot.headers.get("set-cookie")!.split(";")[0];

    await t.step("owner hub shows logout, invite form, orgs, self-custody status", async () => {
      const res = await app.request("/u", { headers: { cookie } });
      assertEquals(res.status, 200);
      const html = await res.text();
      assertEquals(html.includes(`action="/logout"`), true);
      assertEquals(html.includes(`action="/invite"`), true);
      assertEquals(html.includes(`href="/o/secret"`), true);
      assertEquals(html.includes(">account</h2>"), true);
      assertEquals(html.includes("self-custody key"), true); // john_doe has null seckey_enc
      assertEquals(html.includes(`href="/key"`), false);
      assertEquals(html.includes("1 of 4 used"), true); // jane_doe is seeded as john's invitee
      assertEquals(html.includes(`href="/u/jane_doe"`), true);
    });

    // The hub folds prefs, mutuals and both counts into one query via `counts left join mine
    // on true`. With no prefs of your own that join is the only thing keeping a row — and so
    // the only thing keeping a follower count that isn't yours to zero out.
    await t.step("hub counts survive a user with followers but no prefs of their own", async () => {
      await sql`delete from pref`;
      await sql`insert into pref (uid, kind, val, vote) values ('jane_doe', 'usr', 'john_doe', 1)`;
      const html = await (await app.request("/u", { headers: { cookie } })).text();
      assertStringIncludes(html, "1 follower");
      assertStringIncludes(html, "0 following");
      assertStringIncludes(html, "no prefs yet");
      assertStringIncludes(html, "no mutuals yet");
      await sql`delete from pref`;
    });

    await t.step("custodial user sees key download and delete confirm", async () => {
      await sql`update usr set seckey_enc = ${new Uint8Array([0])} where name = 'john_doe'`;
      const res = await app.request("/u", { headers: { cookie } });
      const html = await res.text();
      assertEquals(html.includes(`href="/key"`), true);
      assertEquals(html.includes(`action="/key/delete"`), true);
      assertEquals(html.includes("<summary>"), true);
    });

    await t.step("public profile hides account controls; JSON shape unchanged", async () => {
      const res = await app.request("/u/john_doe");
      const html = await res.text();
      assertEquals(html.includes("@john_doe"), true);
      assertEquals(html.includes(`href="/c?usr=john_doe"`), true);
      assertEquals(html.includes(`action="/logout"`), false);
      assertEquals(html.includes(`action="/invite"`), false);
      assertEquals(html.includes(`href="/key"`), false);
      const jres = await app.request("http://api.ding.bar/u/john_doe");
      const j = await jres.json();
      assertEquals(j.name, "john_doe");
      assertEquals("pubkey" in j, false);
      assertEquals("custodial" in j, false);
      assertEquals("seckey_enc" in j, false);
    });

    await t.step("owner sees a pointer from public profile back to /u", async () => {
      const res = await app.request("/u/john_doe", { headers: { cookie } });
      const html = await res.text();
      assertEquals(html.includes("your public profile"), true);
    });

    await t.step("POST /invite creates invitee, sends email, hub lists it as pending", async () => {
      const fd = new FormData();
      fd.append("email", "friend@example.com");
      const res = await app.request("/invite", { method: "POST", body: fd, headers: { cookie } });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/u");
      assertEquals(sentEmails.at(-1)?.to, "friend@example.com");
      const hub = await app.request("/u", { headers: { cookie } });
      const html = await hub.text();
      assertEquals(html.includes("2 of 4 used"), true);
      assertEquals(html.includes("(pending)"), true);
    });

    await t.step("POST /invite duplicate email surfaces an error banner, not silent success", async () => {
      const fd = new FormData();
      fd.append("email", "jane@example.com"); // already registered
      const res = await app.request("/invite", { method: "POST", body: fd, headers: { cookie } });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/u?error=already_invited");
      const hub = await app.request("/u?error=already_invited", { headers: { cookie } });
      assertEquals((await hub.text()).includes("already has an account"), true);
    });
  }),
);

//// EMBED TESTS //////////////////////////////////////////////////////////////

Deno.test(
  "embed widget (/embed)",
  pgtest((sql) => async (t) => {
    // Direct inserts (not POST /c) so resolveThumbnail never fetches the URL.
    const [{ cid }] = await sql`
      insert into com (created_by, body, tags, domains)
      values ('john_doe', 'great read https://example.com/article discuss', '{reading}', '{example.com}')
      returning cid`;
    await sql`insert into com (parent_cid, created_by, body) values (${cid}, 'jane_doe', 'i agree completely')`;
    await sql`
      insert into com (parent_cid, created_by, body, orgs) values (${cid}, 'BugHunter42', 'org-only aside', '{secret}')`;
    await sql`
      insert into com (parent_cid, created_by, body, usrs) values (${cid}, 'john_doe', 'psst a dm aside', '{jane_doe}')`;
    await sql`
      insert into com (created_by, body, tags, orgs, domains)
      values ('john_doe', 'secret scoop about https://example.com/article', '{reading}', '{secret}', '{example.com}')`;

    await t.step("renders matching public post, its comments, and click-through", async () => {
      const res = await app.request("/embed?url=https://example.com/article");
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-security-policy"), "frame-ancestors *");
      assertEquals(res.headers.get("x-robots-tag"), "noindex");
      const html = await res.text();
      assertEquals(html.includes("great read"), true);
      assertEquals(html.includes("i agree completely"), true);
      assertEquals(html.includes(`https://ding.bar/c/${cid}`), true);
      assertEquals(html.includes("secret scoop"), false); // org-scoped post never leaks
      assertEquals(html.includes("org-only aside"), false); // org child under a public root never leaks
      assertEquals(html.includes("psst a dm aside"), false); // DM child under a public root never leaks
      assertEquals(html.includes(`class="brand"`), false); // no site layout inside the iframe
    });

    await t.step("missing or invalid ?url= → 400 with the iframe snippet", async () => {
      for (const path of ["/embed", "/embed?url=notaurl"]) {
        const res = await app.request(path);
        assertEquals(res.status, 400);
        assertEquals((await res.text()).includes("&lt;iframe"), true);
      }
    });

    await t.step("no matches → empty state linking prefilled compose", async () => {
      const res = await app.request("/embed?url=https://nomatch.example/x");
      assertEquals(res.status, 200);
      const html = await res.text();
      assertEquals(html.includes("no discussion yet"), true);
      assertEquals(html.includes("https://ding.bar/?www=nomatch.example&body=https%3A%2F%2Fnomatch.example%2Fx"), true);
    });
  }),
);

Deno.test(
  "thread children respect the visibility ACL",
  pgtest((sql) => async (t) => {
    await sql`insert into com (parent_cid, created_by, body, usrs) values (301, 'john_doe', 'dm aside for jane', '{jane_doe}')`;
    await sql`insert into com (parent_cid, created_by, body, orgs) values (301, 'BugHunter42', 'secret org aside', '{secret}')`;

    await t.step("stranger sees neither DM nor org children under a public root", async () => {
      const html = await (await app.request("/c/301")).text();
      assertEquals(html.includes("dm aside for jane"), false);
      assertEquals(html.includes("secret org aside"), false);
    });

    await t.step("DM recipient and org member see their own", async () => {
      const login = (email: string) => {
        const fd = new FormData();
        fd.append("email", email);
        fd.append("password", "password1!");
        return app.request("/login", { method: "POST", body: fd });
      };
      const jane = (await login("jane@example.com")).headers.get("set-cookie")!.split(";")[0];
      const janeHtml = await (await app.request("/c/301", { headers: { cookie: jane } })).text();
      assertEquals(janeHtml.includes("dm aside for jane"), true);
      assertEquals(janeHtml.includes("secret org aside"), false); // jane has no orgs
      const john = (await login("john@example.com")).headers.get("set-cookie")!.split(";")[0];
      const johnHtml = await (await app.request("/c/301", { headers: { cookie: john } })).text();
      assertEquals(johnHtml.includes("secret org aside"), true); // orgs_r = {secret}
    });

    await t.step("GET /?body= prefills the compose textarea", async () => {
      const fd = new FormData();
      fd.append("email", "john@example.com");
      fd.append("password", "password1!");
      const cookie = (await app.request("/login", { method: "POST", body: fd })).headers.get("set-cookie")!.split(
        ";",
      )[0];
      const html = await (await app.request("/?body=https%3A%2F%2Fnomatch.example%2Fx", { headers: { cookie } }))
        .text();
      assertEquals(html.includes("https://nomatch.example/x"), true);
    });
  }),
);

//// VIDEO TESTS //////////////////////////////////////////////////////////////

Deno.test("formatBody video urls", async (t) => {
  await t.step("bare .mp4 url renders muted looping video plus anchor", () => {
    const out = render("watch https://x.com/clip.mp4 now");
    assertEquals(out.includes("<video"), true);
    assertEquals(out.includes(`src="https://x.com/clip.mp4"`), true);
    assertEquals(out.includes(`class="pre-img"`), true);
    for (const attr of ["muted", "loop", "autoplay", "playsinline", `preload="metadata"`])
      assertEquals(out.includes(attr), true, `missing ${attr}: ${out}`);
    assertEquals(out.includes(`<a href="https://x.com/clip.mp4">`), true);
  });

  await t.step(".webm renders video", () => {
    assertEquals(render("https://x.com/clip.webm").includes("<video"), true);
  });

  await t.step("markdown link to video renders video plus visible link", () => {
    const out = render("[clip](https://x.com/clip.mp4)");
    assertEquals(out.includes("<video"), true);
    assertEquals(out.includes(">clip<"), true);
  });

  await t.step("trailing punctuation is trimmed before matching", () => {
    const out = render("see https://x.com/clip.mp4.");
    assertEquals(out.includes(`src="https://x.com/clip.mp4"`), true);
  });

  await t.step("non-video suffix does not render video", () => {
    assertEquals(render("https://x.com/clip.mp4x").includes("<video"), false);
    assertEquals(render("https://x.com/page").includes("<video"), false);
  });
});

Deno.test(
  "uploads video",
  pgtest((_sql) => async (t) => {
    const jAuth = basic("john@example.com", "password1!");
    type Call = { filename: string; contentType: string };
    const calls: Call[] = [];
    const original = r2.uploadToR2;
    r2.uploadToR2 = (_data, filename, contentType) => {
      calls.push({ filename, contentType });
      return Promise.resolve(`mock://i/${filename}`);
    };
    try {
      await t.step("POST /i happy path mp4", async () => {
        const fd = new FormData();
        fd.append("id", "abc12345.mp4");
        fd.append("file", new Blob([new Uint8Array([1, 2])], { type: "video/mp4" }), "clip.mp4");
        const res = await app.request("/i", { method: "POST", body: fd, headers: jAuth });
        assertEquals(res.status, 204);
        assertEquals(calls[0], { filename: "abc12345.mp4", contentType: "video/mp4" });
      });

      await t.step("POST /i webm content type", async () => {
        const fd = new FormData();
        fd.append("id", "Zz1234Aa.webm");
        fd.append("file", new Blob([new Uint8Array([3])], { type: "video/webm" }), "clip.webm");
        const res = await app.request("/i", { method: "POST", body: fd, headers: jAuth });
        assertEquals(res.status, 204);
        assertEquals(calls[1].contentType, "video/webm");
      });

      await t.step("POST /i still rejects unknown extensions", async () => {
        const fd = new FormData();
        fd.append("id", "abc12345.mov");
        fd.append("file", new Blob([new Uint8Array([1])], { type: "video/quicktime" }), "clip.mov");
        const res = await app.request("/i", { method: "POST", body: fd, headers: jAuth });
        assertEquals(res.status, 400);
      });
    } finally {
      r2.uploadToR2 = original;
    }
  }),
);

//// SUMMONER LOOP ////////////////////////////////////////////////////////////

// Reproduces the reported bug: bot_summoner leaves a bare "@bot_cowsay" comment on a
// fresh post, and the summoned bot must answer it. Runs the REAL cowsay bot function
// against the real /c semantics — only the transport is in-process.
Deno.test(
  "summoner loop: a bare @bot mention comment gets answered",
  pgtest((sql) => async (t) => {
    await sql`insert into usr (name, email, password, bio, email_verified_at, invited_by) values
      ('bot_summoner', 'bot-summoner@ding.bar', 'hashed:sumpw!', 'beep', now(), 'john_doe'),
      ('bot_cowsay', 'bot-cowsay@ding.bar', 'hashed:cowpw!', 'moo', now(), 'john_doe')`;

    const rootBody = new FormData();
    rootBody.append("body", "please draw me a cow, internet");
    rootBody.append("tags", "#bots");
    const rootRes = await app.request("/c", {
      method: "POST",
      body: rootBody,
      headers: basic("john@example.com", "password1!"),
    });
    const rootCid = Number(new URL(rootRes.headers.get("location")!, "http://x").pathname.split("/")[2]);

    const sumApi: Api = {
      apiUrl: "",
      auth: btoa("bot-summoner@ding.bar:sumpw!"),
      botUsername: "bot_summoner",
      fetch: (i, n) => botFetch(i, n),
    };
    const cowApi: Api = {
      apiUrl: "",
      auth: btoa("bot-cowsay@ding.bar:cowpw!"),
      botUsername: "bot_cowsay",
      fetch: (i, n) => botFetch(i, n),
    };

    await t.step("summon comment lands and carries the mention", async () => {
      assertEquals(await reply(sumApi, rootCid, "@bot_cowsay"), true);
      const [row] = await sql`select mentions from com where created_by = 'bot_summoner'`;
      assertEquals(row.mentions, ["bot_cowsay"]);
    });

    await t.step("cowsay answers the summon with the parent's text", async () => {
      await cowsayBot(cowApi);
      const replies = await sql`select body from com where created_by = 'bot_cowsay'`;
      assertEquals(replies.length, 1, "cowsay did not answer the summon");
      assertEquals(replies[0].body.includes("please draw me a"), true, replies[0].body);
    });
  }),
);

// summoner's 2h self-throttle: its gap probe must read the NEWEST own comment. Without
// sort=new the probe gets the default hot sort — an old-but-hot comment reads as "last
// post 3h ago" every tick, and summoner summons every 5 minutes instead of every 2 hours
// (observed in prod: ~400 summons in 3 days).
Deno.test(
  "summoner throttles on its newest comment, not its hottest",
  pgtest((sql) => async (t) => {
    await sql`insert into usr (name, email, password, bio, email_verified_at, invited_by) values
      ('bot_summoner', 'bot-summoner@ding.bar', 'hashed:sumpw!', 'beep', now(), 'john_doe')`;
    // old-but-hot comment (score = now) vs fresh-but-cold comment (score = 2 days ago)
    await sql`insert into com (parent_cid, created_by, body, created_at, score)
      values (301, 'bot_summoner', '@bot_cowsay', now() - interval '3 hours', now())`;
    await sql`insert into com (parent_cid, created_by, body, created_at, score)
      values (302, 'bot_summoner', '@bot_cowsay', now() - interval '1 minute', now() - interval '2 days')`;

    const api: Api = {
      apiUrl: "",
      auth: btoa("bot-summoner@ding.bar:sumpw!"),
      botUsername: "bot_summoner",
      fetch: (i, n) => botFetch(i, n),
    };

    await t.step("a 1-minute-old comment means the run skips", async () => {
      const before = (await sql`select count(*)::int as n from com where created_by = 'bot_summoner'`)[0].n;
      await BOTS["summoner"](api);
      const after = (await sql`select count(*)::int as n from com where created_by = 'bot_summoner'`)[0].n;
      assertEquals(after, before, "summoner posted despite a fresh comment — gap probe read the wrong row");
    });
  }),
);

//// IMAGE MENTION BOTS ////////////////////////////////////////////////////////

// Reproduces https://ding.bar/c/92802: bot_summoner left a bare "@bot_pixel" on a post whose image
// was uploaded through POST /i, and the image bot never answered. i.ding.bar is a custom domain on
// THIS Deno Deploy project, so the cron isolate was fetching its own origin. Every image fetch must
// go straight to R2. Uses a stub transform, not the real dither, so sharp stays out of the suite.
Deno.test(
  "imageMentionBot fetches i.ding.bar images from R2, not from its own origin",
  pgtest((sql) => async (t) => {
    await sql`insert into usr (name, email, password, bio, email_verified_at, invited_by) values
      ('bot_summoner', 'bot-summoner@ding.bar', 'hashed:sumpw!', 'beep', now(), 'john_doe'),
      ('bot_pixel', 'bot-pixel@ding.bar', 'hashed:pixpw!', 'art', now(), 'john_doe')`;

    const sumApi: Api = {
      apiUrl: "",
      auth: btoa("bot-summoner@ding.bar:sumpw!"),
      botUsername: "bot_summoner",
      fetch: (i, n) => botFetch(i, n),
    };
    const pixApi: Api = {
      apiUrl: "",
      auth: btoa("bot-pixel@ding.bar:pixpw!"),
      botUsername: "bot_pixel",
      fetch: (i, n) => botFetch(i, n),
    };

    // Each step starts from an empty thread. A skipped or failed mention is deliberately never
    // marked answered, so without this the leftovers from earlier steps get retried in later ones.
    // One statement, so the self-referencing parent_cid FK is checked only after both are gone.
    const reset = () => sql`delete from com where created_by in ('john_doe', 'bot_summoner', 'bot_pixel')`;

    // Summon on a comment, so the image has to resolve one level up from the parent root — the
    // exact shape of the reported post.
    const summon = async (imageUrl: string) => {
      const fd = new FormData();
      fd.append("body", `Holocloth\n\nhttps://holocloth.example\n\n${imageUrl}`);
      fd.append("tags", "#pics");
      const res = await app.request("/c", {
        method: "POST",
        body: fd,
        headers: basic("john@example.com", "password1!"),
      });
      const cid = +res.headers.get("location")!.match(/\/c\/(\d+)/)![1];
      assertEquals(await reply(sumApi, cid, "@bot_pixel"), true);
      return cid;
    };

    // botFetch dispatches through app.request, so only the outbound image fetch is stubbed here.
    const withImageFetch = async (
      handler: (url: string) => Response,
      body: () => Promise<void>,
    ): Promise<string[]> => {
      const orig = globalThis.fetch;
      const seen: string[] = [];
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (/\.(png|jpe?g|gif|webp|svg)$/i.test(new URL(url).pathname)) {
          seen.push(url);
          return Promise.resolve(handler(url));
        }
        return orig(input as RequestInfo, init);
      }) as typeof fetch;
      try {
        await body();
      } finally {
        globalThis.fetch = orig;
      }
      return seen;
    };

    const prevR2 = Deno.env.get("R2_PUBLIC_URL");
    Deno.env.set("R2_PUBLIC_URL", "https://r2-pub.example");
    const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });

    try {
      await t.step("an i.ding.bar image is fetched from the R2 origin and answered", async () => {
        await reset();
        await summon("https://i.ding.bar/UUvGLX1G.png");
        const seen = await withImageFetch(
          png,
          () => imageMentionBot(pixApi, { transform: () => Promise.resolve("⣿⣿⣿") }),
        );
        assertEquals(seen, ["https://r2-pub.example/i/UUvGLX1G.png"]);
        const replies = await sql`select body from com where created_by = 'bot_pixel'`;
        assertEquals(replies.length, 1, "image bot did not answer the summon");
        assertEquals(replies[0].body, "⣿⣿⣿");
      });

      await t.step("an external image host is fetched unchanged", async () => {
        await reset();
        await summon("https://i.redd.it/xyz123.jpg");
        const seen = await withImageFetch(
          png,
          () => imageMentionBot(pixApi, { transform: () => Promise.resolve("⠿") }),
        );
        assertEquals(seen, ["https://i.redd.it/xyz123.jpg"]);
      });

      // The old harness console.error'd and continued, so a run where every image bounced
      // reported green to the fleet and re-burned the same work every 5-minute tick for 4h.
      await t.step("a run where every image bounces throws", async () => {
        await reset();
        await summon("https://i.ding.bar/DEADBEEF.png");
        let err: Error | null = null;
        await withImageFetch(() => new Response("nope", { status: 500 }), async () => {
          await imageMentionBot(pixApi, { transform: () => Promise.resolve("x") })
            .catch((e) => err = e);
        });
        assertExists(err, "imageMentionBot swallowed a run where nothing landed");
        assertStringIncludes((err as Error).message, "none landed");
        assertStringIncludes((err as Error).message, "HTTP 500");
        assertEquals((await sql`select cid from com where created_by = 'bot_pixel'`).length, 0);
      });

      // One unreachable image must not abort the mentions behind it.
      await t.step("one bad image does not block the rest of the run", async () => {
        await reset();
        await summon("https://i.ding.bar/BADBAD01.png");
        await summon("https://i.ding.bar/GOODGOOD.png");
        const seen = await withImageFetch(
          (url) =>
            url.includes("BADBAD01")
              ? (() => {
                throw new TypeError("redirect count exceeded");
              })()
              : png(),
          () => imageMentionBot(pixApi, { transform: () => Promise.resolve("⡇") }),
        );
        assertEquals(seen.length, 2);
        const replies = await sql`select body from com where created_by = 'bot_pixel'`;
        assertEquals(replies.length, 1, "the good mention was skipped after the bad one");
      });

      // A mention with no image anywhere is a legitimate decline, not a failure.
      await t.step("no image found is a silent skip, not a throw", async () => {
        await reset();
        const fd = new FormData();
        fd.append("body", "no pictures here @bot_pixel");
        fd.append("tags", "#pics");
        await app.request("/c", { method: "POST", body: fd, headers: basic("john@example.com", "password1!") });
        const seen = await withImageFetch(
          png,
          () => imageMentionBot(pixApi, { transform: () => Promise.resolve("x") }),
        );
        assertEquals(seen, []);
        assertEquals((await sql`select cid from com where created_by = 'bot_pixel'`).length, 0);
      });
    } finally {
      if (prevR2) Deno.env.set("R2_PUBLIC_URL", prevR2);
      else Deno.env.delete("R2_PUBLIC_URL");
    }
  }),
);

//// LABEL PREF TESTS //////////////////////////////////////////////////////////

// A pref is a label plus a vote: (uid, kind, val) is the primary key, so re-sending the
// same vote clears it and the opposite vote replaces it. ▲ is public (follower counts,
// mutuals); ▼ is private to the voter and must not surface anywhere else.
Deno.test(
  "label prefs",
  pgtest((sql) => async (t) => {
    const jAuth = basic("john@example.com", "password1!");
    const janeAuth = basic("jane@example.com", "password1!");
    const vote = (label: string, v: string, headers: Record<string, string> = jAuth) => {
      const f = new FormData();
      f.append("label", label);
      f.append("vote", v);
      return app.request("/p", { method: "POST", body: f, headers });
    };
    const rows = (uid = "john_doe") =>
      sql`select kind, val::text, vote from pref where uid = ${uid} order by kind, val`;

    await t.step("▲ a #tag, @user and ~domain writes one row each", async () => {
      for (const [l, v] of [["#humor", "1"], ["@jane_doe", "1"], ["~arxiv.org", "-1"]])
        assertEquals((await vote(l, v)).status, 302);
      assertEquals([...await rows()], [
        { kind: "tag", val: "humor", vote: 1 },
        { kind: "usr", val: "jane_doe", vote: 1 },
        { kind: "www", val: "arxiv.org", vote: -1 },
      ]);
    });

    await t.step("re-sending the same vote toggles it off", async () => {
      await vote("#toggleme", "1");
      assertEquals((await sql`select vote from pref where uid = 'john_doe' and val = 'toggleme'`).length, 1);
      await vote("#toggleme", "1");
      assertEquals((await sql`select vote from pref where uid = 'john_doe' and val = 'toggleme'`).length, 0);
    });

    // The reaction path lets a user hold ▲ and ▼ at once; a pref is a single preference,
    // and the primary key is what enforces that.
    await t.step("the opposite vote replaces rather than stacks", async () => {
      await vote("#flipme", "1");
      await vote("#flipme", "-1");
      assertEquals([...await sql`select vote from pref where uid = 'john_doe' and val = 'flipme'`], [{ vote: -1 }]);
    });

    // The write path normalizes `www.`, so the read path must too — otherwise the button on
    // /c?www=www.arxiv.org renders un-voted, and clicking the ▲ silently DELETES the pref.
    await t.step("a ~domain vote reads back the same on both host spellings", async () => {
      await sql`delete from pref where uid = 'john_doe' and kind = 'www'`;
      await vote("~www.arxiv.org", "1");
      for (const q of ["arxiv.org", "www.arxiv.org"]) {
        const html = await (await app.request(`/c?www=${q}`, { headers: jAuth })).text();
        assertStringIncludes(html, "reaction reacted", `?www=${q} showed the vote as unset`);
      }
    });

    await t.step("~www.host and ~host collapse to the same row", async () => {
      await vote("~www.example.org", "1");
      assertEquals(
        [...await sql`select val::text, vote from pref where uid = 'john_doe' and kind = 'www' and val = 'example.org'`],
        [{ val: "example.org", vote: 1 }],
      );
      await vote("~example.org", "1"); // same row -> toggles the first one off
      assertEquals(
        (await sql`select 1 from pref where uid = 'john_doe' and kind = 'www' and val = 'example.org'`).length,
        0,
      );
    });

    await t.step("@user prefs are case-insensitive (citext), like usr.name", async () => {
      await sql`delete from pref where uid = 'john_doe' and kind = 'usr'`;
      await vote("@jane_doe", "1");
      await vote("@JANE_DOE", "-1"); // same row, so this replaces rather than adding a second
      assertEquals(
        [...await sql`select val::text, vote from pref where uid = 'john_doe' and kind = 'usr'`],
        [{ val: "jane_doe", vote: -1 }],
      );
    });

    // `kind = 'org'` could never appear (the check constraint forbids it), so asserting its
    // absence proves nothing — assert instead that the table did not move at all.
    await t.step("*org and bare text are rejected with a message naming the input", async () => {
      const before = [...await rows()];
      for (const bad of ["*secret", "hello", "", "#humor @jane_doe", "#"]) {
        const res = await vote(bad, "1");
        assertEquals(res.status, 400, `expected 400 for label "${bad}"`);
        assertStringIncludes(await res.text(), bad || "exactly one");
      }
      // A NUL would otherwise reach the driver and surface as an opaque 500.
      const nul = await vote("#a\u0000b", "1");
      assertEquals(nul.status, 400);
      assertStringIncludes(await nul.text(), "NUL byte");
      assertEquals([...await rows()], before, "a rejected label still wrote a row");
    });

    // ~domain has a closed vocabulary: extractDomains only ever produces bare hostnames, so a
    // URL/path/scheme pref would be accepted and then never match anything.
    await t.step("~domain must be a bare hostname", async () => {
      const before = [...await rows()];
      for (const bad of ["~https://arxiv.org", "~arxiv.org/abs/1", "~.", "~-", "~localhost"]) {
        const res = await vote(bad, "1");
        assertEquals(res.status, 400, `expected 400 for label "${bad}"`);
        assertStringIncludes(await res.text(), "is not a hostname");
      }
      assertEquals([...await rows()], before);
    });

    await t.step("a vote other than 1 / -1 is rejected", async () => {
      for (const v of ["0", "5", "up", ""]) {
        const res = await vote("#votecheck", v);
        assertEquals(res.status, 400, `expected 400 for vote "${v}"`);
        assertStringIncludes(await res.text(), "▲");
      }
      assertEquals((await sql`select 1 from pref where val = 'votecheck'`).length, 0);
    });

    await t.step("voting on yourself is refused; an unknown @user 404s", async () => {
      const self = await vote("@JOHN_DOE", "1"); // citext, so the check can't be case-dodged
      assertEquals(self.status, 400);
      assertStringIncludes(await self.text(), "cannot follow or mute yourself");
      const missing = await vote("@nosuchuser", "1");
      assertEquals(missing.status, 404);
      assertStringIncludes(await missing.text(), "no user named @nosuchuser");
      assertEquals((await sql`select 1 from pref where uid = 'john_doe' and val = 'john_doe'`).length, 0);
    });

    // refBack sanitizes the Referer, and `https://host//evil.com` passes a bare host check
    // while its pathname is a protocol-relative URL browsers follow off-site.
    await t.step("a protocol-relative Referer cannot redirect off-site", async () => {
      const f = new FormData();
      f.append("label", "#refcheck");
      f.append("vote", "1");
      const res = await app.request("/p", {
        method: "POST",
        body: f,
        headers: { ...jAuth, referer: "http://localhost//evil.example", host: "localhost" },
      });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/", "an off-site redirect escaped refBack");
    });

    // #tag is free-form by design — it names content, not an account. A 302 alone would also
    // be returned by a write that silently did nothing, so assert the rows.
    await t.step("unknown #tags and ~domains are accepted and stored", async () => {
      assertEquals((await vote("#nobodyhasusedthis", "1")).status, 302);
      assertEquals((await vote("~nowhere.invalid", "1")).status, 302);
      assertEquals(
        [
          ...await sql`select kind, val::text from pref
                       where uid = 'john_doe' and val in ('nobodyhasusedthis', 'nowhere.invalid') order by kind`,
        ],
        [{ kind: "tag", val: "nobodyhasusedthis" }, { kind: "www", val: "nowhere.invalid" }],
      );
    });

    await t.step("anonymous POST /p redirects to login and writes nothing", async () => {
      const f = new FormData();
      f.append("label", "#anonshouldnotwrite");
      f.append("vote", "1");
      const res = await app.request("/p", { method: "POST", body: f });
      assertEquals(res.status, 302);
      assertStringIncludes(res.headers.get("location") ?? "", "/u");
      // pref.uid is NOT NULL, so `where uid is null` could never match. Use a label no other
      // step touches, so this measures the anonymous write and not leftover state.
      assertEquals((await sql`select 1 from pref where val = 'anonshouldnotwrite'`).length, 0);
    });

    // pref.val has no FK (a partial one isn't expressible), so following an account that is
    // later deleted — ding-prune-unverified does exactly that — leaves the row behind. If the
    // un-follow also validated existence, the chip on /u would 404 forever and "N following"
    // would never settle. Only creating a pref may require the target to exist.
    await t.step("a follow of a since-deleted user can still be removed", async () => {
      await sql`delete from pref where uid = 'john_doe' and kind = 'usr'`;
      await sql`insert into usr (name, email, password, bio, email_verified_at, invited_by)
                values ('ghostuser', 'ghost@example.com', 'x', 'x', now(), 'john_doe')`;
      assertEquals((await vote("@ghostuser", "1")).status, 302);
      await sql`delete from usr where name = 'ghostuser'`;
      assertEquals((await sql`select 1 from pref where uid = 'john_doe' and val = 'ghostuser'`).length, 1);
      assertEquals((await vote("@ghostuser", "1")).status, 302, "the un-follow was rejected");
      assertEquals((await sql`select 1 from pref where uid = 'john_doe' and val = 'ghostuser'`).length, 0);
    });

    await t.step("deleting a user cascades their prefs away", async () => {
      await sql`insert into usr (name, email, password, bio, email_verified_at, invited_by)
                values ('pref_goner', 'goner@x.com', 'x', 'x', now(), 'john_doe')`;
      await sql`insert into pref (uid, kind, val, vote) values ('pref_goner', 'tag', 'humor', 1)`;
      await sql`delete from usr where name = 'pref_goner'`;
      assertEquals((await sql`select 1 from pref where uid = 'pref_goner'`).length, 0);
    });

    await t.step("mutuals appear only when both sides ▲, and vanish on un-follow", async () => {
      await sql`delete from pref`;
      const mutualsOf = async (cookie: string) => {
        const html = await (await app.request("/u", { headers: { cookie } })).text();
        return html.slice(html.indexOf("<h2>people</h2>"), html.indexOf("<h2>interests</h2>"));
      };
      const login = async (email: string) => {
        const body = new FormData();
        body.append("email", email);
        body.append("password", "password1!");
        const boot = await app.request("/login", { method: "POST", body });
        return boot.headers.get("set-cookie")!.split(";")[0];
      };
      const [jCookie, janeCookie] = [await login("john@example.com"), await login("jane@example.com")];

      await vote("@jane_doe", "1");
      assertStringIncludes(await mutualsOf(jCookie), "no mutuals yet", "one-sided follow is not a mutual");
      assertStringIncludes(await (await app.request("/u/jane_doe")).text(), "1 follower");

      await vote("@john_doe", "1", janeAuth);
      assertStringIncludes(await mutualsOf(jCookie), "/u/jane_doe");
      assertStringIncludes(await mutualsOf(janeCookie), "/u/john_doe");
      const profile = await (await app.request("/u/jane_doe", { headers: { cookie: jCookie } })).text();
      assertStringIncludes(profile, "mutual");
      // The hub shows your own counts, so you never have to visit /u/<yourself> to read them.
      const hub = await (await app.request("/u", { headers: { cookie: jCookie } })).text();
      assertStringIncludes(hub, "1 follower");
      assertStringIncludes(hub, "1 following");

      await vote("@jane_doe", "1"); // toggle off
      assertStringIncludes(await mutualsOf(jCookie), "no mutuals yet");
      assertStringIncludes(await mutualsOf(janeCookie), "no mutuals yet");
    });

    // ▼ is private: it must not move a follower count and must not render on the target's
    // profile for anyone but the voter. The owner and an anonymous visitor both get no vote
    // control at all, so testing only those would be vacuous — a logged-in THIRD PARTY is
    // the viewer that can actually leak, and john is the positive control.
    await t.step("a ▼ on a user is invisible to everyone else", async () => {
      await sql`delete from pref`;
      await sql`insert into usr (name, email, password, bio, email_verified_at, invited_by)
                values ('third_party', 'third@example.com', 'hashed:password1!', 'x', now(), 'john_doe')
                on conflict do nothing`;
      await vote("@jane_doe", "-1");

      const seenBy = async (headers: Record<string, string>) =>
        await (await app.request("/u/jane_doe", { headers })).text();
      for (
        const [who, headers] of [["anon", {}], ["owner", janeAuth], [
          "third party",
          basic("third@example.com", "password1!"),
        ]] as const
      ) {
        const html = await seenBy(headers);
        assertStringIncludes(html, "0 followers");
        assertEquals(html.includes("reaction reacted"), false, `john's ▼ leaked to ${who}`);
      }
      // Positive control: the voter DOES see their own ▼ latched, so the check above is
      // measuring privacy rather than a vote control that never renders.
      assertStringIncludes(await seenBy(jAuth), "reaction reacted");
    });
  }),
);

// The frontpage takes a window of the global ranking and re-sorts it by the viewer's prefs.
// Everything here is about what that must NOT disturb: anonymous viewers, other users,
// `sort=new`/`sort=top`, and deep pages.
Deno.test(
  "pref-personalized frontpage",
  pgtest((sql) => async (t) => {
    const login = async (email: string) => {
      const body = new FormData();
      body.append("email", email);
      body.append("password", "password1!");
      const boot = await app.request("/login", { method: "POST", body });
      return boot.headers.get("set-cookie")!.split(";")[0];
    };
    // Post titles are the first body line and each renders as `>title</a>`, so reading the
    // order off the rendered feed is what actually proves the ORDER BY.
    const feed = async (qs = "", cookie?: string) => {
      const html = await (await app.request(`/${qs}`, cookie ? { headers: { cookie } } : {})).text();
      return [...html.matchAll(/>(prefpost-[a-z]+)</g)].map((m) => m[1]);
    };

    // Three posts with distinct tags/domains/authors, scored an hour apart and a day ahead of
    // everything seeded, so they sit at the top of page 1 in a fixed order. Equal scores would
    // make the baseline a tie, and ties are ordered arbitrarily — the assertions below would
    // then be measuring the planner, not the prefs.
    const top = sql`now() + interval '1 day'`;
    await sql`insert into com (cid, created_by, body, tags, domains, created_at, score) values
      (901, 'BugHunter42', 'prefpost-alpha', '{alphatag}', '{alpha.example}', ${top},                          ${top}),
      (902, 'BugHunter42', 'prefpost-beta',  '{betatag}',  '{beta.example}',  ${top} - interval '1 hour',  ${top} - interval '1 hour'),
      (903, 'jane_doe',    'prefpost-gamma', '{gammatag}', '{gamma.example}', ${top} - interval '2 hours', ${top} - interval '2 hours')`;
    const jCookie = await login("john@example.com");
    const janeCookie = await login("jane@example.com");
    const baseline = ["prefpost-alpha", "prefpost-beta", "prefpost-gamma"];

    await t.step("a viewer with no prefs sees the global ranking", async () => {
      assertEquals(await feed(), baseline, "anonymous");
      assertEquals(await feed("", jCookie), baseline, "logged in, no prefs");
    });

    await t.step("▲ on a #tag lifts its posts, and toggling off restores the order", async () => {
      const f = new FormData();
      f.append("label", "#betatag");
      f.append("vote", "1");
      await app.request("/p", { method: "POST", body: f, headers: { cookie: jCookie } });
      // The full array, not a relative rank: indexOf returns -1 for a missing post and
      // -1 < 0 is true, so a rank comparison passes when the boosted post has vanished.
      assertEquals(await feed("", jCookie), ["prefpost-beta", "prefpost-alpha", "prefpost-gamma"]);
      await app.request("/p", { method: "POST", body: f, headers: { cookie: jCookie } });
      assertEquals(await feed("", jCookie), baseline);
    });

    await t.step("▼ on a ~domain sinks its posts", async () => {
      await sql`insert into pref (uid, kind, val, vote) values ('john_doe', 'www', 'alpha.example', -1)`;
      assertEquals(await feed("", jCookie), ["prefpost-beta", "prefpost-gamma", "prefpost-alpha"]);
      await sql`delete from pref where uid = 'john_doe'`;
    });

    await t.step("▲ on a @user lifts their posts (upvoting a user is following)", async () => {
      await sql`insert into pref (uid, kind, val, vote) values ('john_doe', 'usr', 'jane_doe', 1)`;
      assertEquals(await feed("", jCookie), ["prefpost-gamma", "prefpost-alpha", "prefpost-beta"]);
      await sql`delete from pref where uid = 'john_doe'`;
    });

    await t.step("one user's prefs never move another viewer's feed", async () => {
      await sql`insert into pref (uid, kind, val, vote) values ('john_doe', 'tag', 'betatag', 1)`;
      assertEquals(await feed(), baseline, "anonymous feed shifted");
      assertEquals(await feed("", janeCookie), baseline, "jane's feed shifted");
      assertEquals((await feed("", jCookie))[0], "prefpost-beta", "john's own feed did not shift");
      await sql`delete from pref where uid = 'john_doe'`;
    });

    // `new` is chronological and `top` is most-voted. Re-ranking either would be a lie, so
    // prefs must only touch the default `hot` sort.
    // An unknown sort must behave exactly like `hot`: orderBy falls through to `score desc`
    // for anything it doesn't recognize, so the personalization branch has to agree or the
    // two silently disagree about what page the user is looking at.
    await t.step("sort=new/top ignore prefs; an unknown sort is still personalized", async () => {
      await sql`insert into pref (uid, kind, val, vote) values ('john_doe', 'tag', 'betatag', 1)`;
      for (const s of ["new", "top"])
        assertEquals(await feed(`?sort=${s}`, jCookie), baseline, `sort=${s} was re-ranked`);
      const boosted = ["prefpost-beta", "prefpost-alpha", "prefpost-gamma"];
      for (const qs of ["", "?sort=hot", "?sort=HOT", "?sort=banana"])
        assertEquals(await feed(qs, jCookie), boosted, `${qs || "(default)"} took the wrong branch`);
      await sql`delete from pref where uid = 'john_doe'`;
    });

    // Paging must be a stable slice of ONE ordered list. A window whose membership grows with
    // the page is not: a row that only enters at page p sorts to the top of that page's window,
    // into a slot page p-1 already used — so it is emitted on no page at all, and the row it
    // displaced is emitted twice. Walking every page is the only way to see that.
    await t.step("walking every page yields each post exactly once", async () => {
      await sql`delete from pref`;
      await sql`insert into com (created_by, body, tags, created_at, score)
                select 'BugHunter42', 'walk-' || lpad(g::text, 3, '0'), '{walktag}',
                       now() + interval '9 days' + (g || ' seconds')::interval,
                       now() + interval '9 days' + (g || ' seconds')::interval
                  from generate_series(1, 400) g`;
      // Deep enough to sit outside a 300-row window at page 0, tagged so a ▲ lifts it.
      await sql`update com set tags = '{walktag,liftme}' where body = 'walk-089'`;
      await sql`insert into pref (uid, kind, val, vote) values ('john_doe', 'tag', 'liftme', 1)`;

      const seen: string[] = [];
      for (let page = 0; page < 17; page++) {
        const html = await (await app.request(`/?p=${page}`, { headers: { cookie: jCookie } })).text();
        seen.push(...[...html.matchAll(/>(walk-\d+)</g)].map((m) => m[1]));
      }
      assertEquals(seen.filter((x, i) => seen.indexOf(x) !== i), [], "a post was shown on two pages");
      assertEquals(seen.includes("walk-089"), true, "the boosted post appeared on no page at all");
      assertEquals(new Set(seen).size, 400, "some posts were unreachable");
    });

    // Past the window the feed falls back to the global order — which is exactly where the
    // personalized list's tail lives — so a deep page must still return rows.
    await t.step("deep pages still return rows with prefs set", async () => {
      await sql`insert into pref (uid, kind, val, vote) values ('john_doe', 'tag', 'walktag', 1)
                on conflict (uid, kind, val) do update set vote = 1`;
      const html = await (await app.request("/?p=14", { headers: { cookie: jCookie } })).text();
      assertStringIncludes(html, 'class="posts"');
      assertEquals(html.includes("no posts yet"), false, "deep page fell off the candidate window");
      await sql`delete from pref`;
      await sql`delete from com where body like 'walk-%'`;
    });

    await t.step("private posts stay private under personalized ranking", async () => {
      await sql`insert into pref (uid, kind, val, vote) values ('jane_doe', 'tag', 'general', 1)
                on conflict do nothing`;
      // 357 is a DM to BugHunter42/DebuggerDiva; jane is neither, so no boost may reveal it.
      const html = await (await app.request("/", { headers: { cookie: janeCookie } })).text();
      const [dm] = await sql`select body from com where cid = 357`;
      assertEquals(html.includes(dm.body.split("\n")[0]), false, "a DM leaked into a personalized feed");
    });
  }),
);
