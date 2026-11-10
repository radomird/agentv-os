// Stage A's look at a service's pages (ADR-011): a fresh headless Chromium
// with a throwaway profile and no sign-in, in the builder's sandbox, whose
// only way out is its filter, so it reaches the origins the build declared
// and nothing else. The agent gets the page's structure in plain lines (its
// headings, forms, fields, buttons, links, players and icons), the origins
// the page asked for that the build hasn't declared, and whether this
// browser can play protected video. A page it looked at can be kept as a
// fixture: the page as it was, without its scripts, styles or images, so a
// contract check reads it with nothing else to fetch.
//
// What a page says is the service's, not AgenTV's: it's never followed as
// an instruction, and nothing of it leaves the build.

import { headless } from "./gates/chromium.ts";

export interface Look {
  url: string; // where the page ended up
  title: string;
  status?: number; // the page's own answer
  lines: string[]; // its structure
  asked: string[]; // every origin it asked for
  drm: boolean; // whether this browser plays Widevine
  html: string; // the page without its scripts, for a fixture
}

export interface LookOptions {
  chromium: string;
  proxy?: string; // the sandbox's filter
  seconds?: number; // how long a page has to load
}

const LINES_MAX = 300;

// What a signed-in page may show of the account, which a build has no use
// for and which would go on to the AI provider and into the build's
// fixtures: an email address, a card's digits, and a card's last four
// where the page says that's what they are. Blanked in the page, before
// anything leaves the browser.
const EMAIL = "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+";
// A run of digits in groups, like 4111 1111 1111 1111 or 3782-822463-10005,
// that isn't part of a longer number or a decimal.
const DIGITS = "(?<![\\d.,])\\d+(?:[ -]\\d+)*(?!\\d)";
const LAST_FOUR = "((?:ending(?: in| with)?|ends (?:in|with)|last (?:4|four)(?: digits)?|[\u2022\u00b7*x]{2,}|\\.{3,})[\\s:#-]*)\\d{4}(?!\\d)";

// Runs in the page, as plain JavaScript: blank(text) is text with those
// blanked. A card's number is 12 to 19 digits, in one run or in groups of
// three or more, so a row of episode numbers stays. blankEmail is for an
// address or an attribute, where a long number is an id an app may need.
export const BLANK = `
  const blankEmail = (text) => String(text).replace(new RegExp(${JSON.stringify(EMAIL)}, "g"), "[email]");
  const blank = (text) => blankEmail(text)
    .replace(new RegExp(${JSON.stringify(DIGITS)}, "g"), (run) => {
      const groups = run.split(/[ -]/);
      const count = run.replace(/[ -]/g, "").length;
      return count >= 12 && count <= 19 && groups.every((group) => group.length >= 3) ? "[number]" : run;
    })
    .replace(new RegExp(${JSON.stringify(LAST_FOUR)}, "gi"), "$1[digits]");
`;

// Runs in the page: its structure, a line each, with a selector an app
// could use for each thing on it. Stage B's page_snapshot reads a signed-in
// page with it too, through the screen daemon (daemon/page-asks.ts).
export const OUTLINE = `(() => {${BLANK}
  const clip = (text, n = 80) => String(text || "").replace(/\\s+/g, " ").trim().slice(0, n);
  const words = (text, n = 80) => blank(String(text || "").replace(/\\s+/g, " ").trim()).slice(0, n);
  const lines = [];
  const seen = new Set();
  const add = (said) => {
    const line = blankEmail(said);
    if (lines.length < ${LINES_MAX} && !seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  };
  const quote = (value) => JSON.stringify(String(value));
  const selector = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && /^[A-Za-z][\\w-]{0,60}$/.test(el.id)) return "#" + el.id;
    for (const name of ["data-testid", "data-test-id", "data-automation-id", "data-qa", "name", "aria-label", "role", "type"]) {
      const value = el.getAttribute(name);
      if (value && value.length < 60) return tag + "[" + name + "=" + quote(value) + "]";
    }
    const classes = [...el.classList].filter((c) => /^[A-Za-z][\\w-]{1,40}$/.test(c)).slice(0, 2);
    return tag + classes.map((c) => "." + c).join("");
  };
  const label = (el) => words((el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "");
  for (const el of document.querySelectorAll("h1, h2, h3")) add(el.tagName.toLowerCase() + " " + quote(words(el.textContent)) + " " + selector(el));
  for (const el of document.querySelectorAll("nav, main, header, footer, [role=dialog]")) add("region " + selector(el));
  for (const el of document.querySelectorAll("form")) add("form " + selector(el) + " action=" + clip(el.getAttribute("action"), 120));
  for (const el of document.querySelectorAll("input, select, textarea")) {
    if (el.type === "hidden") continue;
    add("field " + selector(el) + " type=" + (el.type || el.tagName.toLowerCase()) + (el.autocomplete ? " autocomplete=" + el.autocomplete : "") + " label=" + quote(label(el)));
  }
  for (const el of document.querySelectorAll("button, [role=button]")) add("button " + quote(words(el.textContent || el.getAttribute("aria-label"))) + " " + selector(el));
  for (const el of document.querySelectorAll("a[href]")) add("link " + quote(words(el.textContent || el.getAttribute("aria-label"))) + " -> " + clip(el.href, 160));
  for (const el of document.querySelectorAll("video, audio, iframe")) add(el.tagName.toLowerCase() + " " + selector(el) + " " + clip(el.currentSrc || el.src, 160));
  for (const el of document.querySelectorAll("link[rel~=icon], link[rel=apple-touch-icon], link[rel=manifest]")) add(el.rel + " -> " + clip(el.href, 160));
  return { url: location.href, title: blank(document.title), lines };
})()`;

