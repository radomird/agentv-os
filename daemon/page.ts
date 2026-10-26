// A web app's page in the services' Chromium, for its worker (the contract's
// AppPage): each call becomes a script in that one page over the screen
// daemon's DevTools pipe. The loader holds every call to the app's origins
// before it gets here (apps/loader.ts).

import type { DevTools } from "./cdp.ts";
import type { PageBroker } from "./apps/loader.ts";

const STEP_MS = 100;
const WAIT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The script for one of the page's methods, with its arguments as JSON.
export function script(method: string, args: unknown[]): string {
  const json = (value: unknown) => JSON.stringify(value ?? null);
  const find = `document.querySelector(${json(args[0])})`;
  switch (method) {
    case "title":
      return "document.title";
    case "evaluate":
      // A function runs with its one argument; anything else is an expression.
      return args[2] ? `(${String(args[0])})(${json(args[1])})` : String(args[0]);
    case "click":
      return `(() => { const el = ${find}; if (!el) throw new Error("nothing on the page matches " + ${json(args[0])}); el.click(); return null; })()`;
    case "fill":
      return `(() => {
        const el = ${find};
        if (!el) throw new Error("nothing on the page matches " + ${json(args[0])});
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
        setter ? setter.call(el, ${json(args[1])}) : (el.value = ${json(args[1])});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return null;
      })()`;
    case "press":
      return `(() => {
        const el = ${find} ?? document.activeElement ?? document.body;
        el.focus?.();
        for (const type of ["keydown", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key: ${json(args[1])}, bubbles: true }));
        return null;
      })()`;
    default:
      throw new Error(`a page can't ${method} here`);
  }
}

// waitForSelector's test, run until it's true: there, and seen unless only
// attached was asked for.
function present(selector: string, state: string): string {
  const el = `document.querySelector(${JSON.stringify(selector)})`;
  if (state === "attached") return `!!${el}`;
  if (state === "detached") return `!${el}`;
  if (state === "hidden") return `(() => { const el = ${el}; return !el || !el.getClientRects().length; })()`;
  return `(() => { const el = ${el}; return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"; })()`;
}

// target says which page is the app's; it may not be known yet when the
// broker is made, for an app whose Chromium is still starting.
export function cdpPage(cdp: Pick<DevTools, "evaluateIn">, target: () => string | undefined): PageBroker {
  const on = async (expression: string) => {
    const id = target();
    if (!id) throw new Error("the app's page isn't open yet");
    return cdp.evaluateIn(id, expression);
  };
  return {
    url: () => on("location.href").then(String),
    async call(method, args) {
      if (method === "goto") {
        const url = String(args[0]);
        const until = Date.now() + (typeof args[1] === "number" ? args[1] : WAIT_MS * 3);
        // The page it leaves gets a mark, so the wait is for a page without
        // it: until a navigation has begun, and on a reload, the old page is
        // still there and loaded. A change of hash alone keeps the page, and
        // it's done by the time location.assign returns.
        const mark = `agentv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const same = await on(`(() => {
          const next = new URL(${JSON.stringify(url)}, location.href);
          const same = next.hash !== "" && next.href.split("#")[0] === location.href.split("#")[0];
          if (!same) window.__agentvLeaving = ${JSON.stringify(mark)};
          location.assign(next.href);
          return same;
        })()`);
        if (same === true) return null;
        const loaded = `window.__agentvLeaving !== ${JSON.stringify(mark)} && location.href !== "about:blank" && document.readyState === "complete"`;
        // Until the new page has loaded, or the time is up.
        while (Date.now() < until) {
          await sleep(STEP_MS * 2);
          if ((await on(loaded).catch(() => false)) === true) return null;
        }
        throw new Error(`the page didn't load ${url} in time`);
      }
      if (method === "waitForSelector") {
        const until = Date.now() + (typeof args[1] === "number" ? args[1] : WAIT_MS);
        const test = present(String(args[0]), String(args[2] ?? "visible"));
        while (Date.now() < until) {
          if ((await on(test).catch(() => false)) === true) return null;
          await sleep(STEP_MS);
        }
        throw new Error(`nothing on the page matched ${String(args[0])} in time`);
      }
      return on(script(method, args));
    },
  };
}
