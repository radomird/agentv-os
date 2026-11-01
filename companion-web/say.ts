// Ask the TV (ADR-023): a box on the remote that takes the phone keyboard's
// dictation, or typing, and sends the sentence to the box's agent. Under it,
// what the TV made of the last one: what opened, why nothing did, or up to
// three to choose from, which this phone can pick as the TV can. "i didn't
// get that" means nothing happened (S7.3).

import { api, h } from "./lib.ts";

export interface Candidate {
  app: string;
  name: string;
  item: { title: string; kind: string; season?: number; episode?: number };
}

export interface Said {
  n: number;
  sentence: string;
  from: string;
  state: "routing" | "done";
  outcome?: { kind: "opened"; say: string } | { kind: "choose"; say: string; candidates: Candidate[] } | { kind: "none"; say: string; why: string; detail?: string };
}

const KIND_WORDS: Record<string, string> = { film: "film", series: "show", episode: "episode", track: "song", album: "album", playlist: "playlist", "photo-album": "photos", game: "game" };

function label(c: Candidate): string {
  const at = [c.item.season !== undefined ? `s${c.item.season}` : "", c.item.episode !== undefined ? `e${c.item.episode}` : ""].filter(Boolean).join(" ");
  return [`${c.item.title.toLowerCase()}${at ? ` ${at}` : ""}`, KIND_WORDS[c.item.kind] ?? c.item.kind, c.name.toLowerCase()].join(" · ");
}

// What the TV made of the last sentence.
function answer(said: Said, failed: (error: unknown) => void, done: () => void): HTMLElement {
  const heard = h("p", { class: "said-heard" }, `"${said.sentence}"`);
  const outcome = said.outcome;
  if (said.state === "routing" || !outcome) return h("div", { class: "said", "data-said": "routing" }, heard, h("p", { class: "note" }, "your agent is on it…"));
  if (outcome.kind !== "choose") {
    return h("div", { class: `said${outcome.kind === "none" ? " bad" : ""}`, "data-said": outcome.kind }, heard, h("p", { class: "said-say" }, outcome.say), outcome.kind === "none" && outcome.detail ? h("p", { class: "note" }, outcome.detail) : null);
  }
  const pick = (choice: number) =>
    void api("POST", "/api/phone/say/pick", { n: said.n, choice }).then(done, (error) => {
      failed(error);
      done();
    });
  return h(
    "div",
    { class: "said", "data-said": "choose" },
    heard,
    h("p", { class: "said-say" }, outcome.say),
    ...outcome.candidates.map((c, i) => h("button", { type: "button", class: "button said-choice", "data-action": "said-pick", "data-choice": String(i), onclick: () => pick(i) }, label(c))),
    h("button", { type: "button", class: "button", "data-action": "said-none", onclick: () => void api("POST", "/api/phone/say/dismiss", { n: said.n }).then(done, failed) }, "none of these"),
  );
}

export function sayBox(said: Said | null | undefined, failed: (error: unknown) => void, done: () => void): HTMLElement {
  const field = h("input", {
    class: "field",
    id: "say-text",
    type: "text",
    inputmode: "text",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    enterkeyhint: "send",
    placeholder: "play frozen, or continue my show",
  }) as HTMLInputElement;
  const go = async () => {
    const sentence = field.value.trim();
    if (!sentence) return;
    field.value = "";
    field.blur();
    try {
      await api("POST", "/api/phone/say", { sentence });
    } catch (error) {
      failed(error);
    }
    done();
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void go();
  });
  return h(
    "div",
    { class: "say" },
    h("label", { for: "say-text", class: "label" }, "ask your tv · the keyboard's microphone works here"),
    h("div", { class: "say-row" }, field, h("button", { type: "button", class: "button primary", "data-action": "say", onclick: () => void go() }, "ask")),
    said ? answer(said, failed, done) : null,
  );
}
