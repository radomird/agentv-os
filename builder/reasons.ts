// Why an app couldn't be made, as the TV and the phone say it: a short table
// from the kind of failure to one plain line.
//
// The builder's own reason says which step stopped, with an exit code, the
// checker's words or the AI's own error. That's for whoever is fixing it, so
// it stays in the build's status and its log. A screen shows the line here,
// and nothing raw.
//
// A part of the builder that knows the kind says it (Runner.fail's why).
// Anything else is told by its words: root's answers, the relay's refusals
// and what an AI's own tool said on its way out.

export type Why =
  | "stopped" // someone pressed Stop
  | "month" // the month's limit, with a key
  | "limit" // this app's limit, with a key
  | "price" // a model the price table doesn't know
  | "key" // the AI refused the key
  | "credit" // the key has no credit left
  | "slow" // the time for the whole app ran out
  | "tries" // a step ran out of turns
  | "unclear" // what was asked couldn't be worked out
  | "steps" // no steps came for something new
  | "unapproved" // something new, and its steps weren't approved
  | "changed" // it isn't what the approval showed any more
  | "gone" // the app it goes on with was removed
  | "soon" // a plan that can't be used yet
  | "sign-in" // the plan's sign-in didn't finish
  | "busy" // another app is being made
  | "setup" // the AI's own tool couldn't be fetched
  | "start" // the builder's own parts didn't start
  | "install" // it passed, and couldn't be put on the TV
  | "checks" // AgenTV's static checks, or what it connects to
  | "tests"; // its tests, or the test TV

// Each AI by its name, as a line says it.
export const AI_NAMES = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", grok: "Grok", muse: "Muse" } as const;

// What the line may name: the AI ("Claude"), and an app's limit in dollars.
export interface Told {
  why?: Why;
  ai?: string;
  cap?: number;
}

// The builder's and the AIs' own words for each kind, the first that fits.
// The limits come before the key's, since the relay refuses a request over
// the limit the way an AI refuses one over its quota.
const WORDS: [Why, RegExp][] = [
  ["stopped", /you stopped it|^stopped$|it was stopped/i],
  ["month", /this month's \S+ spend reached its cap/i],
  ["limit", /reached its spend cap|error_max_budget/i],
  ["price", /doesn't know what .+ costs/i],
  ["changed", /isn't what its approval showed|changed after they were approved|which its approval didn't show/i],
  ["gone", /isn't on home any more|isn't on home at this version/i],
  ["unapproved", /no plan is approved/i],
  ["soon", /plan is coming soon|plan has no sign-in yet/i],
  ["sign-in", /sign-in didn't (take|start|finish)|couldn't (sign in|start the sign-in|finish the sign-in)|sign-in stopped|sign-in ran out|oauth (session|token)|log ?in (again|expired)/i],
  ["busy", /another build is (running|going)/i],
  ["setup", /couldn't fetch|isn't on the box yet/i],
  ["start", /way out didn't start|builder didn't start|no agentv-builder user|build folders aren't root's|build's folder isn't a folder/i],
  ["install", /couldn't be installed|isn't approved and waiting|no such build to install/i],
  ["slow", /took longer than/i],
  ["tries", /ran out of (turns|steps)|error_max_turns/i],
  ["unclear", /didn't say what it understood/i],
  ["steps", /didn't submit a plan/i],
  ["checks", /the static checks found|the app's manifest (doesn't list|lists)|offered tools of its own/i],
  ["tests", /tests? didn't pass|the test "|the test tv|agentv\.ready\(\)|registered no test/i],
  ["key", /\b401\b|authentication_error|invalid (x-)?api[- ]key|incorrect api key|api key (is )?(not valid|invalid)|refused the key/i],
  ["credit", /credit balance|insufficient_quota|exceeded your current quota|out of credit/i],
];

// The kind of failure a reason is, by its words, or nothing for one the
// table doesn't know.
export function whyOf(reason: string | undefined): Why | undefined {
  if (!reason) return undefined;
  return WORDS.find(([, words]) => words.test(reason))?.[0];
}

const dollars = (cap: number) => (Number.isInteger(cap) ? `$${cap}` : `$${cap.toFixed(2)}`);

export const WENT_WRONG = "Something went wrong";

const LINES: Record<Why, (told: Told) => string> = {
  stopped: () => "You stopped it",
  month: () => "It reached this month's limit",
  limit: ({ cap }) => (cap ? `It reached its ${dollars(cap)} limit` : "It reached its limit"),
  price: () => "Can't track what this AI costs, so it stopped",
  key: ({ ai }) => (ai ? `Your ${ai} key was refused` : "That key was refused"),
  credit: ({ ai }) => (ai ? `Your ${ai} key is out of credit` : "That key is out of credit"),
  slow: () => "It took too long",
  tries: () => "It took too many tries",
  unclear: () => "Couldn't follow that. Try other words.",
  steps: () => "Couldn't work out the steps",
  unapproved: () => "You didn't approve the steps, so nothing was made",
  changed: () => "It changed after you approved it",
  gone: () => "That app isn't on home any more",
  soon: ({ ai }) => `${ai ? `${ai}'s` : "That"} plan is coming soon. Use a key for now.`,
  "sign-in": ({ ai }) => `Couldn't sign in to ${ai ?? "your AI"}`,
  busy: () => "One at a time. Wait for the other app.",
  setup: ({ ai }) => `Couldn't get ${ai ?? "your AI"} ready`,
  start: () => "Couldn't start. Restart your TV and try again.",
  install: () => "Couldn't install it. Try again.",
  checks: () => "It didn't pass the safety checks",
  tests: () => "It didn't pass its tests",
};

// The one line a screen shows for a build that failed. The kind the builder
// gave comes first, then what the reason's own words say, and anything else
// is "Something went wrong".
export function plainReason(reason: string | undefined, told: Told = {}): string {
  const why = told.why ?? whyOf(reason);
  return why && LINES[why] ? LINES[why](told) : WENT_WRONG;
}
