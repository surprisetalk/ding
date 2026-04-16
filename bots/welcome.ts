import { botInit, getJson, post } from "../bots.ts";

const MAX_PER_RUN = 10;

async function main() {
  const { apiUrl, auth, botUsername } = botInit("WELCOME");

  const [users, mine] = await Promise.all([
    getJson<{ name: string }[]>(`/us?limit=200`, auth, apiUrl).catch(() => []),
    getJson<{ body?: string }[]>(`/c?usr=${botUsername}&limit=200`, auth, apiUrl).catch(() => []),
  ]);

  const welcomed = new Set<string>();
  for (const p of mine)
    for (const m of (p.body ?? "").matchAll(/@(\w+)/g)) welcomed.add(m[1].toLowerCase());

  const todo = users
    .filter((u) => u.name.toLowerCase() !== botUsername.toLowerCase() && !welcomed.has(u.name.toLowerCase()))
    .reverse()
    .slice(0, MAX_PER_RUN);

  console.log(`Found ${todo.length} new users to welcome`);
  for (const u of todo) {
    const ok = await post(auth, apiUrl, `welcome @${u.name}!`, `#welcome #bot`);
    console.log(`${ok ? "welcomed" : "FAILED"} @${u.name}`);
  }
}

main();
