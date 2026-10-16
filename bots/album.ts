import { type Api, dailyPostBot } from "../bots.ts";

// Every mbid answers 307 on coverartarchive.org front-500 (checked against MusicBrainz search). Re-run that check before adding one.
const ALBUMS: { title: string; artist: string; year: number; mbid: string }[] = [
  { title: "OK Computer", artist: "Radiohead", year: 1997, mbid: "b1392450-e666-3926-a536-22c65f834433" },
  {
    title: "The Dark Side of the Moon",
    artist: "Pink Floyd",
    year: 1973,
    mbid: "f5093c06-23e3-404f-aeaa-40f72885ee3a",
  },
  { title: "Kind of Blue", artist: "Miles Davis", year: 1959, mbid: "8e8a594f-2175-38c7-a871-abb68ec363e7" },
  { title: "Rumours", artist: "Fleetwood Mac", year: 1977, mbid: "416bb5e5-c7d1-3977-8fd7-7c9daf6c2be6" },
  { title: "Abbey Road", artist: "The Beatles", year: 1969, mbid: "9162580e-5df4-32de-80cc-f45a8d8a9b1d" },
  { title: "Nevermind", artist: "Nirvana", year: 1991, mbid: "1b022e01-4da6-387b-8658-8678046e4cef" },
  { title: "Purple Rain", artist: "Prince", year: 1984, mbid: "b93a7c47-a6d4-33f2-9034-53fdd991f4ba" },
  { title: "Thriller", artist: "Michael Jackson", year: 1982, mbid: "f32fab67-77dd-3937-addc-9062e28e4c37" },
  { title: "Blue", artist: "Joni Mitchell", year: 1971, mbid: "42d725fb-a8b7-388c-8866-3b02789af326" },
  { title: "Pet Sounds", artist: "The Beach Boys", year: 1966, mbid: "fdd96703-7b21-365e-bdea-38029fbeb84e" },
  {
    title: "In the Aeroplane Over the Sea",
    artist: "Neutral Milk Hotel",
    year: 1998,
    mbid: "8f310800-045b-3e12-8268-50b3d33a2267",
  },
  { title: "Loveless", artist: "My Bloody Valentine", year: 1991, mbid: "cb76227e-3ac0-3002-9a10-615a5b73cc59" },
  {
    title: "The Miseducation of Lauryn Hill",
    artist: "Lauryn Hill",
    year: 1998,
    mbid: "8691d12c-abd8-385c-b1eb-d841190124f7",
  },
  { title: "Blonde", artist: "Frank Ocean", year: 2016, mbid: "0da340a0-6ad7-4fc2-a272-6f94393a7831" },
  { title: "To Pimp a Butterfly", artist: "Kendrick Lamar", year: 2015, mbid: "d9103c72-3807-4378-9ce7-b6f3e8fdd547" },
  { title: "Remain in Light", artist: "Talking Heads", year: 1980, mbid: "f6b1b900-6108-32f0-abbd-2855af9151eb" },
  { title: "Horses", artist: "Patti Smith", year: 1975, mbid: "ff8f533c-3cb3-3877-9209-11f433edaad2" },
  {
    title: "The Velvet Underground & Nico",
    artist: "The Velvet Underground",
    year: 1967,
    mbid: "5cbd9d7b-597a-3c5e-bfd1-c2b364215560",
  },
  { title: "Hounds of Love", artist: "Kate Bush", year: 1985, mbid: "017f2a37-a78f-3578-9611-fa40408e5d90" },
  { title: "Wish You Were Here", artist: "Pink Floyd", year: 1975, mbid: "aec8c2eb-0639-436f-99db-9974781f241c" },
  { title: "What's Going On", artist: "Marvin Gaye", year: 1971, mbid: "c1fa4d2c-ec62-37d5-b01d-6df7f8fd2c90" },
  { title: "A Love Supreme", artist: "John Coltrane", year: 1965, mbid: "77cf47ba-58cd-3f3d-a5f9-79bf89860421" },
  { title: "London Calling", artist: "The Clash", year: 1979, mbid: "8d73e45e-7ca1-3cb4-ae28-6da76196c17c" },
  { title: "Astral Weeks", artist: "Van Morrison", year: 1968, mbid: "7d568f14-d86e-3584-97d0-c1824599de04" },
  {
    title: "The Rise and Fall of Ziggy Stardust",
    artist: "David Bowie",
    year: 1972,
    mbid: "6c9ae3dd-32ad-472c-96be-69d0a3536261",
  },
  { title: "Funeral", artist: "Arcade Fire", year: 2004, mbid: "05affa96-5959-32da-8d75-1c9eb985ca59" },
  { title: "Vespertine", artist: "Bjork", year: 2001, mbid: "271faeb3-fdd1-3ebb-80aa-97b3116e9341" },
  { title: "Disintegration", artist: "The Cure", year: 1989, mbid: "494bf606-d2f7-36d0-8340-eadad8601d2b" },
  { title: "Unknown Pleasures", artist: "Joy Division", year: 1979, mbid: "42352def-1aab-3000-b548-895ebd869cb6" },
  { title: "Dummy", artist: "Portishead", year: 1994, mbid: "48140466-cff6-3222-bd55-63c27e43190d" },
  { title: "Homogenic", artist: "Bjork", year: 1997, mbid: "810272e0-aef1-3d85-b2d3-e512e87fc38c" },
  { title: "Doolittle", artist: "Pixies", year: 1989, mbid: "1aa41b19-5a72-341b-bd91-4cf61d1dab6b" },
  {
    title: "My Beautiful Dark Twisted Fantasy",
    artist: "Kanye West",
    year: 2010,
    mbid: "3c2d6ffe-61b9-46e5-b935-3b8df01f900d",
  },
  { title: "Parallel Lines", artist: "Blondie", year: 1978, mbid: "0c1a4d70-5926-3ae8-aa25-466fe65639fe" },
  { title: "Innervisions", artist: "Stevie Wonder", year: 1973, mbid: "e626b377-74c5-3b97-8f16-8cef5e1c04ea" },
  { title: "Revolver", artist: "The Beatles", year: 1966, mbid: "72d15666-99a7-321e-b1f3-a3f8c09dff9f" },
  { title: "Is This It", artist: "The Strokes", year: 2001, mbid: "efea26d1-a016-30f6-b8e2-bc8c02336b0a" },
  { title: "The Queen Is Dead", artist: "The Smiths", year: 1986, mbid: "d8dde278-482c-3cc8-a530-fea70476f3a5" },
  { title: "Aquemini", artist: "OutKast", year: 1998, mbid: "eb655897-6cc5-3fc1-b9ed-5008eb80c682" },
  { title: "Paranoid", artist: "Black Sabbath", year: 1970, mbid: "cc053745-c447-3566-8f27-bed5438c9133" },
  {
    title: "Appetite for Destruction",
    artist: "Guns N' Roses",
    year: 1987,
    mbid: "a0b94d0a-210b-4b15-bd1d-93be2196c14a",
  },
  { title: "Illmatic", artist: "Nas", year: 1994, mbid: "28298e2c-4d70-3eed-a0f5-a3280c662b3d" },
  {
    title: "Enter the Wu-Tang (36 Chambers)",
    artist: "Wu-Tang Clan",
    year: 1993,
    mbid: "610fb60f-900a-3c42-ac7d-f6b6aa8035f9",
  },
  { title: "Achtung Baby", artist: "U2", year: 1991, mbid: "744c7a1b-ac79-35c4-bd92-7e2c6a24c8d8" },
  { title: "Graceland", artist: "Paul Simon", year: 1986, mbid: "19847822-1430-3380-9cf1-bc45545b34ac" },
  { title: "Voodoo", artist: "D'Angelo", year: 2000, mbid: "9605c075-c64c-366b-ad7f-ec98523fc162" },
  { title: "Demon Days", artist: "Gorillaz", year: 2005, mbid: "f959a46a-a136-3134-9412-6572b23fad95" },
  {
    title: "Selected Ambient Works 85-92",
    artist: "Aphex Twin",
    year: 1992,
    mbid: "6842c81d-ea77-3dfd-abf7-4323add3f4d4",
  },
  {
    title: "Songs in the Key of Life",
    artist: "Stevie Wonder",
    year: 1976,
    mbid: "ea88b09b-fd34-33cf-a3e5-25a3a2fb4c6f",
  },
  { title: "Closer", artist: "Joy Division", year: 1980, mbid: "852f9715-24b3-37d5-b8a5-456f5e19b41e" },
  { title: "The Bends", artist: "Radiohead", year: 1995, mbid: "b8048f24-c026-3398-b23a-b5e50716cbc7" },
  { title: "Loaded", artist: "The Velvet Underground", year: 1970, mbid: "4be9d91f-6ed7-34b8-aa5e-45be79819273" },
  {
    title: "Jagged Little Pill",
    artist: "Alanis Morissette",
    year: 1995,
    mbid: "ee3d18ed-d6a8-37c7-a964-41bbdb6d59f1",
  },
  { title: "Blood on the Tracks", artist: "Bob Dylan", year: 1975, mbid: "9c1b8072-eb1d-33d2-af8c-984d46e40902" },
  {
    title: "Sgt. Pepper's Lonely Hearts Club Band",
    artist: "The Beatles",
    year: 1967,
    mbid: "9f7a4c28-8fa2-3113-929c-c47a9f7982c3",
  },
  { title: "Madvillainy", artist: "Madvillain", year: 2004, mbid: "ab570ccb-b06b-3746-8147-4903163ba895" },
  {
    title: "The Low End Theory",
    artist: "A Tribe Called Quest",
    year: 1991,
    mbid: "c3733436-fcba-3c08-b082-d548df5c5139",
  },
  { title: "Melodrama", artist: "Lorde", year: 2017, mbid: "668e80e0-b35e-4471-9788-0a3d797fe42c" },
  { title: "Lemonade", artist: "Beyonce", year: 2016, mbid: "c1f22e07-7bdf-4a4f-8b50-7747c1091ef6" },
];

export default (api: Api) =>
  dailyPostBot(api, {
    tags: "#music #album #bot",
    make: async () => {
      const album = ALBUMS[Math.floor(Date.now() / 86_400_000) % ALBUMS.length];
      const r = await fetch(`https://coverartarchive.org/release-group/${album.mbid}/front-500`, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      const coverUrl = r.headers.get("location");
      if (!coverUrl) throw new Error(`No cover art for ${album.title} (${album.mbid}): ${r.status}`);
      return `${album.title} (${album.year})\n\n${album.artist}\n\n${coverUrl}`;
    },
  });
