// Sends one request to AgenTV's screen daemon and prints its answer, for
// bin/agentv-screen. Exits 0 when the answer says ok, 1 when it doesn't, and
// 2 when the daemon isn't there (no TV session).
//
// Usage: node screen-call.ts '<json request>'

import { createConnection } from "node:net";
import { join } from "node:path";

const request = process.argv[2] ?? "";
const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;
const path = join(runtime, "agentv", "screen.sock");
// Longer than the longest request: measuring frames or keys for up to 30 s.
const timeout = Number(process.env.AGENTV_SCREEN_TIMEOUT ?? 45) * 1000;

const socket = createConnection(path);
let answer = "";
const timer = setTimeout(() => {
  console.error("agentv screen: the screen daemon didn't answer in time");
  process.exit(1);
}, timeout);

socket.setEncoding("utf8");
socket.on("connect", () => socket.write(request.replace(/\n/g, " ") + "\n"));
socket.on("data", (chunk: string) => (answer += chunk));
socket.on("error", (error: NodeJS.ErrnoException) => {
  clearTimeout(timer);
  if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
    console.error("agentv screen: the TV session isn't running (no screen daemon)");
    process.exit(2);
  }
  console.error(`agentv screen: ${error.message}`);
  process.exit(1);
});
socket.on("close", () => {
  clearTimeout(timer);
  process.stdout.write(answer);
  try {
    process.exit(JSON.parse(answer).ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
});
