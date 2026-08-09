import { type Api, dailyPostBot } from "../bots.ts";

export default (api: Api) =>
  dailyPostBot(api, {
    tags: "#art #museum #bot",
    minGapMs: 14_400_000,
    make: async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const skip = Math.floor(Math.random() * (attempt === 0 ? 5000 : 1000));
        const res = await fetch(
          `https://openaccess-api.clevelandart.org/api/artworks/?has_image=1&cc0=1&type=Painting&limit=1&skip=${skip}`,
        );
        if (!res.ok) throw new Error(`Cleveland API: HTTP ${res.status}`);
        const a = (await res.json()).data?.[0];
        if (!a?.images?.web?.url) continue;
        const url = a.url || `https://www.clevelandart.org/art/${a.id}`;
        return `${a.title || "Untitled"}\n\n${
          a.creators?.[0]?.description || "Unknown artist"
        }\n\n${a.images.web.url}\n\n${url}`;
      }
      // Never Deno.exit here — under the in-server cron that kills the whole isolate.
      throw new Error("Cleveland API returned no artwork with an image after 2 attempts");
    },
  });
