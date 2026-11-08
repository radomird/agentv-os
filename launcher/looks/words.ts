// How Glass and Cinema write the launcher's words (ADR-063, D2). Phase 1's
// pages write everything in lower case, as Terminal does, with keys and
// boxes in the text ("↵ open", "[x]"). Rather than change every page, these
// two looks go over the words on the screen as they appear:
//
// - each sentence starts with a capital, and so does a line that's a label;
// - a few words are always in capitals: AI, PIN, TV and the like, and days
//   and months start with one;
// - "[x]" is a tick, "[ ]" nothing, and a leading "↵ " goes, since the
//   remote's OK always does the same.
//
// Names keep their own capitals, so nothing is ever made lower case here.
// Terminal's words are never touched. Addresses, codes and anything typed in
// a field stay exactly as they are.

import { icon } from "./icons.ts";

const CAPS = /\b(ai|pin|tv|tmdb|usb|nas|met|ui|ok|hdmi|id|url)\b/g;
// Days and months are names, so they start with a capital. May and March
// are ordinary words too, so they're left to where a line starts.
const NAMES = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|april|june|july|august|september|october|november|december)\b/g;
const KEEP = /:\/\/|@|\.local\b|\b\d{1,3}(\.\d{1,3}){3}\b/;

export function sentenceCase(text: string): string {
  if (KEEP.test(text)) return text;
  return text
    .replace(CAPS, (word) => word.toUpperCase())
    .replace(NAMES, (word) => word.charAt(0).toUpperCase() + word.slice(1))
    .replace(/(^\s*|[.!?]\s+)(\p{Ll})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());
}

// The elements whose words are never changed: what someone typed, a code to
// type, and an address.
const UNTOUCHED = "input, textarea, code, .pair-code, [data-own-case], svg";

function fix(node: Text): void {
  const parent = node.parentElement;
  if (!parent || parent.closest(UNTOUCHED)) return;
  const text = node.data;
  const bare = text.trim();
  if (bare === "[x]" || bare === "[ ]") {
    if (bare === "[x]") parent.replaceChild(icon("check", 30, "on"), node);
    else node.data = "";
    return;
  }
  let next = text.replace(/^\s*↵\s+/, "");
  next = sentenceCase(next);
  if (next !== text) node.data = next;
}

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    fix(root as Text);
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) found.push(node as Text);
  for (const node of found) fix(node);
}

let watching: MutationObserver | null = null;

// Goes over the words now and as they change, in the page and the layers over
// it, while on is true. Off stops watching; the words already changed stay.
export function writeInSentenceCase(on: boolean): void {
  const roots = ["page", "toasts", "notice", "pin", "ambient", "updating"].map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
  if (!on) {
    watching?.disconnect();
    watching = null;
    return;
  }
  for (const root of roots) walk(root);
  if (watching) return;
  watching = new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === "characterData") walk(change.target);
      else for (const node of change.addedNodes) walk(node);
    }
  });
  for (const root of roots) watching.observe(root, { childList: true, subtree: true, characterData: true });
}
