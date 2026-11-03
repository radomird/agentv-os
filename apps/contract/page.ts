// A page app's own rules (contract 2, ADR-043): the static checks every page
// app passes before anything of it is shown, the Content-Security-Policy the
// box serves it under, and what it may reach in plain words, for approval
// and its details on the TV.
//
// The checks are the first of the builder's three gates, and the installer
// and `agentv app validate` run them too, so a page app from a file gets
// them as well. The policy is what holds at run time: these checks catch
// what would only fail there, and say why.

import { readFileSync, statSync } from "node:fs";
import { extname, join, posix } from "node:path";
import type { Manifest } from "./manifest.ts";
import { KIT_PATH, STORAGE_QUOTA } from "./kit.ts";

// The whole package, and any one file in it.
export const PAGE_MAX_BYTES = 25 * 1024 * 1024;
export const PAGE_FILE_MAX_BYTES = 10 * 1024 * 1024;

// What a page app is made of: its pages, styles and scripts, data, images,
// fonts and sounds, and its licence.
const PAGE_FILES = [
  ".html", ".css", ".js", ".mjs", ".json", ".map",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".otf",
  ".ogg", ".mp3", ".wav", ".m4a", ".webm", ".mp4",
  ".txt", ".md",
];
const PLAIN_FILES = ["LICENSE", "LICENCE", "NOTICE", "COPYING"];
const TEXT = [".html", ".css", ".js", ".mjs"];

// The box itself, which a page app never reaches: the daemon answers there.
const THE_BOX = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|\[::ffff:127(\.\d{1,3}){3}\])$/i;

// The origin of an absolute http(s) or ws(s) address, with ws(s) taken as
// http(s), since the policy lists http(s) origins. Null for anything else.
function originOf(address: string): string | null {
  try {
    const url = new URL(address.replace(/^ws(s?):/i, "http$1:"));
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

// Whether a page app may list this as one of its origins: a plain http or
// https origin out on the network, never the box.
export function pageOriginProblem(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return `'${origin}' isn't an origin: a scheme and a host, like https://example.org`;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== origin) {
    return `'${origin}' isn't an origin: a scheme and a host, like https://example.org`;
  }
  if (THE_BOX.test(url.hostname)) return `'${origin}' is this box, which a page app reaches only through AgenTV's app kit`;
  return null;
}

// Each absolute address in a request, in text, with where it was found.
interface Found {
  address: string;
  how: string;
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    found.set(match[1].toLowerCase(), match[3] ?? match[4] ?? match[5] ?? "");
  }
  return found;
}

const ADDRESS = /^(https?:|wss?:)?\/\//i;

