// Manual single-bot runner: `deno task bot hn`. The fleet normally runs from the Deno.cron
// in server.tsx; this is the debugging path. It goes straight at the database like the cron
// does, so it needs DATABASE_URL (and the server's other env) rather than DING_API_URL.

import { BOTS } from "./bots/mod.ts";
import { botApi } from "./server.tsx";

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
const api = await botApi(name.toUpperCase());
if (!api) {
  console.error(`Set BOT_${name.toUpperCase()}_EMAIL and BOT_${name.toUpperCase()}_PASSWORD in the environment.`);
  Deno.exit(1);
}
await run(api);
