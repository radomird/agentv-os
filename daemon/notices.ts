// The lines more than one part of the TV says, each written once, so the
// TV and the phone read the same words wherever they come from.

// A change that waits for the adult PIN.
export const NEEDS_PIN = "That needs the PIN";

// The TV's own screen isn't up to answer yet.
export const NOT_READY = "Your TV isn't ready yet";

export const WENT_WRONG = "Something went wrong";

export const NO_APP = "Couldn't find that app";

// Whether a reason is the PIN's, whatever its capitals.
export function needsPin(why: string | null | undefined): boolean {
  return typeof why === "string" && why.toLowerCase() === NEEDS_PIN.toLowerCase();
}
