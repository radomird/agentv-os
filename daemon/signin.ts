// Signing in to an app's service on the TV (ADR-032, board 15). AgenTV
// stores no passwords: the service's own page takes them, typed on the
// phone or a keyboard, and keeps its own cookies in the services' profile.
//
// This asks an app with signIn, in its own worker and through its page,
// whether it's signed in: once when it opens, so its tile can say Sign in,
// and every 2 s while the sign-in screen is up, until it is. The screen
// daemon runs it, since it holds the app's page in the services' Chromium.

import type { AppHost, PageBroker, Viewer } from "./apps/loader.ts";

export const SIGN_IN_EVERY_MS = 2_000;
// How long the sign-in screen waits for a sign-in before it gives up.
export const SIGN_IN_FOR_MS = 15 * 60_000;
// How long a check, or the app's signIn.open, waits for its page to come up.
export const PAGE_WITHIN_MS = 30_000;
// How long an app that just opened gets before it's asked, so a page still
// loading isn't taken for one signed out.
export const SETTLE_MS = 3_000;
const RETRY_MS = 1_000;

export interface SignInDeps {
  // The app's worker, when it has signIn, or null.
  host(id: string): Promise<AppHost | null>;
  viewer(): Promise<Viewer>;
  // What the app said, for its tile.
  report(app: string, signedIn: boolean): Promise<void>;
  every?: number;
  within?: number; // how long the sign-in screen waits
  pageWithin?: number;
  settle?: number;
  retry?: number;
  log?: (line: string) => void;
}

interface Signing {
  host: AppHost;
  page: PageBroker;
  timer?: ReturnType<typeof setTimeout>;
  until: number;
  busy: boolean;
  done: (signedIn: boolean) => void;
}

export class SignInWatch {
  private deps: SignInDeps;
  private signing = new Map<string, Signing>();
  private log: (line: string) => void;

  constructor(deps: SignInDeps) {
    this.deps = deps;
    this.log = deps.log ?? (() => {});
  }

  // Asks the app once, as it opens, retrying while its page comes up, and
  // reports the answer. Null when the app has no signIn or never answered.
  async check(id: string, page: PageBroker): Promise<boolean | null> {
    const host = await this.deps.host(id).catch(() => null);
    if (!host) return null;
    await sleep(this.deps.settle ?? SETTLE_MS);
    const started = Date.now();
    try {
      for (;;) {
        const said = await this.ask(id, host, page, true);
        if (said !== null || Date.now() - started >= (this.deps.pageWithin ?? PAGE_WITHIN_MS)) return said;
        await sleep(this.deps.retry ?? RETRY_MS);
      }
    } finally {
      host.stop();
    }
  }

  // The sign-in screen is up: the app brings its page to the service's
  // sign-in form, if it knows how, and is asked every 2 s until it says it's
  // signed in. done(true) then, or done(false) when the screen gives up.
  // False when the app has no signIn.
  async start(id: string, page: PageBroker, done: (signedIn: boolean) => void): Promise<boolean> {
    this.stop(id);
    const host = await this.deps.host(id).catch(() => null);
    if (!host) return false;
    const signing: Signing = { host, page, done, busy: false, until: Date.now() + (this.deps.within ?? SIGN_IN_FOR_MS) };
    this.signing.set(id, signing);
    void this.open(id, signing).then(() => this.next(id, signing));
    return true;
  }

  // Asks now, as "i'm signed in" does. True ends the sign-in screen.
  async now(id: string): Promise<boolean | null> {
    const signing = this.signing.get(id);
    if (!signing) return null;
    const said = await this.ask(id, signing.host, signing.page, false);
    if (said) this.finish(id, signing, true);
    return said;
  }

  // The sign-in screen went away without a sign-in: Home, or the app closed.
  stop(id: string): void {
    const signing = this.signing.get(id);
    if (!signing) return;
    clearTimeout(signing.timer);
    this.signing.delete(id);
    signing.host.stop();
  }

  signingIn(): string[] {
    return [...this.signing.keys()];
  }

  // The app's signIn.open, tried each second while its page comes up. An
  // app without one leaves the page where it opened.
  private async open(id: string, signing: Signing): Promise<void> {
    const started = Date.now();
    while (this.signing.get(id) === signing) {
      signing.host.setPage(signing.page);
      try {
        await signing.host.call(await this.deps.viewer(), "signIn.open");
        return;
      } catch (error) {
        const message = (error as Error).message;
        if (/has no signIn\.open/.test(message)) return;
        if (Date.now() - started + (this.deps.retry ?? RETRY_MS) > (this.deps.pageWithin ?? PAGE_WITHIN_MS)) {
          this.log(`${id} couldn't show its sign-in form: ${message}`);
          return;
        }
        await sleep(this.deps.retry ?? RETRY_MS);
      }
    }
  }

  private next(id: string, signing: Signing): void {
    if (this.signing.get(id) !== signing) return;
    signing.timer = setTimeout(() => void this.tick(id, signing), this.deps.every ?? SIGN_IN_EVERY_MS);
  }

  private async tick(id: string, signing: Signing): Promise<void> {
    if (this.signing.get(id) !== signing) return;
    if (!signing.busy) {
      signing.busy = true;
      const said = await this.ask(id, signing.host, signing.page, false);
      signing.busy = false;
      if (this.signing.get(id) !== signing) return;
      if (said) return this.finish(id, signing, true);
    }
    if (Date.now() >= signing.until) {
      this.log(`${id}: no sign-in after ${Math.round((this.deps.within ?? SIGN_IN_FOR_MS) / 60_000)} minutes; the sign-in screen gives up`);
      return this.finish(id, signing, false);
    }
    this.next(id, signing);
  }

  private finish(id: string, signing: Signing, signedIn: boolean): void {
    if (this.signing.get(id) !== signing) return;
    clearTimeout(signing.timer);
    this.signing.delete(id);
    signing.host.stop();
    signing.done(signedIn);
  }

  // One isSignedIn. A false is reported only when reportFalse says so: while
  // the sign-in screen is up, the app isn't signed in yet, and that's known.
  private async ask(id: string, host: AppHost, page: PageBroker, reportFalse: boolean): Promise<boolean | null> {
    host.setPage(page);
    let signedIn: boolean;
    try {
      signedIn = Boolean(await host.call(await this.deps.viewer(), "signIn.isSignedIn"));
    } catch (error) {
      this.log(`${id} couldn't say whether it's signed in: ${(error as Error).message}`);
      return null;
    }
    if (signedIn || reportFalse) {
      await this.deps.report(id, signedIn).catch((error: Error) => this.log(`${id}'s sign-in couldn't be noted: ${error.message}`));
    }
    return signedIn;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
