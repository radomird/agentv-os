// A checkbox's mark, as each look draws it (ADR-063, D2). Every page writes
// its words in sentence case, and Terminal shows them in lower case with its
// own CSS rule (launcher.css). Terminal's marks are part of its words: "[x]"
// for done, "[ ]" for not yet, and "[~]", "[>]" or "[!]" for a step that's
// going, next or failed. Glass and Cinema draw a tick for "[x]" and nothing
// for "[ ]", and keep the other three as they are.

import { icon } from "./icons.ts";
import { lookId } from "./looks.ts";

export function mark(text: string): string | Node {
  const look = lookId();
  if (look !== "glass" && look !== "cinema") return text;
  if (text === "[x]") return icon("check", 30, "on");
  if (text === "[ ]") return "";
  return text;
}
