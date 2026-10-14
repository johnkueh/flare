// Draws the page's pixel icons from the grids below into public/img/*.svg.
// Run after editing a grid: node scripts/pixels.mjs
import { writeFileSync } from "node:fs";

const colors = {
  o: "#F97316", // orange
  d: "#B4500C", // deep orange
  y: "#FDB835", // flame yellow
  c: "#FDF3D1", // cream
  p: "#FDBA8C", // peach
};

const icons = {
  flame: [
    "....o.....",
    "....oo....",
    "...ooo....",
    "...oyoo...",
    "..ooyyo...",
    "..oyyyoo..",
    ".ooyccyo..",
    ".oyycyyoo.",
    ".oycccyyo.",
    ".oycccyyo.",
    ".ooycccyo.",
    "..oyyyyoo.",
    "...ooooo..",
  ],
  sync: [
    "ooooo........ooooo",
    "occco........occco",
    "occco.o.y.o..occco",
    "occco........occco",
    "occco........occco",
    "occco..o.y.o.occco",
    "occco........occco",
    "oocoo........oocoo",
    "ooooo........ooooo",
  ],
  auth: [
    "...oooooo...",
    "..oo....oo..",
    "..o......o..",
    "..o......o..",
    "..o......o..",
    "oooooooooooo",
    "oyyyyyyyyyyo",
    "oyyyyddyyyyo",
    "oyyyyddyyyyo",
    "oyyyyddyyyyo",
    "oyyyyyyyyyyo",
    "oooooooooooo",
  ],
  analytics: [
    "...........yo.",
    "...........yo.",
    "......yo...yo.",
    "......yo...yo.",
    "......yo...yo.",
    ".yo...yo...yo.",
    ".yo...yo...yo.",
    ".yo...yo...yo.",
    "dddddddddddddd",
  ],
  phone: [
    "ooooooo",
    "occccco",
    "ocyyyco",
    "occccco",
    "ocpppco",
    "occccco",
    "ocyyyco",
    "occccco",
    "occccco",
    "oooyooo",
    "ooooooo",
  ],
  storage: [
    ".oooooooooo.",
    "occcccccccco",
    "oooooooooooo",
    "oyyyyyyyyydo",
    "oyyyyyyyyyyo",
    "oooooooooooo",
    "oyyyyyyyyydo",
    "oyyyyyyyyyyo",
    "oooooooooooo",
    "oyyyyyyyyydo",
    "oyyyyyyyyyyo",
    ".oooooooooo.",
  ],
};

for (const [name, rows] of Object.entries(icons)) {
  const w = rows[0].length;
  const h = rows.length;
  const rects = [];
  rows.forEach((row, y) => {
    if (row.length !== w) throw new Error(`${name}: row ${y} is ${row.length} wide, not ${w}`);
    // One rect per run of the same colour.
    for (let x = 0; x < w; ) {
      const ch = row[x];
      let end = x + 1;
      while (end < w && row[end] === ch) end++;
      if (ch !== ".") {
        if (!colors[ch]) throw new Error(`${name}: unknown colour ${ch}`);
        rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${colors[ch]}"/>`);
      }
      x = end;
    }
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * 4}" height="${h * 4}" shape-rendering="crispEdges">${rects.join("")}</svg>\n`;
  writeFileSync(new URL(`../public/img/${name}.svg`, import.meta.url), svg);
}
