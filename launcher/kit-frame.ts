// AgenTV's app kit, in a page app's own frame (contract 2, ADR-043). The box
// serves this at /_agentv/kit.js on the app's origin, with its types
// stripped, and it sets window.agentv as apps/contract/kit.ts describes.
// Everything goes to home with postMessage, and home answers only the frame
// it put there, for the app it put there; the daemon checks each call
// against the app's manifest. This file has no imports, since it runs as a
// plain script, only types.

import type { Bytes, Call, FromApp, InputEvent, Kit, ToApp } from "../apps/contract/kit.ts";

(() => {
  const home = window.parent;
  if (home === window) return; // not in home's frame: nothing to talk to
  let next = 0;
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const inputs: ((event: InputEvent) => void)[] = [];
  const paused: (() => void)[] = [];
  const resumed: (() => void)[] = [];
  let back: (() => boolean | void) | null = null;

  const send = (message: FromApp) => home.postMessage(message, "*");

  function call(name: Call, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      send({ agentv: 1, id, call: name, args });
    });
  }

  const run = (listener: () => void) => {
    try {
      listener();
    } catch (error) {
      console.error(error);
    }
  };

  window.addEventListener("message", (event) => {
    if (event.source !== home) return;
    const message = event.data as ToApp;
    if (!message || message.agentv !== 1) return;
    if ("id" in message) {
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error));
    } else if (message.event === "input") {
      for (const listener of inputs) run(() => listener(message.input));
    } else if (message.event === "back") {
      let kept = false;
      try {
        kept = back?.() === true;
      } catch (error) {
        console.error(error);
      }
      send({ agentv: 1, back: message.back, kept });
    } else if (message.event === "pause") {
      for (const listener of paused) run(listener);
    } else if (message.event === "resume") {
      for (const listener of resumed) run(listener);
    }
  });

  // A file from the box, as an address the page can show or play.
  const blob = async (name: Call, ...args: unknown[]) => {
    const file = (await call(name, ...args)) as Bytes;
    return URL.createObjectURL(new Blob([file.bytes], { type: file.type }));
  };

  const kit: Kit = Object.freeze({
    ready: () => void call("ready").catch(() => {}),
    exit: () => void call("exit").catch(() => {}),
    viewer: () => call("viewer") as ReturnType<Kit["viewer"]>,
    input: Object.freeze({ on: (listener: (event: InputEvent) => void) => void inputs.push(listener) }),
    onBack: (listener: () => boolean | void) => {
      back = listener;
    },
    onPause: (listener: () => void) => void paused.push(listener),
    onResume: (listener: () => void) => void resumed.push(listener),
    storage: Object.freeze({
      get: (key: string) => call("storage.get", key),
      set: async (key: string, value: unknown) => void (await call("storage.set", key, value)),
      remove: async (key: string) => void (await call("storage.remove", key)),
      keys: () => call("storage.keys") as Promise<string[]>,
    }),
    photos: Object.freeze({
      sources: () => call("photos.sources") as ReturnType<Kit["photos"]["sources"]>,
      list: (source: string, options?: { folder?: string; offset?: number; limit?: number }) => call("photos.list", source, options ?? {}) as ReturnType<Kit["photos"]["list"]>,
      url: (id: string, options?: { width?: number }) => blob("photos.image", id, options?.width),
    }),
    music: Object.freeze({
      albums: () => call("music.albums") as ReturnType<Kit["music"]["albums"]>,
      url: (id: string) => blob("music.track", id),
    }),
    tile: Object.freeze({ set: async (tile: Parameters<Kit["tile"]["set"]>[0]) => void (await call("tile.set", tile)) }),
    notify: async (text: string) => void (await call("notify", text)),
  });
  Object.defineProperty(window, "agentv", { value: kit, writable: false, configurable: false });
})();
