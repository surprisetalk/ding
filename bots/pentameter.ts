import { type Api, countSyllables, scanBot } from "../bots.ts";

const UNSTRESSED = new Set([
  "a",
  "an",
  "the",
  "and",
  "but",
  "or",
  "nor",
  "for",
  "yet",
  "so",
  "in",
  "on",
  "at",
  "to",
  "of",
  "by",
  "up",
  "as",
  "if",
  "is",
  "am",
  "are",
  "was",
  "were",
  "be",
  "been",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
  "may",
  "can",
  "will",
  "shall",
  "would",
  "could",
  "should",
  "might",
  "must",
  "it",
  "its",
  "he",
  "she",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "his",
  "our",
  "your",
  "their",
  "this",
  "that",
  "with",
  "from",
  "not",
  "no",
]);

function wordStress(word: string, syll: number): ("0" | "1")[] {
  const r: ("0" | "1")[] = new Array(syll).fill("0");
  if (syll === 2) {
    if (
      /^(a|be|de|re|in|un|dis|mis|pre|pro|con|com|ex|en|em)/.test(word) && !word.endsWith("ment") &&
      !word.endsWith("ness")
    ) { r[1] = "1"; } else { r[0] = "1"; }
  } else if (word.endsWith("tion") || word.endsWith("sion") || word.endsWith("ic") || word.endsWith("ical"))
    r[syll - 2] = "1";
  else
    r[Math.max(0, syll - 3)] = "1";
  return r;
}

function guessStress(text: string): ("0" | "1")[] {
  const words = text.toLowerCase().replace(/[^a-z\s'-]/g, "").split(/\s+/).filter(Boolean);
  const pattern: ("0" | "1")[] = [];
  for (const w of words) {
    const s = countSyllables(w);
    if (s === 1) pattern.push(UNSTRESSED.has(w) ? "0" : "1");
    else pattern.push(...wordStress(w, s));
  }
  return pattern;
}

function isIambicPentameter(text: string): boolean {
  const syllables = text.split(/\s+/).filter(Boolean).reduce((n, w) => n + countSyllables(w), 0);
  if (syllables < 9 || syllables > 11) return false;
  const stress = guessStress(text);
  if (stress.length < 10) return false;
  let correct = 0;
  for (let i = 0; i < 10; i++) if (stress[i] === "0101010101"[i]) correct++;
  return correct >= 7;
}

export default (api: Api) =>
  scanBot(api, {
    match: (text) =>
      isIambicPentameter(text)
        ? `methinks this be iambic pentameter!\n\n"${text}"\n\nda-DUM da-DUM da-DUM da-DUM da-DUM`
        : null,
  });
