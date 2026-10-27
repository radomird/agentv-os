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

// Runs in the page: its structure, a line each, with a selector an app
// could use for each thing on it.
const OUTLINE = `(() => {
  const clip = (text, n = 80) => String(text || "").replace(/\\s+/g, " ").trim().slice(0, n);
  const lines = [];
  const seen = new Set();
  const add = (line) => {
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
  const label = (el) => clip((el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "");
  for (const el of document.querySelectorAll("h1, h2, h3")) add(el.tagName.toLowerCase() + " " + quote(clip(el.textContent)) + " " + selector(el));
  for (const el of document.querySelectorAll("nav, main, header, footer, [role=dialog]")) add("region " + selector(el));
  for (const el of document.querySelectorAll("form")) add("form " + selector(el) + " action=" + clip(el.getAttribute("action"), 120));
  for (const el of document.querySelectorAll("input, select, textarea")) {
    if (el.type === "hidden") continue;
    add("field " + selector(el) + " type=" + (el.type || el.tagName.toLowerCase()) + (el.autocomplete ? " autocomplete=" + el.autocomplete : "") + " label=" + quote(label(el)));
  }
  for (const el of document.querySelectorAll("button, [role=button]")) add("button " + quote(clip(el.textContent || el.getAttribute("aria-label"))) + " " + selector(el));
  for (const el of document.querySelectorAll("a[href]")) add("link " + quote(clip(el.textContent || el.getAttribute("aria-label"))) + " -> " + clip(el.href, 160));
  for (const el of document.querySelectorAll("video, audio, iframe")) add(el.tagName.toLowerCase() + " " + selector(el) + " " + clip(el.currentSrc || el.src, 160));
  for (const el of document.querySelectorAll("link[rel~=icon], link[rel=apple-touch-icon], link[rel=manifest]")) add(el.rel + " -> " + clip(el.href, 160));
  return { url: location.href, title: document.title, lines };
})()`;

// Runs in the page: the page as it is now, without what would run or fetch.
const SNAPSHOT = `(() => {
  const copy = document.documentElement.cloneNode(true);
  for (const el of copy.querySelectorAll("script, noscript, style, link, base, meta[http-equiv], iframe, object, embed, template")) el.remove();
  for (const el of copy.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || ["src", "srcset", "poster", "data", "style"].includes(name)) el.removeAttribute(attr.name);
      else if (name === "href" && /^\\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }
  return "<!doctype html>\\n" + copy.outerHTML;
})()`;

// Whether this browser can play Widevine, as a streaming service's player asks.
const DRM = `navigator.requestMediaKeySystemAccess ? navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{ initDataTypes: ["cenc"], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }]).then(() => true, () => false) : false`;

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

// A look, for the agent to read: the page, what of it isn't declared, and
// its structure.
export function saidLook(seen: Look, declared: string[]): string {
  const undeclared = seen.asked.filter((origin) => origin.startsWith("https://") && !declared.includes(origin));
  return [
    `${seen.url}${seen.status ? ` answered ${seen.status}` : ""}: "${seen.title.replace(/\s+/g, " ").trim().slice(0, 100)}"`,
    `protected video (Widevine) in this browser: ${seen.drm ? "yes" : "no"}`,
    undeclared.length ? `it also asked for origins the build hasn't declared, which the filter refused: ${undeclared.join(", ")}` : "it asked for nothing the build hasn't declared",
    "",
    ...(seen.lines.length ? seen.lines : ["(nothing on it yet)"]),
  ].join("\n");
}
