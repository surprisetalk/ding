import { type Api, countSyllables, scanBot } from "../bots.ts";

function findHaiku(text: string): [string, string, string] | null {
  const words = text.split(/\s+/).filter(Boolean);
  const target = [5, 7, 5];
  const lines: string[][] = [[], [], []];
  let lineIdx = 0, syllables = 0;

  for (const word of words) {
    if (lineIdx > 2) return null;
    syllables += countSyllables(word);
    lines[lineIdx].push(word);
    if (syllables === target[lineIdx]) {
      lineIdx++;
      syllables = 0;
    } else if (syllables > target[lineIdx]) { return null; }
  }

  if (lineIdx !== 3) return null;
  return [lines[0].join(" "), lines[1].join(" "), lines[2].join(" ")];
}

export default (api: Api) =>
  scanBot(api, {
    match: (text) => {
      const h = findHaiku(text);
      return h && `a haiku, perhaps?\n\n${h[0]}\n${h[1]}\n${h[2]}`;
    },
  });
