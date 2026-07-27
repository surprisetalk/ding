import { type Api, dailyPostBot } from "../bots.ts";

export default (api: Api) =>
  dailyPostBot(api, {
    tags: "#math #animation #bot",
    make: async () => {
      const listRes = await fetch(
        "https://commons.wikimedia.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:Animations_of_mathematics&cmtype=file&cmlimit=500&format=json",
      );
      if (!listRes.ok) throw new Error(`Wikimedia category list: HTTP ${listRes.status}`);
      const members = (await listRes.json()).query?.categorymembers;
      if (!members?.length) throw new Error("No files found in category");

      const title = members[Math.floor(Date.now() / 86_400_000) % members.length].title as string;
      const infoRes = await fetch(
        `https://commons.wikimedia.org/w/api.php?action=query&titles=${
          encodeURIComponent(title)
        }&prop=imageinfo&iiprop=url&format=json`,
      );
      if (!infoRes.ok) throw new Error(`Wikimedia imageinfo: HTTP ${infoRes.status}`);
      const pages = (await infoRes.json()).query.pages;
      const fileUrl = pages[Object.keys(pages)[0]]?.imageinfo?.[0]?.url;
      if (!fileUrl) throw new Error(`No imageinfo URL for ${title}`);

      const cleanTitle = title.replace(/^File:/, "").replace(/\.[^.]+$/, "").replace(/_/g, " ");
      return `${cleanTitle}\n\n${fileUrl}\n\nhttps://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`;
    },
  });
