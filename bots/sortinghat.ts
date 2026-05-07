import { botInit, getAnsweredCids, getJson, isFresh, MAX_AGE_MS, reply } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("SORTINGHAT");

const HOUSES = [
  { name: "Gryffindor", emoji: "🦁", traits: "bravery, nerve, chivalry" },
  { name: "Hufflepuff", emoji: "🦡", traits: "patience, loyalty, fair play" },
  { name: "Ravenclaw", emoji: "🦅", traits: "wit, wisdom, creativity" },
  { name: "Slytherin", emoji: "🐍", traits: "ambition, cunning, resourcefulness" },
];

async function main() {
  const answeredCids = await getAnsweredCids(auth, botUsername, apiUrl, { since: Date.now() - MAX_AGE_MS });
  const posts = await getJson<{ cid: number; created_by: string; created_at: string }[]>(
    `/c?tag=sortinghat&sort=new&limit=20`,
    auth,
    apiUrl,
  );
  const unanswered = posts.filter((p) =>
    p.created_by !== botUsername && !answeredCids.has(p.cid) && isFresh(p.created_at)
  );

  for (const p of unanswered) {
    const house = HOUSES[p.cid % HOUSES.length];
    const body = `The Sorting Hat has decided...\n\n${house.emoji} ${house.name}!\n\n"${house.traits}"`;
    console.log(`Sorting cid=${p.cid} into ${house.name}`);
    await reply(auth, apiUrl, p.cid, body);
  }
}

main();