// Runs in the page: the page as it is now, without what would run or fetch,
// and without what a signed-in page keeps for itself: hidden fields, what's
// in a field, its meta tags and long data values, where tokens live. And
// without the account's email address and card digits, wherever it shows
// them.
export const SNAPSHOT = `(() => {${BLANK}
  const copy = document.documentElement.cloneNode(true);
  for (const el of copy.querySelectorAll("script, noscript, style, link, base, meta, iframe, object, embed, template, input[type=hidden]")) el.remove();
  for (const el of copy.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || ["src", "srcset", "poster", "data", "style", "value"].includes(name)) el.removeAttribute(attr.name);
      else if (name === "href" && /^\\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
      else if (name.startsWith("data-") && attr.value.length > 100) el.removeAttribute(attr.name);
      else {
        const said = ["aria-label", "title", "alt", "placeholder"].includes(name) ? blank(attr.value) : blankEmail(attr.value);
        if (said !== attr.value) el.setAttribute(attr.name, said);
      }
    }
  }
  for (const el of copy.querySelectorAll("textarea")) el.textContent = "";
  const texts = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  for (let node = texts.nextNode(); node; node = texts.nextNode()) {
    const said = blank(node.nodeValue);
    if (said !== node.nodeValue) node.nodeValue = said;
  }
  return "<!doctype html>\\n" + copy.outerHTML;
})()`;

// Whether this browser can play Widevine, as a streaming service's player asks.
export const DRM = `navigator.requestMediaKeySystemAccess ? navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{ initDataTypes: ["cenc"], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }]).then(() => true, () => false) : false`;

export async function look(url: string, o: LookOptions): Promise<Look> {
  const browser = headless(o.chromium, { proxy: o.proxy });
  const { cdp } = browser;
  try {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const asked = new Set<string>();
    let status: number | undefined;
    let loaded: () => void = () => {};
    cdp.on("Network.requestWillBeSent", (event: { request: { url: string } }, from?: string) => {
      if (from !== sessionId) return;
      try {
        const origin = new URL(event.request.url).origin;
        if (origin.startsWith("http")) asked.add(origin);
      } catch {}
    });
    cdp.on("Network.responseReceived", (event: { type: string; frameId: string; response: { status: number } }, from?: string) => {
      if (from === sessionId && event.type === "Document" && event.frameId === targetId) status = event.response.status;
    });
    cdp.on("Page.loadEventFired", (_event, from) => {
      if (from === sessionId) loaded();
    });
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    const there = new Promise<void>((done) => {
      const timer = setTimeout(done, (o.seconds ?? 30) * 1000);
      loaded = () => {
        clearTimeout(timer);
        done();
      };
    });
    const { errorText } = await cdp.send("Page.navigate", { url }, sessionId);
    if (errorText) throw new Error(errorText);
    await there;
    // A page that draws itself once it's loaded gets a moment to.
    await new Promise((done) => setTimeout(done, 1500));
    const evaluate = async (expression: string) => {
      const reply = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result.value;
    };
    const outline = (await evaluate(OUTLINE)) as { url: string; title: string; lines: string[] };
    return {
      url: outline.url,
      title: outline.title,
      ...(status ? { status } : {}),
      lines: outline.lines,
      asked: [...asked].sort(),
      drm: Boolean(await evaluate(DRM).catch(() => false)),
      html: (await evaluate(SNAPSHOT)) as string,
    };
  } finally {
    await browser.close();
  }
}

// A page, for the agent to read: where it is, what's said about it, and
// its structure.
export function saidPage(seen: { url: string; title: string; status?: number; lines: string[] }, notes: string[] = []): string {
  return [
    `${seen.url}${seen.status ? ` answered ${seen.status}` : ""}: "${seen.title.replace(/\s+/g, " ").trim().slice(0, 100)}"`,
    ...notes,
    "",
    ...(seen.lines.length ? seen.lines : ["(nothing on it yet)"]),
  ].join("\n");
}

// A look: the page, whether it plays protected video, and what it asked
// for that the build hasn't declared.
export function saidLook(seen: Look, declared: string[]): string {
  const undeclared = seen.asked.filter((origin) => origin.startsWith("https://") && !declared.includes(origin));
  return saidPage(seen, [
    `protected video (Widevine) in this browser: ${seen.drm ? "yes" : "no"}`,
    undeclared.length ? `it also asked for origins the build hasn't declared, which the filter refused: ${undeclared.join(", ")}` : "it asked for nothing the build hasn't declared",
  ]);
}
