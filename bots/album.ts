import { botInit, getLastPostAge, post } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("ALBUM");

const ALBUMS: { title: string; artist: string; year: number; mbid: string }[] = [
  { title: "OK Computer", artist: "Radiohead", year: 1997, mbid: "b1392450-e666-3926-a536-22c65f834433" },
  { title: "The Dark Side of the Moon", artist: "Pink Floyd", year: 1973, mbid: "f5093c06-23e3-404f-aeaa-40f72885ee3a" },
  { title: "Kind of Blue", artist: "Miles Davis", year: 1959, mbid: "4e3d3454-b43e-31e1-93e8-4a4f998bb42e" },
  { title: "Rumours", artist: "Fleetwood Mac", year: 1977, mbid: "fc060abd-c5cf-35c0-a581-9d8bab406595" },
  { title: "Abbey Road", artist: "The Beatles", year: 1969, mbid: "fbe1e90b-e706-3563-b927-affc51de20c5" },
  { title: "Nevermind", artist: "Nirvana", year: 1991, mbid: "f20c3088-e4c4-36c4-a0d2-0e340db9e23d" },
  { title: "Purple Rain", artist: "Prince", year: 1984, mbid: "f891d87f-1205-45f0-8e06-b4bab10e3702" },
  { title: "Thriller", artist: "Michael Jackson", year: 1982, mbid: "e8d4a397-7c3b-34f8-ac0b-27543f4b7397" },
  { title: "Blue", artist: "Joni Mitchell", year: 1971, mbid: "a3775543-6f5d-3416-8207-63f71e7be6a7" },
  { title: "Pet Sounds", artist: "The Beach Boys", year: 1966, mbid: "b3b43806-b817-4a82-835a-89d2ee4dc081" },
  { title: "In the Aeroplane Over the Sea", artist: "Neutral Milk Hotel", year: 1998, mbid: "5dc069d8-2894-35f3-854a-0e3ea93a40cb" },
  { title: "Loveless", artist: "My Bloody Valentine", year: 1991, mbid: "b1f53282-380a-30b5-b8c2-24c555e94f27" },
  { title: "The Miseducation of Lauryn Hill", artist: "Lauryn Hill", year: 1998, mbid: "6b46a16e-9ccf-326b-939a-4de498340ca3" },
  { title: "Blonde", artist: "Frank Ocean", year: 2016, mbid: "0da811a2-5254-4c43-9778-ed1e00e3b7cc" },
  { title: "To Pimp a Butterfly", artist: "Kendrick Lamar", year: 2015, mbid: "39e267ac-2e97-4e42-8cca-4ac9e1788e07" },
  { title: "Remain in Light", artist: "Talking Heads", year: 1980, mbid: "17bda3e8-a8a6-34c3-8b64-e7b0a3e90b26" },
  { title: "Horses", artist: "Patti Smith", year: 1975, mbid: "3ab6d0e4-5a84-3775-b941-36f78b90abb1" },
  { title: "The Velvet Underground & Nico", artist: "The Velvet Underground", year: 1967, mbid: "b8d10187-92d7-37b5-86fb-a4acbc468901" },
  { title: "Hounds of Love", artist: "Kate Bush", year: 1985, mbid: "be84f49d-1741-33cc-9273-f3a07f9a79ea" },
  { title: "Wish You Were Here", artist: "Pink Floyd", year: 1975, mbid: "fe04dc80-4caa-341a-a30a-0a6d0760dfc4" },
  { title: "What's Going On", artist: "Marvin Gaye", year: 1971, mbid: "f0b38e69-24e0-3763-834f-7ba1ba943966" },
  { title: "A Love Supreme", artist: "John Coltrane", year: 1965, mbid: "1e0b9557-ce8f-38e0-b719-c8011ee82498" },
  { title: "London Calling", artist: "The Clash", year: 1979, mbid: "b8fe5f4b-1508-30e5-8708-b75e5d393fcd" },
  { title: "Astral Weeks", artist: "Van Morrison", year: 1968, mbid: "0f6be4bf-b0a0-3794-8df3-db1d8bcda3bf" },
  { title: "The Rise and Fall of Ziggy Stardust", artist: "David Bowie", year: 1972, mbid: "5e82ecea-74c4-380d-b0e4-0c77604a4f70" },
  { title: "Funeral", artist: "Arcade Fire", year: 2004, mbid: "1b9b3927-4485-384d-a498-9e3d3b380e5a" },
  { title: "Vespertine", artist: "Bjork", year: 2001, mbid: "d3eb6058-3c21-34ee-8522-5765af3f0146" },
  { title: "Disintegration", artist: "The Cure", year: 1989, mbid: "c2e7c41e-4e83-3d04-a610-79ce59c0cf70" },
  { title: "Unknown Pleasures", artist: "Joy Division", year: 1979, mbid: "8b65e862-edb3-3a10-b7e2-2e397e471937" },
  { title: "Dummy", artist: "Portishead", year: 1994, mbid: "8b56aa52-a575-30ad-98f4-8e26b2f3be5e" },
  { title: "Homogenic", artist: "Bjork", year: 1997, mbid: "7c553e3a-5ac3-3ee7-864e-41a6e7344baf" },
  { title: "Doolittle", artist: "Pixies", year: 1989, mbid: "6eaf4ef5-9e8e-33f2-98a2-2a7a8ed3e280" },
  { title: "My Beautiful Dark Twisted Fantasy", artist: "Kanye West", year: 2010, mbid: "03117bf9-37c3-409a-9e0b-5e7c6aaae6db" },
  { title: "Parallel Lines", artist: "Blondie", year: 1978, mbid: "9ca3c9cf-08c7-3a0f-8dc3-618f8fc4a8f3" },
  { title: "Innervisions", artist: "Stevie Wonder", year: 1973, mbid: "6dfa5e18-05e6-4c5b-b96e-2e30f54f53fc" },
  { title: "Revolver", artist: "The Beatles", year: 1966, mbid: "dab21558-0a49-40b8-a74f-2b3e1e81d880" },
  { title: "Is This It", artist: "The Strokes", year: 2001, mbid: "d0cf7b71-c7be-3e93-aecc-9e3c9f59df5f" },
  { title: "The Queen Is Dead", artist: "The Smiths", year: 1986, mbid: "6586a2ee-a2d2-32e1-80f6-2bea4e15c421" },
  { title: "Aquemini", artist: "OutKast", year: 1998, mbid: "ad460e08-348a-3d63-85a5-7a30e79920e2" },
  { title: "Paranoid", artist: "Black Sabbath", year: 1970, mbid: "aa8c2900-1609-3a00-b21b-efab53e0f582" },
  { title: "Appetite for Destruction", artist: "Guns N' Roses", year: 1987, mbid: "73488e44-5765-3338-922f-0ae7e4e111c1" },
  { title: "Illmatic", artist: "Nas", year: 1994, mbid: "e0d7f5b6-c1ca-3d2a-b19d-db8a6dac0ce0" },
  { title: "Enter the Wu-Tang (36 Chambers)", artist: "Wu-Tang Clan", year: 1993, mbid: "0da9e9a4-3a2c-3a0e-ba1b-71d80c277b8e" },
  { title: "Achtung Baby", artist: "U2", year: 1991, mbid: "b05da35b-35b8-3a4b-8d73-5afb03f8f3a0" },
  { title: "Graceland", artist: "Paul Simon", year: 1986, mbid: "c7f67a42-1733-3b1f-9850-cb1c026a5db4" },
  { title: "Voodoo", artist: "D'Angelo", year: 2000, mbid: "97f17fee-80e3-3969-a42e-a4b699a4e9b7" },
  { title: "Demon Days", artist: "Gorillaz", year: 2005, mbid: "16041a6c-e846-35d0-9b3f-77e22a0e06ce" },
  { title: "Selected Ambient Works 85-92", artist: "Aphex Twin", year: 1992, mbid: "cf7e573c-37aa-3634-bfe9-00bf51f4c474" },
  { title: "Songs in the Key of Life", artist: "Stevie Wonder", year: 1976, mbid: "76b5eb72-bea5-3a38-af0c-b8b2a8cc4b07" },
  { title: "Closer", artist: "Joy Division", year: 1980, mbid: "3a11f18c-30e3-3ed1-887f-e0d649f6a80f" },
  { title: "The Bends", artist: "Radiohead", year: 1995, mbid: "70664047-2545-3e37-9a2e-0cefd3e0c30f" },
  { title: "Loaded", artist: "The Velvet Underground", year: 1970, mbid: "05451e77-4ef1-381e-a594-ef8c73377ca6" },
  { title: "Jagged Little Pill", artist: "Alanis Morissette", year: 1995, mbid: "c53cbbb4-2867-3e9e-acf5-5f4dff5a9baa" },
  { title: "Blood on the Tracks", artist: "Bob Dylan", year: 1975, mbid: "6f5077a5-3dba-36c4-a715-57e32494aaef" },
  { title: "Sgt. Pepper's Lonely Hearts Club Band", artist: "The Beatles", year: 1967, mbid: "b86c6fba-c82d-3785-b9a8-72a3acefc619" },
  { title: "Madvillainy", artist: "Madvillain", year: 2004, mbid: "cf688352-f26a-3e6a-80b5-8f1a9f89b3e4" },
  { title: "The Low End Theory", artist: "A Tribe Called Quest", year: 1991, mbid: "59e15ec0-0cf7-3808-8f2d-9d7a2e6a0d56" },
  { title: "Melodrama", artist: "Lorde", year: 2017, mbid: "48980dc0-6d74-4759-b9e4-6faae5851c63" },
  { title: "Lemonade", artist: "Beyonce", year: 2016, mbid: "040a1df7-7e1d-4d3a-8d2a-9565baabd71c" },
];

async function main() {
  const ageMs = await getLastPostAge(auth, botUsername, apiUrl);
  console.log(`Last post was ${(ageMs / 3_600_000).toFixed(1)}h ago`);
  if (ageMs < 72_000_000) {
    console.log("Too soon, skipping");
    return;
  }

  const dayIndex = Math.floor(Date.now() / 86_400_000) % ALBUMS.length;
  const album = ALBUMS[dayIndex];
  let coverUrl = `https://coverartarchive.org/release/${album.mbid}/front-500`;
  try {
    const r = await fetch(coverUrl, { redirect: "manual" });
    const loc = r.headers.get("location");
    if (loc) coverUrl = loc;
  } catch { /* fall back to original URL */ }
  const body = `${album.title} (${album.year})\n\n${album.artist}\n\n${coverUrl}`;

  console.log(`Posting: ${album.title} by ${album.artist}`);
  const ok = await post(auth, apiUrl, body, "#music #album #bot");
  if (!ok) Deno.exit(1);
  console.log("Posted!");
}

main();
