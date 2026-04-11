import { botInit, getAnsweredCids, reply } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("SORTINGHAT");

const HOUSES = [
  { name: "Gryffindor", emoji: "🦁", traits: "bravery, nerve, chivalry" },
  { name: "Hufflepuff", emoji: "🦡", traits: "patience, loyalty, fair play" },
  { name: "Ravenclaw", emoji: "🦅", traits: "wit, wisdom, creativity" },
  { name: "Slytherin", emoji: "🐍", traits: "ambition, cunning, resourcefulness" },
];

async function main() {
  const answeredCids = await getAnsweredCids(auth, botUsername, apiUrl);

  const res = await fetch(`${apiUrl}/c?tag=sortinghat&sort=new&limit=20`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch #sortinghat posts: ${res.status}`);
  const posts: { cid: number; created_by: string }[] = await res.json();

  const unanswered = posts.filter((p) => p.created_by !== botUsername && !answeredCids.has(p.cid));

  for (const p of unanswered) {
    const house = HOUSES[p.cid % HOUSES.length];
    const body = `The Sorting Hat has decided...\n\n${house.emoji} ${house.name}!\n\n"${house.traits}"`;
    console.log(`Sorting cid=${p.cid} into ${house.name}`);
    await reply(auth, apiUrl, p.cid, body);
  }
}

main();
