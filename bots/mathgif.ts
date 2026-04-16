import { botInit, getLastPostAge, post } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("MATHGIF");

async function main() {
  const ageMs = await getLastPostAge(auth, botUsername, apiUrl);
  console.log(`Last post was ${(ageMs / 3_600_000).toFixed(1)}h ago`);
  if (ageMs < 72_000_000) {
    console.log("Too soon, skipping");
    return;
  }

  const listRes = await fetch(
    "https://commons.wikimedia.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:Animations_of_mathematics&cmtype=file&cmlimit=500&format=json",
  );
  if (!listRes.ok) throw new Error(`Wikimedia category list: HTTP ${listRes.status}`);
  const listData = await listRes.json();
  const members = listData.query?.categorymembers;
  if (!members?.length) throw new Error("No files found in category");

  const dayIndex = Math.floor(Date.now() / 86_400_000) % members.length;
  const title = members[dayIndex].title as string;

  const infoRes = await fetch(
    `https://commons.wikimedia.org/w/api.php?action=query&titles=${
      encodeURIComponent(title)
    }&prop=imageinfo&iiprop=url&format=json`,
  );
  if (!infoRes.ok) throw new Error(`Wikimedia imageinfo: HTTP ${infoRes.status}`);
  const infoData = await infoRes.json();
  const pages = infoData.query.pages;
  const pageId = Object.keys(pages)[0];
  const fileUrl = pages[pageId]?.imageinfo?.[0]?.url;
  if (!fileUrl) throw new Error(`No imageinfo URL for ${title}`);

  const cleanTitle = title.replace(/^File:/, "").replace(/\.[^.]+$/, "").replace(/_/g, " ");
  const wikiUrl = `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`;
  const body = `${cleanTitle}\n\n${fileUrl}\n\n${wikiUrl}`;

  console.log(`Posting: ${cleanTitle}`);
  const ok = await post(auth, apiUrl, body, "#math #animation #bot");
  if (!ok) Deno.exit(1);
  console.log("Posted!");
}

main();
