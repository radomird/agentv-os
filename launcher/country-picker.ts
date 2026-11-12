// Picking the box's country (ADR-055), for setup's country step and
// Settings → country: a field the phone's keyboard types into, and the
// countries whose names match, eight at a time. Up and down move, OK picks.
// With nothing typed, it shows the countries around the one the box is in.

import type { Country } from "./api.ts";
import { h } from "./dom.ts";

const SHOWN = 8;

// The countries to show for what's typed: names that start with it first,
// then names that have it anywhere, and a code typed whole.
export function matching(all: Country[], typed: string, around: string | null): Country[] {
  const q = typed.trim().toLowerCase();
  if (!q) {
    const at = Math.max(0, all.findIndex((c) => c.code === around));
    const start = Math.min(Math.max(0, at - 3), Math.max(0, all.length - SHOWN));
    return all.slice(start, start + SHOWN);
  }
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(q) || c.code.toLowerCase() === q);
  const has = all.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q));
  return [...starts, ...has].slice(0, SHOWN);
}

export interface Picker {
  el: HTMLElement;
  field: HTMLInputElement;
  // What gets the focus first: the box's country in the list, or the field.
  first: HTMLElement;
}

export function countryPicker(all: Country[], current: string | null, pick: (country: Country) => void): Picker {
  const field = h("input", {
    class: "music-search country-field",
    "data-focus": true,
    "data-action": "country-field",
    type: "text",
    placeholder: "Your location",
    "aria-label": "Your location",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const list = h("div", { class: "country-list" });
  const draw = () => {
    const shown = matching(all, field.value, current);
    list.replaceChildren(
      ...(shown.length
        ? shown.map((c) =>
            h(
              "button",
              { class: `button country${c.code === current ? " current" : ""}`, "data-focus": true, "data-action": "country-pick", "data-code": c.code, onclick: () => pick(c) },
              h("span", {}, c.name),
              h("span", { class: "button-value" }, c.code === current ? "Current" : c.code),
            ),
          )
        : [h("p", { class: "panel-note" }, "No match")]),
    );
  };
  field.addEventListener("input", draw);
  draw();
  const el = h("div", { class: "country-picker" }, field, list);
  const first = list.querySelector<HTMLElement>(".country.current") ?? field;
  return { el, field, first };
}
