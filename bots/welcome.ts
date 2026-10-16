import { type Api, isFresh, MAX_AGE_MS, paginate, post } from "../bots.ts";

const MAX_PER_RUN = 10;

export default async (api: Api) => {
  const users = await api.users(500);
  const fresh = users.filter((u) => u.name.toLowerCase() !== api.botUsername.toLowerCase() && isFresh(u.created_at));
  if (!fresh.length) {
    console.log("No users in last 4h");
    return;
  }

  const since = Date.now() - MAX_AGE_MS;
  const mine = await paginate<{ body: string; created_at: string }>(
    api,
    (p) => `/c?usr=${api.botUsername}&sort=new&limit=100&p=${p}`,
    { until: (r) => new Date(r.created_at).getTime() < since },
  );
  const welcomed = new Set<string>();
  for (const p of mine)
    for (const m of (p.body ?? "").matchAll(/@(\w+)/g)) welcomed.add(m[1].toLowerCase());

  const todo = fresh.filter((u) => !welcomed.has(u.name.toLowerCase())).slice(0, MAX_PER_RUN);
  console.log(`Found ${todo.length} new users to welcome (${fresh.length} fresh, ${welcomed.size} already welcomed)`);
  if (todo.length === MAX_PER_RUN) console.warn(`Hit MAX_PER_RUN=${MAX_PER_RUN}; signup spike?`);

  let landed = 0;
  for (const u of todo) {
    const ok = await post(api, `welcome @${u.name}!`, `#welcome #bot`);
    if (ok) landed++;
    console.log(`${ok ? "welcomed" : "FAILED"} @${u.name}`);
  }
  // A run where every welcome bounced must not beat as finished.
  if (todo.length && !landed) throw new Error(`welcome: ${todo.length} welcomes attempted, none landed`);
};
