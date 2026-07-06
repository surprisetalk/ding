import { tagResponderBot } from "../bots.ts";

const HOUSES = [
  { name: "Gryffindor", emoji: "🦁", traits: "bravery, nerve, chivalry" },
  { name: "Hufflepuff", emoji: "🦡", traits: "patience, loyalty, fair play" },
  { name: "Ravenclaw", emoji: "🦅", traits: "wit, wisdom, creativity" },
  { name: "Slytherin", emoji: "🐍", traits: "ambition, cunning, resourcefulness" },
];

tagResponderBot({
  envPrefix: "SORTINGHAT",
  tag: "sortinghat",
  max: Infinity,
  respond: (p) => {
    const house = HOUSES[p.cid % HOUSES.length];
    return `The Sorting Hat has decided...\n\n${house.emoji} ${house.name}!\n\n"${house.traits}"`;
  },
});
