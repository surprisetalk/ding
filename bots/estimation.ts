// Daily Fermi estimation bot for ding
// Posts a question, reveals answer next day with closest guesser

const DING_API_URL = Deno.env.get("DING_API_URL") || "https://ding.bar";
const BOT_EMAIL = Deno.env.get("BOT_ESTIMATION_EMAIL") || "";
const BOT_PASSWORD = Deno.env.get("BOT_ESTIMATION_PASSWORD") || "";

const auth = btoa(`${BOT_EMAIL}:${BOT_PASSWORD}`);
const BOT_USERNAME = BOT_EMAIL.split("@")[0].replace(/-/g, "_");

interface Question {
  q: string;
  a: number;
  unit: string;
}

const QUESTIONS: Question[] = [
  { q: "How many golf balls can fit in a school bus?", a: 500000, unit: "golf balls" },
  { q: "How many piano tuners are there in Chicago?", a: 225, unit: "piano tuners" },
  { q: "How many gas stations are there in the United States?", a: 150000, unit: "gas stations" },
  { q: "How many tennis balls can fit in this room (a 10m×10m×3m room)?", a: 1500000, unit: "tennis balls" },
  { q: "How many hot dogs are consumed at US baseball stadiums per year?", a: 21000000, unit: "hot dogs" },
  { q: "How many words does the average person speak per day?", a: 16000, unit: "words" },
  { q: "How many commercial flights take off worldwide each day?", a: 100000, unit: "flights" },
  { q: "How heavy is all the air in an average classroom (kg)?", a: 250, unit: "kg" },
  { q: "How many people are airborne at any given moment?", a: 1250000, unit: "people" },
  { q: "How many gallons of paint would it take to paint all the houses in the US?", a: 7000000000, unit: "gallons" },
  { q: "How many ping pong balls would fill the Taj Mahal?", a: 36000000000, unit: "ping pong balls" },
  { q: "How many drops of water are in Lake Michigan?", a: 4e21, unit: "drops" },
  { q: "How many barbers are there in the United States?", a: 700000, unit: "barbers" },
  { q: "How many jelly beans can fit in a 1-gallon jar?", a: 930, unit: "jelly beans" },
  { q: "How many dimples are on a standard golf ball?", a: 336, unit: "dimples" },
  { q: "How many grains of sand are on a typical beach (1km long)?", a: 1e17, unit: "grains" },
  { q: "How many calories does the world consume per day?", a: 1.5e13, unit: "calories" },
  { q: "How many active cell phones are there in the world?", a: 5400000000, unit: "phones" },
  { q: "How many different species of insects have been discovered?", a: 1000000, unit: "species" },
  { q: "How many times does the average human heart beat in a lifetime?", a: 2500000000, unit: "beats" },
  { q: "How many emails are sent worldwide per day?", a: 333000000000, unit: "emails" },
  { q: "How many cars are scrapped in the US each year?", a: 12000000, unit: "cars" },
  { q: "How many miles of paved road are there in the US?", a: 4200000, unit: "miles" },
  { q: "How far does light travel in one nanosecond (in feet)?", a: 1, unit: "foot" },
  { q: "How many soccer balls would it take to fill the Moon?", a: 1.3e24, unit: "soccer balls" },
  { q: "How many trees are there on Earth?", a: 3000000000000, unit: "trees" },
  { q: "How many transistors are in a modern smartphone chip?", a: 15000000000, unit: "transistors" },
  { q: "How many bacteria live on a single human hand?", a: 1500000, unit: "bacteria" },
  { q: "How many liters of blood does the average human heart pump per day?", a: 7570, unit: "liters" },
  { q: "How many books have been published in all of human history?", a: 130000000, unit: "books" },
  { q: "How many breaths does the average person take in a year?", a: 7900000, unit: "breaths" },
  { q: "How many neurons are in the human brain?", a: 86000000000, unit: "neurons" },
  { q: "How many cups of coffee are consumed worldwide per day?", a: 2250000000, unit: "cups" },
  { q: "How many photographs are taken per day globally?", a: 1400000000, unit: "photos" },
  { q: "How many Olympic-sized swimming pools would the Amazon River fill per day?", a: 58000, unit: "pools" },
  { q: "How many Earths could fit inside the Sun?", a: 1300000, unit: "Earths" },
  { q: "How many shipping containers are in transit across the ocean right now?", a: 6000000, unit: "containers" },
  { q: "How many songs are on Spotify?", a: 100000000, unit: "songs" },
  { q: "How many blades of grass on a football field?", a: 2000000000, unit: "blades" },
  { q: "How many megabytes of data does the average person generate per day?", a: 1700, unit: "megabytes" },
  { q: "How many satellites are currently orbiting Earth?", a: 10000, unit: "satellites" },
  { q: "How many bananas are consumed worldwide per year?", a: 100000000000, unit: "bananas" },
  { q: "How many stairs are in the Empire State Building?", a: 1576, unit: "stairs" },
  { q: "How many hairs are on a human head?", a: 100000, unit: "hairs" },
  { q: "How many different pizza combinations can a typical pizzeria make?", a: 34000000, unit: "combinations" },
  { q: "How many atoms are in a grain of sand?", a: 5e19, unit: "atoms" },
  { q: "How many hours of video are uploaded to YouTube per minute?", a: 500, unit: "hours" },
  { q: "How many earthquakes occur on Earth per year?", a: 500000, unit: "earthquakes" },
  { q: "How many paper clips laid end to end would span the Golden Gate Bridge?", a: 57000, unit: "paper clips" },
  { q: "How many ice cream cones are sold in the US per year?", a: 1500000000, unit: "cones" },
];

