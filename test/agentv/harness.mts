// What the tests give the app loader (daemon/apps/loader.ts) that the box
// never does. Their stand-in servers are on this machine, which an app on
// the box never reaches, so thisBox lets them be reached. An app's worker
// runs under bubblewrap wherever it can start; where it can't, such as a
// machine that doesn't let a plain user make a namespace, the worker runs
// without it and the tests of the sandbox itself are skipped.

import { sandboxProblem } from "../../daemon/apps/loader.ts";

export const SANDBOX_PROBLEM = sandboxProblem();
export const HARNESS = { thisBox: true, noSandbox: SANDBOX_PROBLEM !== null };
