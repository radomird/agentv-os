// The phone's trackpad and keys on Omarchy's desktop (ADR-008, ADR-037). The
// TV session's screen daemon takes them while the TV is on; on the desktop,
// which is a session of its own (ADR-031), this does, through the same
// virtual input device. The daemon knows the desktop is on while this holds
// its stream open, and the phone's remote opens on the trackpad. Omarchy's
// post-boot hook starts it (bin/agentv-desktop-hook), and it stops with the
// desktop's session.

import { RemoteInput } from "./remote.ts";

const remote = new RemoteInput({ url: "http://127.0.0.1:3000/api/remote", as: "desktop" });
remote.start();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    remote.stop();
    process.exit(0);
  });
}
