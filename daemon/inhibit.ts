// Holds a systemd inhibitor that keeps the box awake while something that
// mustn't be cut off runs, such as a build or a download (ADR-072). Sleep
// as a setting (daemon/sleep.ts) never suspends past one. It's
// systemd-inhibit around a sleep that lasts until it's let go, in a process
// group of its own, so letting go ends both.

import { spawn, type ChildProcess } from "node:child_process";

export class Inhibitor {
  private why: string;
  private command: string[];
  private child: ChildProcess | null = null;

  constructor(why: string, command = ["systemd-inhibit", "--what=sleep", "--who=AgenTV", "--mode=block"]) {
    this.why = why;
    this.command = command;
  }

  get held(): boolean {
    return this.child !== null;
  }

  set(on: boolean): void {
    if (on && !this.child) {
      const child = spawn(this.command[0], [...this.command.slice(1), `--why=${this.why}`, "sleep", "infinity"], { stdio: "ignore", detached: true });
      const gone = () => {
        if (this.child === child) this.child = null;
      };
      child.on("error", gone);
      child.on("exit", gone);
      child.unref();
      this.child = child;
    } else if (!on && this.child) {
      const child = this.child;
      this.child = null;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
    }
  }
}
