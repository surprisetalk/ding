// node.tsx — a replica / gossip node. Serves the same (www|api|rss|db) endpoints AND
// mirrors a mesh by polling the bootstrap + discovered peers (pull/short-poll; WS
// live-tail is a later optimization). Run: `deno serve -A node.tsx`.
//
//   BOOTSTRAP     trust-anchor node               (default https://db.ding.bar)
//   PEER_QUERIES  '&'-joined q filters to pull     (default the public kinds + $peer)
//   MY_IPS        ','-joined dialable origins to advertise (e.g. https://1.2.3.4:8443)
//   N_PEERS       how many discovered peers to also mirror (default 4)
//   NODE_KEY      this node's {pubkey,jwk} for signing its peer row (else ephemeral)

import app, { discoverPeers, publishPeer, replicate } from "./server.tsx";
import { genKey, importPriv, pubHexOf } from "./dht.ts";

const BOOTSTRAP = Deno.env.get("BOOTSTRAP") ?? "https://db.ding.bar";
const QUERIES = (Deno.env.get("PEER_QUERIES") ?? "$msg&$usr&$org&$mark&$flag&$peer").split("&").filter(Boolean);
const MY_IPS = (Deno.env.get("MY_IPS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const N_PEERS = +(Deno.env.get("N_PEERS") ?? "4");

const nodeKey = await (async () => {
  const raw = Deno.env.get("NODE_KEY");
  if (raw) {
    const { pubkey, jwk } = JSON.parse(raw);
    return { priv: await importPriv(jwk), pub: pubkey as string };
  }
  const kp = await genKey();
  return { priv: kp.privateKey, pub: await pubHexOf(kp) };
})();

const cursors: Record<string, string> = {};
let peerUrls: string[] = []; // the bootstrap is always included as a trust anchor (anti-eclipse)

const mirrorAll = async () => {
  for (const url of [BOOTSTRAP, ...peerUrls]) {
    try {
      cursors[url] = await replicate(url, QUERIES, cursors[url] ?? "0");
    } catch (e) {
      console.error(`node: replicate ${url} failed (will retry): ${e instanceof Error ? e.message : e}`);
    }
  }
  setTimeout(mirrorAll, 30_000);
};

const gossip = async () => {
  try {
    const peers = await discoverPeers(BOOTSTRAP);
    peerUrls = [...new Set(peers.flatMap((p) => p.ips))].filter((ip) => ip && ip !== BOOTSTRAP).slice(0, N_PEERS);
    if (MY_IPS.length) await publishPeer(BOOTSTRAP, MY_IPS, QUERIES, nodeKey.priv, nodeKey.pub);
  } catch (e) {
    console.error(`node: gossip failed (will retry): ${e instanceof Error ? e.message : e}`);
  }
  setTimeout(gossip, 3_600_000); // ~hourly re-discover + re-broadcast
};

mirrorAll();
gossip();

export default app;
