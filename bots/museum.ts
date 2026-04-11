import { botInit, getLastPostAge, post } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("MUSEUM");

async function fetchArtwork(): Promise<{ title: string; creator: string; imageUrl: string; url: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const skip = Math.floor(Math.random() * (attempt === 0 ? 5000 : 1000));
    const res = await fetch(`https://openaccess-api.clevelandart.org/api/artworks/?has_image=1&cc0=1&type=Painting&limit=1&skip=${skip}`);
    if (!res.ok) throw new Error(`Cleveland API: HTTP ${res.status}`);
    const data = await res.json();
    const artwork = data.data?.[0];
    if (!artwork?.images?.web?.url) continue;
    return {
      title: artwork.title || "Untitled",
      creator: artwork.creators?.[0]?.description || "Unknown artist",
      imageUrl: artwork.images.web.url,
      url: artwork.url || `https://www.clevelandart.org/art/${artwork.id}`,
    };
  }
  return null;
}

async function main() {
  const ageMs = await getLastPostAge(auth, botUsername, apiUrl);
  console.log(`Last post was ${(ageMs / 3_600_000).toFixed(1)}h ago`);
  if (ageMs < 14_400_000) {
    console.log("Too soon, skipping");
    return;
  }

  const artwork = await fetchArtwork();
  if (!artwork) {
    console.error("Failed to fetch artwork after retries");
    Deno.exit(1);
  }

  const body = `${artwork.title}\n\n${artwork.creator}\n\n${artwork.imageUrl}\n\n${artwork.url}`;
  console.log(`Posting: ${artwork.title}`);
  const ok = await post(auth, apiUrl, body, "#art #museum #bot");
  if (!ok) Deno.exit(1);
  console.log("Posted!");
}

main();
