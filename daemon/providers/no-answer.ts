// Why the TV has no answer to what was asked, each in one plain line.
//
// What an AI's own service says when it refuses a key or is busy is for
// whoever is fixing it: it goes in the router's log. A screen shows the line
// here for that kind of failure, with the AI's name where the TV knows it,
// and "Couldn't answer just now" for anything this table doesn't know.

// The kinds an AI's side gives, as one request to it fails.
export const NO_ANSWER = {
  slow: (ai?: string) => `${ai ?? "Your AI"} took too long`,
  unreachable: (ai?: string) => `Couldn't reach ${ai ?? "your AI"}`,
  key: (ai?: string) => (ai ? `Your ${ai} key was refused` : "That key was refused"),
  busy: (ai?: string) => `${ai ?? "Your AI"} is busy, or the key is out of credit`,
  empty: (ai?: string) => `${ai ?? "Your AI"} gave no answer. Try again.`,
};

// And the ones from the TV's own side of it, which name no AI.
export const NOT_SIGNED_IN = "Sign in to your plan first, in Settings";
export const SIGN_IN_RAN_OUT = "Your plan's sign-in expired. Sign in again.";
export const TOOK_TOO_LONG = "That took too long. Try again.";
export const CANT_ANSWER = "Can't answer right now";
export const TOO_MANY = "Too many requests. Try again in a minute.";

export const COULDNT_ANSWER = "Couldn't answer just now";

const AS_IT_IS = new Set([NOT_SIGNED_IN, SIGN_IN_RAN_OUT, TOOK_TOO_LONG, CANT_ANSWER, TOO_MANY]);

// The line for a sentence that got no answer, from why the router says it
// failed. Only a line from this file is ever shown.
export function noAnswer(error: string | undefined, ai?: string): string {
  if (!error) return COULDNT_ANSWER;
  if (AS_IT_IS.has(error)) return error;
  for (const line of Object.values(NO_ANSWER)) if (error === line()) return line(ai);
  return COULDNT_ANSWER;
}
