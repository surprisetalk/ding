import { botInit, post } from "../bots.ts";

const MAX_PER_RUN = 10;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("WELCOME");

  const [users, mine] = await Promise.all([
    fetch(`${apiUrl}/us?limit=200`, {
      headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
    }).then((r) => r.ok ? r.json() : []),
    fetch(`${apiUrl}/c?usr=${botUsername}&limit=200`, {
      headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
    }).then((r) => r.ok ? r.json() : []),
  ]);

  const welcomed = new Set<string>();
  for (const p of mine as { usrs?: string[] }[])
    for (const u of p.usrs ?? []) welcomed.add(u.toLowerCase());

  const todo = (users as { name: string }[])
    .filter((u) => u.name.toLowerCase() !== botUsername.toLowerCase() && !welcomed.has(u.name.toLowerCase()))
    .reverse()
    .slice(0, MAX_PER_RUN);

  console.log(`Found ${todo.length} new users to welcome`);
  for (const u of todo) {
    const ok = await post(auth, apiUrl, `welcome @${u.name}!`, `#welcome #bot @${u.name}`);
    console.log(`${ok ? "welcomed" : "FAILED"} @${u.name}`);
  }
}

main();
