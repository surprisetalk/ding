import type { Api } from "../bots.ts";

import bot_8ball from "./8ball.ts";
import album from "./album.ts";
import aquarium from "./aquarium.ts";
import arxiv from "./arxiv.ts";
import bestof from "./bestof.ts";
import { personas } from "./personas.ts";
import blogs from "./blogs.ts";
import bubbles from "./bubbles.ts";
import clipart from "./clipart.ts";
import codegolf from "./codegolf.ts";
import cowsay from "./cowsay.ts";
import critic from "./critic.ts";
import dice from "./dice.ts";
import dither from "./dither.ts";
import emojiglitch from "./emojiglitch.ts";
import estimation from "./estimation.ts";
import geometry from "./geometry.ts";
import grouch from "./grouch.ts";
import haiku from "./haiku.ts";
import hmmm from "./hmmm.ts";
import hn from "./hn.ts";
import hypebot from "./hypebot.ts";
import lobsters from "./lobsters.ts";
import lowpoly from "./lowpoly.ts";
import mathgif from "./mathgif.ts";
import museum from "./museum.ts";
import ooh from "./ooh.ts";
import pentameter from "./pentameter.ts";
import pixelsort from "./pixelsort.ts";
import reader from "./reader.ts";
import reddit from "./reddit.ts";
import remind from "./remind.ts";
import replyguy from "./replyguy.ts";
import smallweb from "./smallweb.ts";
import sortinghat from "./sortinghat.ts";
import stars from "./stars.ts";
import summoner from "./summoner.ts";
import tildes from "./tildes.ts";
import tldr from "./tldr.ts";
import upgoerfive from "./upgoerfive.ts";
import welcome from "./welcome.ts";
import youtube from "./youtube.ts";

// The fleet. Key = bot name = bots/<name>.ts = the BOT_<NAME>_EMAIL/_PASSWORD env prefix
// (uppercased). Static imports so Deno Deploy can bundle them; the cron in server.tsx and
// `deno task bot <name>` are the only callers.
export const BOTS: Record<string, (api: Api) => void | Promise<void>> = {
  ...personas,
  "8ball": bot_8ball,
  album,
  aquarium,
  arxiv,
  bestof,
  blogs,
  bubbles,
  clipart,
  codegolf,
  cowsay,
  critic,
  dice,
  dither,
  emojiglitch,
  estimation,
  geometry,
  grouch,
  haiku,
  hmmm,
  hn,
  hypebot,
  lobsters,
  lowpoly,
  mathgif,
  museum,
  ooh,
  pentameter,
  pixelsort,
  reader,
  reddit,
  remind,
  replyguy,
  smallweb,
  sortinghat,
  stars,
  summoner,
  tildes,
  tldr,
  upgoerfive,
  welcome,
  youtube,
};
