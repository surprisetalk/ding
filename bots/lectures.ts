import { type Api, dailyPostBot, getPostedUrls } from "../bots.ts";

export const LECTURES_PATH = new URL("./data/lectures.tsv", import.meta.url);
const PATH = "bots/data/lectures.tsv";
const COLUMNS = ["url", "speaker", "handle", "title", "tags", "fave"];

export type Lecture = {
  url: string;
  speaker: string;
  handle: string;
  title: string;
  tags: string[];
  fave: boolean;
};

export function parseLectures(text: string, path = PATH): Lecture[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const seen = new Map<string, number>();
  return lines.map((line, i) => {
    const n = i + 1;
    const c = line.split("\t");
    if (c.length !== COLUMNS.length) {
      throw new Error(
        `${path} line ${n}: expected ${COLUMNS.length} tab-separated columns (${
          COLUMNS.join(", ")
        }), got ${c.length}. Fix the row.`,
      );
    }
    const [url, speaker, handle, title, tags, fave] = c;
    if (!/^https?:\/\/\S+$/.test(url)) {
      throw new Error(
        `${path} line ${n}: url must start with http:// or https://, got ${JSON.stringify(url)}. Fix the row.`,
      );
    }
    if (!speaker || !title) throw new Error(`${path} line ${n}: speaker and title must not be empty. Fix the row.`);
    if (fave !== "" && fave !== "1")
      throw new Error(`${path} line ${n}: fave must be "" or "1", got ${JSON.stringify(fave)}.`);
    const first = seen.get(url);
    if (first) throw new Error(`${path} lines ${first} and ${n} share ${url}: delete one.`);
    seen.set(url, n);
    return { url, speaker, handle, title, tags: tags.split(" ").filter(Boolean), fave: fave === "1" };
  });
}

export const formatLecture = (l: Lecture) => `${l.speaker}${l.handle ? ` (@${l.handle})` : ""}: ${l.title} ${l.url}`;

// REVIEW: First unposted fave, else first unposted row, in file order. Alternative: random among unposted. It spreads topics but a re-run after a crash can post a different talk.
export const pickLecture = (rows: Lecture[], posted: Set<string>) =>
  rows.find((r) => r.fave && !posted.has(r.url)) ?? rows.find((r) => !posted.has(r.url));

export const unpostedCount = (rows: Lecture[], posted: Set<string>) => rows.filter((r) => !posted.has(r.url)).length;

export default (api: Api) =>
  dailyPostBot(api, {
    tags: "#lecture #bot",
    make: async () => {
      const rows = parseLectures(await Deno.readTextFile(LECTURES_PATH));
      // since: 0 reads the full history. The 30-day default would repost a talk after a month.
      const posted = await getPostedUrls(api, { since: 0 });
      const pick = pickLecture(rows, posted);
      if (!pick) throw new Error(`${api.botUsername}: all ${rows.length} rows in ${PATH} are posted. Add rows.`);
      return { body: formatLecture(pick), tags: ["#lecture", "#bot", ...pick.tags.map((t) => `#${t}`)].join(" ") };
    },
  });
