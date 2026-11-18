// keygen.ts — generate the prod secrets for the DHT layer. Run LOCALLY (the secrets never
// leave your machine); store them where noted below. NEVER commit the output.
//
//   deno run -A keygen.ts

import { exportJwk, genKey, hex, idOf, pubHexOf } from "./dht.ts";

const keyWrap = hex(crypto.getRandomValues(new Uint8Array(32)));
const kp = await genKey();
const pub = await pubHexOf(kp);
const id = await idOf(pub);
const sk = JSON.stringify(await exportJwk(kp));

console.log(`
================================================================================
  ding DHT — prod secrets (generated locally; store securely, never commit)
================================================================================

All four go in /var/lib/ding/env on pc (mode 0600), next to the existing vars in that file
(COOKIE_SECRET, EMAIL_TOKEN_SECRET, DATABASE_URL, RESEND_*, STRIPE_*, R2_*). The server
refuses to boot without KEY_WRAP_SECRET.

  KEY_WRAP_SECRET=${keyWrap}
  DING_ORG_PK=${pub}
  DING_ORG_SK=${sk}
  DING_DB=https://db.ding.bar

  !! KEY_WRAP_SECRET is PERMANENT — it encrypts every custodial private key. Lose it and all
     custodial keys are unrecoverable. Back it up in a password manager / secret store. Do not
     rotate casually (rotation needs a decrypt-then-re-encrypt pass with the old value).

  ~  DING_ORG_SK is the checkmark trust root, signed by the in-server Deno.cron. It lives on
     the main server. Moving the cron to a separate host stops a server breach from also
     minting fake checkmarks.

  (trust-root org id, for reference: ${id})
================================================================================
`);
