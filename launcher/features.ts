// The feature switches, for the TV's pages (daemon/features.ts). A page asks
// once, and the answer follows the event `features`, so a switch turned on
// with `agentv feature on` shows without a reload. The page's <html> carries
// the switches that are on in data-features too, for CSS:
// [data-features~="looks"].

export type FeatureMap = Record<string, boolean>;

let current: Promise<FeatureMap> | null = null;
let source: EventSource | null = null;
const followers = new Set<(all: FeatureMap) => void>();

function mark(all: FeatureMap): void {
  document.documentElement.dataset.features = Object.keys(all).filter((name) => all[name]).join(" ");
}

function follow(): void {
  if (source) return;
  source = new EventSource("/api/events");
  source.addEventListener("features", (message) => {
    const all = JSON.parse((message as MessageEvent).data) as FeatureMap;
    current = Promise.resolve(all);
    mark(all);
    for (const follower of followers) follower(all);
  });
}

// Every switch and whether it's on. With no answer, every switch is off.
export function features(): Promise<FeatureMap> {
  current ??= fetch("/api/features", { cache: "no-store" })
    .then((response) => (response.ok ? (response.json() as Promise<FeatureMap>) : {}))
    .catch(() => ({}))
    .then((all) => (mark(all), all));
  follow();
  return current;
}

export async function featureOn(name: string): Promise<boolean> {
  return (await features())[name] === true;
}

// Calls back with every switch now, and again each time one changes.
export function onFeatures(callback: (all: FeatureMap) => void): void {
  followers.add(callback);
  void features().then(callback);
}