function checkHtml(rel: string, html: string, files: Set<string>, problem: (text: string) => void, found: Found[]): void {
  const source = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const name of ["base", "iframe", "frame", "frameset", "object", "embed", "portal", "applet"]) {
    if (new RegExp(`<${name}\\b`, "i").test(source)) problem(`${rel} has a <${name}>, which a page app can't use`);
  }
  if (/<meta\b[^>]*\bhttp-equiv\s*=/i.test(source)) problem(`${rel} has a <meta http-equiv>, which a page app can't use`);
  if (/\bjavascript\s*:/i.test(source)) problem(`${rel} has a javascript: address, which doesn't run under the page's policy`);

  for (const match of source.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g)) {
    const tag = match[0];
    const name = match[1].toLowerCase();
    const attrs = attributes(tag);
    for (const attr of attrs.keys()) {
      if (/^on[a-z]+$/.test(attr)) problem(`${rel} has an inline ${attr} handler on <${name}>, which doesn't run under the page's policy; add the listener in a script`);
    }
    for (const attr of ["src", "href", "poster", "data", "action", "formaction"]) {
      const value = attrs.get(attr);
      if (value === undefined) continue;
      if (name === "a" && attr === "href") continue; // a link only goes where it's chosen, and the frame can't leave
      if (ADDRESS.test(value.trim())) {
        if (name === "script") problem(`${rel} loads a script from ${value}; a page app's scripts are its own files`);
        else found.push({ address: value.trim().replace(/^\/\//, "https://"), how: `${rel} (<${name} ${attr}>)` });
      } else if (name === "script" && attr === "src") {
        // The kit comes from the box; every other script is the package's.
        const file = value.split(/[?#]/)[0];
        if (file === KIT_PATH) continue;
        const path = file.startsWith("/") ? posix.normalize(file.slice(1)) : posix.normalize(posix.join(posix.dirname(rel), file));
        if (path.startsWith("../") || !files.has(path)) problem(`${rel} loads the script ${value}, which isn't in the package`);
      }
    }
    const srcset = attrs.get("srcset");
    for (const candidate of srcset?.split(",") ?? []) {
      const address = candidate.trim().split(/\s+/)[0];
      if (address && ADDRESS.test(address)) found.push({ address: address.replace(/^\/\//, "https://"), how: `${rel} (<${name} srcset>)` });
    }
  }

  // A script with no src runs only when it's empty: the policy allows the
  // package's own files and nothing inline.
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = attributes(` ${match[1]}`);
    if (!attrs.has("src") && match[2].trim() !== "") {
      problem(`${rel} has an inline script, which doesn't run under the page's policy; put it in a .js file`);
    }
  }
  for (const match of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) checkCss(rel, match[1], problem, found);
}

function checkCss(rel: string, css: string, problem: (text: string) => void, found: Found[]): void {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
    if (ADDRESS.test(match[2].trim())) found.push({ address: match[2].trim().replace(/^\/\//, "https://"), how: `${rel} (url())` });
  }
  for (const match of source.matchAll(/@import\s+(["'])([^"']+)\1/gi)) {
    if (ADDRESS.test(match[2].trim())) found.push({ address: match[2].trim().replace(/^\/\//, "https://"), how: `${rel} (@import)` });
  }
}

// eval(...) called, as opposed to a method called eval, { eval(text) { ... } },
// which a parser in a package may well have.
function callsEval(js: string): boolean {
  for (const match of js.matchAll(/(^|[^.\w$]|\b(?:window|globalThis|self)\.)eval\s*\(/g)) {
    let depth = 0;
    let at = match.index + match[0].length - 1;
    for (; at < js.length; at++) {
      if (js[at] === "(") depth++;
      else if (js[at] === ")" && --depth === 0) break;
    }
    if (!/^\s*\{/.test(js.slice(at + 1, at + 40))) return true;
  }
  return false;
}

// Scripts: no eval and no code from elsewhere, and the requests written out
// in them go only to the app's origins. The policy refuses all of this at
// run time too; here it's said before the app ever runs.
function checkScript(rel: string, js: string, problem: (text: string) => void, found: Found[]): void {
  if (callsEval(js)) problem(`${rel} calls eval(), which doesn't run under the page's policy`);
  if (/\bnew\s+Function\s*\(/.test(js)) problem(`${rel} uses new Function(), which doesn't run under the page's policy`);
  if (/\b(?:import|export)\b[^;'"]*?\bfrom\s*["'](?:https?:|wss?:)?\/\//.test(js) || /\bimport\s*["'](?:https?:)?\/\//.test(js)) {
    problem(`${rel} imports code from another site; a page app's scripts are its own files`);
  }
  if (/\bimport\s*\(\s*["'`](?:https?:)?\/\//.test(js) || /\bimportScripts\s*\(\s*["'`](?:https?:)?\/\//.test(js)) {
    problem(`${rel} loads code from another site; a page app's scripts are its own files`);
  }
  const literal = String.raw`\s*(["'\x60])((?:https?|wss?):\/\/[^"'\x60\s]+)\1`;
  const requests = [
    new RegExp(String.raw`\bfetch\s*\(${literal}`, "g"),
    new RegExp(String.raw`\bnew\s+(?:WebSocket|EventSource|Request|Worker|SharedWorker|Audio|URL)\s*\(${literal}`, "g"),
    new RegExp(String.raw`\bsendBeacon\s*\(${literal}`, "g"),
    new RegExp(String.raw`\.open\s*\(\s*["'][A-Za-z]+["']\s*,${literal}`, "g"),
    new RegExp(String.raw`\.src\s*=${literal}`, "g"),
  ];
  for (const pattern of requests) {
    for (const match of js.matchAll(pattern)) found.push({ address: match[2], how: `${rel} (${match[0].trim().split(/[\s(=]/)[0]})` });
  }
}

// Checks the page app in root: its files, its page and every request
// written into it. files is every file in the package, relative to it.
export function checkPage(root: string, files: Set<string>, manifest: Record<string, any>, problem: (text: string) => void): void {
  let total = 0;
  const found: Found[] = [];
  for (const rel of [...files].sort()) {
    if (rel === "manifest.json") continue;
    if (rel.split("/").includes("node_modules")) {
      problem(`${rel} is in node_modules; a page app bundles its packages and ships no node_modules`);
      continue;
    }
    const ext = extname(rel).toLowerCase();
    const base = posix.basename(rel);
    if (!PAGE_FILES.includes(ext) && !PLAIN_FILES.includes(base)) {
      problem(`${rel} isn't something a page app is made of: ${PAGE_FILES.join(", ")} and a licence`);
      continue;
    }
    const size = statSync(join(root, rel)).size;
    total += size;
    if (size > PAGE_FILE_MAX_BYTES) problem(`${rel} is ${Math.ceil(size / 1024 / 1024)} MB, and a page app's files are up to ${PAGE_FILE_MAX_BYTES / 1024 / 1024} MB each`);
    if (!TEXT.includes(ext) || size > PAGE_FILE_MAX_BYTES) continue;
    const text = readFileSync(join(root, rel), "utf8");
    if (ext === ".html") checkHtml(rel, text, files, problem, found);
    else if (ext === ".css") checkCss(rel, text, problem, found);
    else checkScript(rel, text, problem, found);
  }
  if (total > PAGE_MAX_BYTES) problem(`the app is ${Math.ceil(total / 1024 / 1024)} MB, and a page app is up to ${PAGE_MAX_BYTES / 1024 / 1024} MB`);

  const declared = new Set(Array.isArray(manifest.tv?.origins) ? manifest.tv.origins.filter((o: unknown) => typeof o === "string") : []);
  const told = new Set<string>();
  for (const { address, how } of found) {
    const origin = originOf(address);
    if (!origin) continue;
    if (!declared.has(origin) && !told.has(origin)) {
      told.add(origin);
      problem(`${how} reaches ${origin}, which isn't one of the app's tv.origins`);
    }
  }
}

// The Content-Security-Policy the box serves a page app under: its own
// files, the origins it declared, and nothing else. home is the origin of
// the page that holds its frame, the only one that may.
export function pagePolicy(manifest: Manifest, home: string): string {
  const origins = (manifest.tv.origins ?? []).join(" ");
  const and = origins ? ` ${origins}` : "";
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${and}`,
    `media-src 'self' data: blob:${and}`,
    `font-src 'self' data:${and}`,
    `connect-src 'self'${and}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${home}`,
  ].join("; ");
}

// What a page app may reach, in plain words, for approval on the phone and
// its details on the TV: what every page app gets, then what it declared.
export function pagePermissions(manifest: Manifest): { always: string[]; declared: string[] } {
  const tv = manifest.tv;
  const declared: string[] = [];
  const hosts = (tv.origins ?? []).map((origin) => origin.replace(/^https?:\/\//, ""));
  if (hosts.length) declared.push(`the internet, only at ${hosts.join(", ")}`);
  if (tv.media?.includes("photos")) declared.push("the photos in music's sources on this tv, without changing them");
  if (tv.media?.includes("music")) declared.push("the music in music's sources on this tv, without changing it");
  if (tv.capabilities.includes("tile")) declared.push("a tile on home");
  if (tv.notices) declared.push("notices on the tv and your phone");
  return {
    always: ["the remote, a gamepad and your phone", "sound", `its own storage, up to ${STORAGE_QUOTA / 1024 / 1024} mb`],
    declared,
  };
}
