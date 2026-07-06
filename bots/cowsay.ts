import { resolveTextContent, tagResponderBot } from "../bots.ts";

const ANIMALS: Record<string, string> = {
  cow: `        \\   ^__^
         \\  (oo)\\_______
            (__)\\       )\\/\\
                ||----w |
                ||     ||`,
  tux: `       \\
        \\
         .--.
        |o_o |
        |:_/ |
       //   \\ \\
      (|     | )
     /'\\_   _/\`\\
     \\___)=(___/`,
  stegosaurus: `        \\                             .       .
         \\                           / \`.   .' "
          \\                  .---.  <    > <    >  .---.
           \\                 |    \\  \\ - ~ ~ - /  /    |
         _____          ..-~             ~-..-~
        |     |   \\~~~\\.'                    \`./~~~/
       ---------   \\__/                        \\__/
      .'  O    \\     /               /       \\  "
     (_____,    \`._.'               |         }  \\/~~~/
      \`----.          /       }     |        /    \\__/
            \`-.      |       /      |       /      \`. ,~~|
                ~-.__|      /_ - ~ ^|      /- _      \`..-'
                     |     /        |     /     ~-.     \`-a]~-]~.
                     |_____|        |_____|         ~ - . _ _'-'`,
  dragon: `      \\                    / \\  //\\
       \\    |\\___/|      /   \\//  \\\\
            /0  0  \\__  /    //  | \\ \\
           /     /  \\/_/    //   |  \\  \\
           @_^_@'/   \\/_   //    |   \\   \\
           //_^_/     \\/_ //     |    \\    \\
        ( //) |        \\///      |     \\     \\
      ( / /) _|_ /   )  //       |      \\     _\\
    ( // /) '/,_ _ _/  ( ; -.    |    _ _\\.-~        .-~~~^-.
  (( / / )) ,-{        _      \`-.|.-~-.           .~         \`.
 (( // / ))  '/\\      /                 ~-. _ .-~      .-~^-.  \\
 (( /// ))      \`.   {            }                   /      \\  \\
  (( / ))     .----~-.\\        \\-'                 .~         \\  \`. \\^-.
             ///.----..>        \\             _ -~             \`.  ^-\`  ^-_
               ///-._ _ _ _ _ _ _}^ - - - - ~                     ~-- ,.-~`,
};

function wordWrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + " " + word : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function cowsay(text: string, animalKey: string): string {
  const lines = wordWrap(text.replace(/\n/g, " ").trim(), 36);
  const maxLen = Math.max(...lines.map((l) => l.length));
  const border = " " + "_".repeat(maxLen + 2);
  const bottom = " " + "-".repeat(maxLen + 2);

  let bubble: string;
  if (lines.length === 1)
    bubble = `${border}\n< ${lines[0].padEnd(maxLen)} >\n${bottom}`;
  else {
    const mid = lines.map((l, i) => {
      const pad = l.padEnd(maxLen);
      if (i === 0) return `/ ${pad} \\`;
      if (i === lines.length - 1) return `\\ ${pad} /`;
      return `| ${pad} |`;
    });
    bubble = `${border}\n${mid.join("\n")}\n${bottom}`;
  }

  return bubble + "\n" + (ANIMALS[animalKey] || ANIMALS.cow);
}

const ANIMAL_KEYS = ["cow", "tux", "stegosaurus", "dragon"];

tagResponderBot({
  envPrefix: "COWSAY",
  tag: "cowsay",
  max: 5,
  respond: async (p, { auth, apiUrl }) =>
    cowsay(await resolveTextContent(auth, apiUrl, p), ANIMAL_KEYS[p.cid % ANIMAL_KEYS.length]),
});
