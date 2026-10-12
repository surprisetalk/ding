#!/usr/bin/env -S deno run -A
//// ding CLI ////////////////////////////////////////////////////////////////////
// Self-managed identity: signs rows with your own key and POSTs them to a node.
// Key lives at ~/.ding/key.json. No deps; shares dht.ts with the server so hashes
// are byte-identical. Commands: msg, usr, org, flag, mark, id, status.

import {
  buildMark,
  buildMsg,
  exportJwk,
  genKey,
  idOf,
  importPriv,
  nowSec,
  parseLabels,
  pubHexOf,
  type Row,
  signRow,
} from "./dht.ts";

const YEAR = 365 * 86400;

const DB = Deno.env.get("DING_DB") ?? "https://db.ding.bar";
const KEY_PATH = `${Deno.env.get("HOME")}/.ding/key.json`;

const csv = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const die = (msg: string): never => {
  console.error(`ding: ${msg}`);
  Deno.exit(1);
};

const loadKey = async (): Promise<{ priv: CryptoKey; pub: string }> => {
  try {
    const { jwk, pubkey } = JSON.parse(await Deno.readTextFile(KEY_PATH));
    return { priv: await importPriv(jwk), pub: pubkey };
  } catch (e) {
    // Only mint a fresh identity when there is genuinely no key file. Any other
    // error (permissions, corrupt JSON, bad key) must NOT clobber an existing key.
    if (!(e instanceof Deno.errors.NotFound)) {
      return die(
        `could not load key at ${KEY_PATH}: ${e instanceof Error ? e.message : e}\n` +
          `  refusing to overwrite — fix or move the file, or delete it to mint a new identity.`,
      );
    }
    const kp = await genKey();
    const pub = await pubHexOf(kp);
    await Deno.mkdir(`${Deno.env.get("HOME")}/.ding`, { recursive: true });
    await Deno.writeTextFile(KEY_PATH, JSON.stringify({ pubkey: pub, jwk: await exportJwk(kp) }, null, 2));
    console.error(`ding: created a new key at ${KEY_PATH} (id ${(await idOf(pub)).slice(0, 12)}…)`);
    return { priv: kp.privateKey, pub };
  }
};

const send = async (row: Row) => {
  let res: Response;
  try {
    res = await fetch(DB, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: JSON.stringify(row),
    });
  } catch (e) {
    return die(`could not reach node ${DB}: ${e instanceof Error ? e.message : e}`);
  }
  const text = await res.text();
  if (!res.ok) return die(`POST ${DB} → ${res.status}: ${text}`);
  // The node returns 200 with {ok,bad,errors} even for rejected rows — fail loudly.
  const r = JSON.parse(text);
  if (r.bad > 0 || r.ok === 0) return die(`node rejected the row: ${(r.errors ?? []).join("; ") || text}`);
  console.log(`ok (id ${row.k.slice(0, 12)}…)`);
};

// --k=v | --k v | positional
const parseArgs = (argv: string[]) => {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = "true";
    } else { positional.push(a); }
  }
  return { flags, positional };
};

const [cmd, ...rest] = Deno.args;
const { flags, positional } = parseArgs(rest);

