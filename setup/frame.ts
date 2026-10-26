// What every setup screen shares (ADR-014, ADR-024): the pixel field behind
// it, the status bar along the bottom with the step and the clock, and the
// shell-prompt heading, which types itself out in about 300 ms. Reduce
// motion skips the typing.

import { clock, h } from "../launcher/dom.ts";

const NS = "http://www.w3.org/2000/svg";

// The pixel field from the canvas (board "Piece · pixel field"): 18 px
// blocks on a 24 px grid, 80 across and 45 down, in four shades of the
// theme's accent, thicker at the sides and the bottom. Each row is a run of
// cells: a digit is a block of that shade, and a letter is that many empty
// cells (a is one, z is 26).
const FIELD =
  "j11a1d11y1o1g1f1b2/1c1zzd1c1d1/i1h11zr1a1c1a1a1/b11b1h1zv1k2/1b2f1zzd1b1a1c1/11c11b1h1zz1c1a1/" +
  "f1a111a1zza1i1/11a11i1zzd1d2a1/e1a1b11zv1h1d2/1i1p1zj1d1a1g1/a2d11a1b1a11zw11h221a2/" +
  "12b2d1a1g1zp1i11a112a1/a1a1c1b1zw1g1d1/d211h1zs1e1c1a1b2a1/1zzm1e1a12c2/a2c21a1c1d1zy1a1f1/" +
  "2d2k11zq11c11e1c2/a1211111c1b1zu1k1a2b1/11b2a2b2zzi2a2c1a2/b2e11c1d1zza11a2a122/2c21f1zv11e1d22a2b1/" +
  "2b212b112zw1g2f22/3b2d2e1a1zw1i21a2/b1c21b1zw1a111b11f22222/2c12f1e1m1zj21c2a1b3/" +
  "1d2a21e1b1zr1c1d1121a1b2/2a3b2a1a12a1f1zr1f22a1d2/3i1a1zzb21a2a2b22b1/312a2b21a1b2e1zp1c1a21b2d22/" +
  "33a222b2a2g1zp2f1a2a12232133/131b2211121zw1b1e1b2121134/11c1a11b1a2b1b1zo1f211a13b1111/" +
  "2122223a2a1a2a12c1b2l1a11c1e11a11c11d12b2a211d12a2/1111131h2b12b1o111g1b1b11a2a21d1b323b3b22a2/" +
  "2323213223a2t12c1b1a2b1a21b12a1a1a22b2211f31233311/" +
  "2222b231a222212a3a1b2b11c12i11b1c1a1c122a12a22a2d33231b124/" +
  "42212223211123212b2l2c1222b21c1b2a11b12122d12a311b13a1a44/" +
  "3321a1f1c1a3a2b22c1b1112b2c122h2c1g312a112334314321/" +
  "243414a131a1a1a122d221a2a22b1a2b2a2a21a213c12b1121a312a22b1c142412311/" +
  "442134223314b43a11b1a1d123b3c1232e22a1a22c2322123313312b234214124/" +
  "2223233131124c32213a12a2a2213a2231111c22a2c222a3a3213332313412433a44232433/" +
  "34243222234423333222b31a12a112c3a21a13212a23a321a121a1323b3112a4a42333213423/" +
  "341244321413423231133333c211222b223d22a22133b1a2a3a2233233431341344233214/" +
  "434441122244434a323323112a2413a22312213112321a3214b323323222143a322222143342433/" +
  "4333314141132132242313113131313a112a131c13a2a2344a13a3122324413411333212334344";

export function field(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 1920 1080");
  svg.setAttribute("width", "1920");
  svg.setAttribute("height", "1080");
  svg.setAttribute("class", "pixel-field");
  svg.setAttribute("aria-hidden", "true");
  const shades = ["", "", "", "", ""];
  FIELD.split("/").forEach((row, y) => {
    let x = 0;
    for (const char of row) {
      if (char >= "a" && char <= "z") x += char.charCodeAt(0) - 96;
      else {
        shades[Number(char)] += `M${x * 24} ${y * 24}h18v18h-18z`;
        x++;
      }
    }
  });
  for (let shade = 1; shade <= 4; shade++) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", `field-${shade}`);
    path.setAttribute("d", shades[shade]);
    svg.append(path);
  }
  return svg;
}

// The pixel "hi." wordmark from the welcome screen (board 02), in three of
// the theme's colours.
export function hi(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 320 286");
  svg.setAttribute("width", "448");
  svg.setAttribute("height", "400");
  svg.setAttribute("class", "hi");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "hi.");
  const block = (x: number, y: number) => `M${x} ${y}h30v30h-30z`;
  const ink: [string, [number, number][]][] = [
    ["hi-1", [[0, 0], [224, 0], [0, 32], [0, 64], [192, 64], [224, 64]]],
    ["hi-2", [[0, 96], [32, 96], [64, 96], [96, 96], [224, 96], [0, 128], [128, 128], [224, 128], [0, 160], [128, 160], [224, 160]]],
    ["hi-3", [[0, 192], [128, 192], [224, 192], [0, 224], [128, 224], [224, 224], [288, 224], [0, 256], [128, 256], [192, 256], [224, 256], [288, 256]]],
  ];
  for (const [name, blocks] of ink) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", name);
    path.setAttribute("d", blocks.map(([x, y]) => block(x, y)).join(""));
    svg.append(path);
  }
  return svg;
}

// The status bar: "setup", the step, and on the right what's going on and
// the clock.
export function bar(step: string, info: string): HTMLElement {
  const time = h("span", { class: "bar-clock" }, clock());
  const timer = setInterval(() => {
    if (!time.isConnected) clearInterval(timer);
    else time.textContent = clock();
  }, 10_000);
  return h(
    "div",
    { class: "bar" },
    h("div", { class: "bar-left" }, h("span", { class: "bar-mode" }, "setup"), h("span", { class: "bar-step" }, step)),
    h("div", { class: "bar-right" }, h("span", { class: "bar-info" }, info), time),
  );
}

export function prompt(command: string): HTMLElement {
  return h("div", { class: "prompt" }, h("b", {}, "~"), ` $ ${command}`);
}

// The shell prompt over a heading, and the heading, which types itself out
// once it's on the page unless motion is reduced.
export function heading(command: string, title: string, reduced: boolean): HTMLElement[] {
  const headline = h("h1", { class: "headline setup-headline", "aria-label": title });
  if (reduced) headline.textContent = title;
  else typeOut(headline, title);
  return [prompt(command), headline];
}

function typeOut(el: HTMLElement, text: string): void {
  const typed = h("span", { "aria-hidden": "true" });
  const rest = h("span", { class: "untyped", "aria-hidden": "true" }, text);
  el.replaceChildren(typed, rest);
  const started = performance.now();
  const step = (time: number) => {
    const shown = Math.min(text.length, Math.ceil(((time - started) / 300) * text.length));
    typed.textContent = text.slice(0, shown);
    rest.textContent = text.slice(shown);
    if (shown < text.length && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
