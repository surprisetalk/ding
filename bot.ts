// Manual single-bot runner: `deno task bot hn`. The fleet normally runs from the
// Deno.cron in server.tsx; this is the debugging path and talks real HTTP to DING_API_URL.

import { botInit } from "./bots.ts";
import { BOTS } from "./bots/mod.ts";

const name = Deno.args[0] ?? "";
const run = BOTS[name];
if (!run) {
  console.error(
    `${name ? `There is no bot named "${name}".` : "Which bot should I run?"}\n\n` +
      `    deno task bot <name>\n\n` +
      `Available bots:\n\n    ${Object.keys(BOTS).join(", ")}\n\n` +
      `Each needs BOT_${name ? name.toUpperCase() : "<NAME>"}_EMAIL and _PASSWORD in the environment.`,
  );
  Deno.exit(1);
}
await run(botInit(name.toUpperCase()));