function parseNumber(s: string): number | null {
  const cleaned = s.replace(/,/g, "").trim();
  // Scientific notation: 1e6, 1E6, 1x10^6, 1×10^6
  const sciMatch = cleaned.match(/^([\d.]+)\s*[xX×]\s*10\s*\^\s*(\d+)$/);
  if (sciMatch) return parseFloat(sciMatch[1]) * Math.pow(10, +sciMatch[2]);
  // Suffixes: 1k, 1m, 1b, 1t
  const suffixMatch = cleaned.match(/^([\d.]+)\s*([kmbt])$/i);
  if (suffixMatch) {
    const mult: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
    return parseFloat(suffixMatch[1]) * mult[suffixMatch[2].toLowerCase()];
  }
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// Log-distance: how many orders of magnitude apart
function logDist(guess: number, actual: number): number {
  if (guess <= 0 || actual <= 0) return Infinity;
  return Math.abs(Math.log10(guess) - Math.log10(actual));
}

async function getRecentPosts(limit = 5): Promise<any[]> {
  const res = await fetch(`${DING_API_URL}/c?usr=${BOT_USERNAME}&limit=${limit}`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch recent posts: HTTP ${res.status} ${await res.text()}`);
  return await res.json();
}

async function getPost(cid: number): Promise<any> {
  const res = await fetch(`${DING_API_URL}/c/${cid}`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch post cid=${cid}: HTTP ${res.status} ${await res.text()}`);
  const items = await res.json();
  return items[0] || null;
}

async function reply(parentCid: number, body: string): Promise<boolean> {
  const formData = new FormData();
  formData.append("body", body);
  const res = await fetch(`${DING_API_URL}/c/${parentCid}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: formData,
  });
  return res.ok;
}

async function main() {
  if (!BOT_EMAIL || !BOT_PASSWORD) {
    console.error("Missing BOT_ESTIMATION_EMAIL or BOT_ESTIMATION_PASSWORD");
    Deno.exit(1);
  }

  const posts = await getRecentPosts(5);
  const lastPost = posts[0];
  const lastAge = lastPost ? Date.now() - new Date(lastPost.created_at).getTime() : Infinity;
  const lastAgeHours = lastAge / 3_600_000;

  // Phase 2: Reveal yesterday's answer if it's been 20+ hours but less than 48
  // (after 48h we skip reveal and just post a new question)
  let revealed = false;
  if (lastPost && lastAgeHours >= 20 && lastAgeHours < 48) {
    const dayIndex = Math.floor(new Date(lastPost.created_at).getTime() / 86_400_000) % QUESTIONS.length;
    const question = QUESTIONS[dayIndex];

    const post = await getPost(lastPost.cid);
    if (post) {
      const botReplies = (post.child_comments || []).filter(
        (c: any) => c.created_by === BOT_USERNAME,
      );
      if (!botReplies.length) {
        const playerReplies = (post.child_comments || []).filter((c: any) => c.created_by !== BOT_USERNAME);
        const guesses = playerReplies
          .map((c: any) => {
            const n = parseNumber(c.body);
            return n !== null ? { user: c.created_by, guess: n, dist: logDist(n, question.a) } : null;
          })
          .filter(Boolean) as { user: string; guess: number; dist: number }[];
        console.log(`Parsed ${guesses.length}/${playerReplies.length} guesses`);

        guesses.sort((a, b) => a.dist - b.dist);
        const winner = guesses[0];

        let reveal = `Answer: ${question.a.toLocaleString()} ${question.unit}`;
        if (winner) {
          reveal += `\n\nClosest guess: @${winner.user} with ${winner.guess.toLocaleString()} (${winner.dist < 0.5 ? "within half an order of magnitude!" : `${winner.dist.toFixed(1)} orders of magnitude off`})`;
        }
        if (guesses.length > 1) {
          reveal += `\n\n${guesses.length} total guesses`;
        }

        console.log(`Revealing answer for cid=${lastPost.cid}`);
        if (!await reply(lastPost.cid, reveal)) {
          console.error(`Failed to post reveal for cid=${lastPost.cid}`);
        }
        revealed = true;
      }
    }
  }

  // Phase 1: Post new question — but not on the same run as a reveal
  // (give players time to see the answer before a new question drops)
  if (!revealed && lastAgeHours >= 20) {
    const dayIndex = Math.floor(Date.now() / 86_400_000) % QUESTIONS.length;
    const question = QUESTIONS[dayIndex];
    const dayNum = Math.floor(Date.now() / 86_400_000) - 20818;

    const body = `Estimation #${dayNum}\n\n${question.q}\n\nReply with your best guess (just a number)!`;
    console.log(`Posting: Estimation #${dayNum}`);

    const formData = new FormData();
    formData.append("body", body);
    formData.append("tags", "#estimation #game #bot");

    const res = await fetch(`${DING_API_URL}/c`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      body: formData,
    });
    if (!res.ok) {
      console.error(`Failed to post: HTTP ${res.status} ${await res.text()}`);
      Deno.exit(1);
    }
    console.log("Posted!");
  } else {
    console.log(`Last post was ${lastAgeHours.toFixed(1)}h ago, skipping new question`);
  }
}

main();