switch (cmd) {
  case "msg": {
    const body = positional[0];
    if (!body) die(`usage: ding msg "hello world" "#tag *org @usr"`);
    const l = parseLabels(positional.slice(1).join(" "));
    const key = await loadKey();
    const payload = buildMsg({ tags: l.tag, orgs: l.org, usrs: l.usr, body });
    await send(await signRow("msg", nowSec(), payload, key.priv, key.pub));
    break;
  }
  case "usr": {
    // declare an identity register: a self-asserted name/bio + links the checkmark
    // cron will verify (DNS TXT, GitHub bio) into dns:/github: marks
    if (!flags.name) die(`usage: ding usr --name=taylor_town [--bio=hello] [--links=taylor.town,github.com/you]`);
    const links = csv(flags.links);
    const key = await loadKey();
    const payload = { name: flags.name, bio: flags.bio ?? "", links };
    await send(await signRow("usr", nowSec(), payload, key.priv, key.pub));
    break;
  }
  case "flag": {
    const target = positional[0];
    if (!/^[0-9a-f]{64}$/.test(target ?? ""))
      die(`usage: ding flag <content-hash>  (64 hex chars; identity flagging by handle is not yet supported)`);
    const key = await loadKey();
    await send(await signRow("flag", nowSec(), { target }, key.priv, key.pub));
    break;
  }
  case "org": {
    // an org register: the org IS this key. members are 64-hex ids who may read *org content.
    if (!flags.name) die(`usage: ding org --name=nba [--bio=...] [--links=nba.com] [--members=id1,id2]`);
    const links = csv(flags.links);
    const members = csv(flags.members);
    const key = await loadKey();
    const payload = { name: flags.name, bio: flags.bio ?? "", links, members };
    await send(await signRow("org", nowSec(), payload, key.priv, key.pub));
    break;
  }
  case "mark": {
    // personal web-of-trust vouch: you, as issuer, endorse another identity id
    const subject = positional[0];
    if (!/^[0-9a-f]{64}$/.test(subject ?? ""))
      die(`usage: ding mark <id>  (the 64-hex id of the identity you vouch for)`);
    const key = await loadKey();
    const payload = buildMark(subject, "vouch", nowSec() + YEAR);
    await send(await signRow("mark", nowSec(), payload, key.priv, key.pub));
    break;
  }
  case "id": {
    const key = await loadKey();
    console.log(JSON.stringify({ pubkey: key.pub, id: await idOf(key.pub) }, null, 2));
    break;
  }
  case "status": {
    const url = positional[0];
    if (!/^https?:\/\//.test(url ?? "") || !URL.canParse(url)) {
      die(
        `status takes the URL of /status.\n\n    expected: an http or https URL, such as https://ding.bar/status\n    received: ${
          JSON.stringify(url)
        }\n    source: ding status <url>\n\nRun \`deno task status\` to check production.`,
      );
    }
    let res: Response, text: string;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      text = await res.text();
    } catch (e) {
      die(
        `status cannot reach ${url}.\n\n    expected: an answer within 10 s\n    received: ${
          e instanceof Error ? e.message : e
        }\n    source: ${url}\n\nLikely fix: check the Deno Deploy dashboard for the ding project. For a local server, run it and pass its URL.`,
      );
    }
    let report: unknown;
    try {
      report = JSON.parse(text!);
    } catch {
      // The shape check below rejects a body that is not JSON.
    }
    const isRecord = (x: unknown): x is Record<string, unknown> =>
      typeof x === "object" && x !== null && !Array.isArray(x);
    const scores = isRecord(report) ? Object.values(report) : [];
    const nows = scores.flatMap((v) => isRecord(v) && typeof v["0"] === "number" ? [v["0"]] : []);
    const valid = nows.length > 0 && nows.length === scores.length;
    const healthy = valid && nows.every((n) => n >= 1);
    if (!valid || healthy !== (res!.status === 200)) {
      die(
        `status received an answer that is not a status report.\n\n    expected: HTTP 200 with every "0" at 1.0 or above, or HTTP 503 with a "0" below 1.0, as JSON such as {"<condition>": {"0": 1.5}}\n    received: HTTP ${
          res!.status
        }, ${
          JSON.stringify(text!.slice(0, 200))
        }\n    source: ${url}\n\nLikely fix: an HTTP 404 means the deploy with /status has not shipped; see "Blocked on you" in todo.md. Otherwise check that ${url} is the /status of ding.`,
      );
    }
    console.log(text!);
    if (!healthy)
      console.error("A condition scored below 1.0. Each condition's likely fix is in `checks` in server.tsx.");
    Deno.exit(healthy ? 0 : 1);
    break; // deno lint no-fallthrough does not know Deno.exit never returns
  }
  default:
    die(`unknown command "${cmd ?? ""}". commands: msg, usr, org, flag, mark, id, status`);
}
