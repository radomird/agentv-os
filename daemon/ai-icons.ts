// The AI providers' own icons, for setup's AI step and Settings → AI
// (ADR-069): each provider's site icon, the one a browser shows in its tab,
// fetched on the box from its site the first time a screen asks for it, as
// an app tile's is (daemon/site-icon.ts). It's kept with the daemon's state
// and never ships in a repo. With no icon, the screens show the name alone.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider } from "./ai.ts";
import { siteIcon } from "./site-icon.ts";

// Where each provider's icon comes from: its own site.
export const PROVIDER_SITES: Record<Provider, string> = {
  claude: "https://claude.ai/",
  chatgpt: "https://chatgpt.com/",
  gemini: "https://gemini.google.com/",
  grok: "https://grok.com/",
  muse: "https://www.meta.ai/",
};

// How long a site that gave no icon is left alone before it's asked again.
const RETRY_MS = 10 * 60_000;

export interface AiIconsOptions {
  state: string; // the daemon's own: ai-icons/
  userAgent: string;
  // Tests point the sites at stand-ins of their own.
  sites?: Partial<Record<Provider, string>>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export class AiIcons {
  private o: AiIconsOptions;
  private dir: string;
  private asking = new Map<Provider, Promise<{ type: string; body: Buffer } | null>>();
  private missed = new Map<Provider, number>();

  constructor(options: AiIconsOptions) {
    this.o = options;
    this.dir = join(options.state, "ai-icons");
  }

  site(provider: Provider): string {
    return this.o.sites?.[provider] ?? PROVIDER_SITES[provider];
  }

  // The provider's icon: the one kept, or fetched from its site now. Null
  // when its site has none, or couldn't be reached a moment ago.
  async icon(provider: Provider): Promise<{ type: string; body: Buffer } | null> {
    const kept = await this.kept(provider);
    if (kept) return kept;
    if (Date.now() - (this.missed.get(provider) ?? 0) < RETRY_MS) return null;
    let asking = this.asking.get(provider);
    if (!asking) {
      asking = this.fetchIcon(provider).finally(() => this.asking.delete(provider));
      this.asking.set(provider, asking);
    }
    return asking;
  }

  private async kept(provider: Provider): Promise<{ type: string; body: Buffer } | null> {
    try {
      const { type } = JSON.parse(await readFile(join(this.dir, `${provider}.json`), "utf8")) as { type?: unknown };
      const body = await readFile(join(this.dir, provider));
      return typeof type === "string" && body.length > 0 ? { type, body } : null;
    } catch {
      return null;
    }
  }

  private async fetchIcon(provider: Provider): Promise<{ type: string; body: Buffer } | null> {
    const site = this.site(provider);
    const icon = await siteIcon(site, { userAgent: this.o.userAgent, fetch: this.o.fetch });
    if (!icon) {
      this.missed.set(provider, Date.now());
      this.o.log?.(`${provider}'s site gave no icon, so setup shows its name alone`);
      return null;
    }
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, provider), icon.body);
    await writeFile(join(this.dir, `${provider}.json`), `${JSON.stringify({ type: icon.type, from: site, at: new Date().toISOString() })}\n`);
    this.o.log?.(`${provider}'s icon is kept, from its site`);
    return icon;
  }
}
