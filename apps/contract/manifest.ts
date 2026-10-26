// The manifest every app package carries (ADR-010, ADR-016), and the checks
// that `agentv app validate`, the installer and the builder run on a package
// before anything in it loads. They follow `omarchy plugin validate`:
// schemaVersion 1, the required fields, safe relative entry points that
// exist, no symlinks and no reserved id. Then the tv block's own rules, and a
// look at the code: Node has to be able to run it as it is, and it may import
// only files from its own package.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, posix } from "node:path";
import type { TileSize } from "./contract.ts";

export const CONTRACT = 1;

// Where an app came from decides its tier, never the manifest (PHASE-1-PLAN.md):
// the project's signed index or a built-in for official, the index's community
// listings, or the box's own agent for local.
export type Tier = "official" | "community" | "local";

export type Kind = "tv-app" | "tv-background-source";
const KINDS: Record<Kind, "tvApp" | "backgroundSource"> = {
  "tv-app": "tvApp",
  "tv-background-source": "backgroundSource",
};

export const CATEGORIES = ["streaming", "music", "media", "photos", "games", "utility"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CAPABILITIES = ["launch", "signIn", "search", "playback", "profiles", "nowPlaying", "tile"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type SetupStep = { type: "field"; key: string; label: string } | { type: "signIn" };

export interface TvBlock {
  contract: number;
  category: Category;
  // builtin: one of AgenTV's own apps in apps/builtin/, which come with
  // AgenTV and which the launcher opens itself (ADR-015, ADR-017)
  runtime: "web" | "native" | "builtin";
  homeUrl?: string; // web: may start with a setup field, like "{serverUrl}/web/"
  package?: { pacman?: string; flatpak?: string }; // native
  exec?: string[]; // native: the command and its arguments
  capabilities: Capability[];
  setup?: SetupStep[];
  origins?: string[]; // everything the app may reach, as origins or a setup field
  icon?: string;
  tiles?: Partial<Record<TileSize, string>>;
  childSafe?: boolean;
}

export interface Manifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  author: string;
  license: string;
  description: string;
  kinds: Kind[];
  entryPoints: { tvApp?: string; backgroundSource?: string };
  tv: TvBlock;
}

export interface Result {
  manifest?: Manifest; // only when there are no problems
  problems: string[];
}

const RESERVED = ["agentv", "local", "omarchy"];
const ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const NAMESPACE = /^[a-z0-9][a-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const PACKAGE = /^[A-Za-z0-9@._+-]+$/;
const CODE = [".ts", ".js"];
const ICONS = [".png", ".svg", ".webp", ".jpg", ".jpeg"];
const TILE_LABEL_MAX = 24;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// A path inside the package, relative, with nothing that climbs out of it.
// Returns why it isn't one, or null.
export function unsafePath(path: unknown): string | null {
  if (typeof path !== "string" || path === "") return "is empty";
  if (/[\0\n\r]/.test(path)) return "has a control character in it";
  if (path.includes("\\")) return "has a backslash in it";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "isn't a relative path";
  if (path.split("/").includes("..")) return "has '..' in it";
  return null;
}

// Every regular file in the package, relative to it with forward slashes.
// Symlinks and anything that isn't a file or a folder are problems, wherever
// they are; a git checkout's own .git folder is skipped, as Omarchy does.
function walk(root: string, problem: (text: string) => void): Set<string> {
  const files = new Set<string>();
  const visit = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        problem(`symlinks aren't allowed in an app package: ${rel}`);
      } else if (stat.isDirectory()) {
        if (entry.name !== ".git") visit(full, rel);
      } else if (stat.isFile()) {
        files.add(rel);
      } else {
        problem(`only files and folders are allowed in an app package: ${rel}`);
      }
    }
  };
  visit(root, "");
  return files;
}

// The setup fields an address starts with, like "{serverUrl}". A field may
// only stand for a whole origin, at the very start.
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([^}]*)\}/g)].map((match) => match[1]);
}

function fieldOrigin(value: string): string | null {
  const match = /^\{([A-Za-z][A-Za-z0-9]*)\}(?=\/|$)/.exec(value);
  return match ? `https://${match[1].toLowerCase()}.field.invalid` : null;
}

// The origin of an address, with a setup field standing in for a server.
function originOf(value: string): string | null {
  const field = /^\{([A-Za-z][A-Za-z0-9]*)\}/.exec(value);
  const concrete = field ? `${fieldOrigin(field[0])}${value.slice(field[0].length)}` : value;
  try {
    const url = new URL(concrete);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

// The imports Node would load at run time: types are stripped first, so an
// `import type` from the contract is fine.
const STATIC_IMPORT = /(?:^|[;\s}])(?:import|export)\s*(?:[\w*{}\s,$]*?\s*from\s*)?["']([^"'\n]+)["']/g;

function checkCode(root: string, files: Set<string>, rel: string, problem: (text: string) => void): void {
  let source = readFileSync(join(root, rel), "utf8");
  if (rel.endsWith(".ts")) {
    try {
      source = stripTypeScriptTypes(source, { mode: "strip" });
    } catch (error) {
      problem(`${rel} uses TypeScript that Node can't run as it is (${(error as Error).message.split("\n")[0]})`);
      return;
    }
  }
  if (/\brequire\s*\(/.test(source)) problem(`${rel} calls require(), which apps can't use`);
  if (/\bimport\s*\(/.test(source)) problem(`${rel} uses import(), which apps can't use; import files statically instead`);
  if (/\bgetBuiltinModule\b/.test(source)) problem(`${rel} reaches for Node's own modules, which apps can't use`);
  for (const match of source.matchAll(STATIC_IMPORT)) {
    const specifier = match[1];
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      problem(`${rel} imports ${specifier}; an app can only import files from its own package`);
      continue;
    }
    const target = posix.normalize(posix.join(posix.dirname(rel), specifier));
    if (target.startsWith("../") || target === "..") {
      problem(`${rel} imports ${specifier}, which is outside the package`);
    } else if (!files.has(target)) {
      problem(`${rel} imports ${specifier}, which isn't in the package`);
    }
  }
}

function checkId(id: string, author: unknown, tier: Tier, problem: (text: string) => void): void {
  if (!ID.test(id)) {
    problem(`the id '${id}' isn't valid: lowercase words joined by dots, like agentv.jellyfin`);
    return;
  }
  const namespace = id.split(".")[0];
  if (tier === "official") {
    if (namespace !== "agentv") problem(`an official app's id starts with agentv., not '${id}'`);
  } else if (tier === "local") {
    if (namespace !== "local") problem(`an app built on this box has an id that starts with local., not '${id}'`);
  } else if (namespace === "agentv") {
    problem(`the id '${id}' uses agentv.*, which is only for AgenTV's own apps`);
  } else if (RESERVED.includes(namespace)) {
    problem(`the id '${id}' uses ${namespace}.*, which is reserved`);
  } else if (typeof author === "string" && NAMESPACE.test(author) && namespace !== author) {
    problem(`a community app's id starts with its author, ${author}., not '${id}'`);
  } else if (typeof author === "string" && !NAMESPACE.test(author)) {
    problem(`a community app's author is a lowercase name that its ids start with, not '${author}'`);
  }
}

function checkTv(tv: Record<string, unknown>, kinds: Kind[], files: Set<string>, tier: Tier, problem: (text: string) => void): void {
  if (tv.contract !== CONTRACT) problem(`tv.contract has to be ${CONTRACT}`);
  if (!CATEGORIES.includes(tv.category as Category)) problem(`tv.category has to be one of ${CATEGORIES.join(", ")}`);

  const fields = new Set<string>();
  if (tv.setup !== undefined) {
    if (!Array.isArray(tv.setup)) {
      problem("tv.setup has to be a list of steps");
    } else {
      let signIns = 0;
      for (const step of tv.setup) {
        if (isObject(step) && step.type === "field") {
          if (typeof step.key !== "string" || !FIELD_KEY.test(step.key)) {
            problem(`a setup field's key is a word of letters and digits, not '${String(step.key)}'`);
          } else if (fields.has(step.key)) {
            problem(`the setup field '${step.key}' is there twice`);
          } else {
            fields.add(step.key);
          }
          if (!text(step.label)) problem(`the setup field '${String(step.key)}' needs a label`);
        } else if (isObject(step) && step.type === "signIn") {
          signIns++;
        } else {
          problem("each setup step is a field or a sign-in");
        }
      }
      if (signIns > 1) problem("setup has more than one sign-in step");
    }
  }

  const capabilities = Array.isArray(tv.capabilities) ? tv.capabilities : [];
  if (!Array.isArray(tv.capabilities)) {
    problem("tv.capabilities has to be a list");
  } else {
    for (const capability of capabilities) {
      if (!CAPABILITIES.includes(capability as Capability)) {
        problem(`'${String(capability)}' isn't a capability; they're ${CAPABILITIES.join(", ")}`);
      }
    }
    if (new Set(capabilities).size !== capabilities.length) problem("tv.capabilities lists a capability twice");
    if (kinds.includes("tv-app") && !capabilities.includes("launch")) problem("every TV app has the launch capability");
  }

  const addresses: string[] = [];
  if (tv.origins !== undefined) {
    if (!Array.isArray(tv.origins) || tv.origins.length === 0) {
      problem("tv.origins has to be a list of origins");
    } else {
      for (const origin of tv.origins) {
        if (typeof origin !== "string") {
          problem("each of tv.origins is an origin, like https://example.org");
          continue;
        }
        addresses.push(origin);
        const field = fieldOrigin(origin);
        if (field ? origin !== `{${placeholders(origin)[0]}}` : originOf(origin) !== origin) {
          problem(`'${origin}' isn't an origin: a scheme and a host, like https://example.org, or one setup field, like {serverUrl}`);
        }
      }
    }
  }

  if (tv.runtime === "web") {
    if (typeof tv.homeUrl !== "string") {
      problem("a web app has a tv.homeUrl");
    } else {
      addresses.push(tv.homeUrl);
      const origin = originOf(tv.homeUrl);
      const allowed = (Array.isArray(tv.origins) ? tv.origins : []).map((value) => originOf(String(value)));
      if (!origin) {
        problem(`tv.homeUrl '${tv.homeUrl}' isn't an http or https address`);
      } else if (!allowed.includes(origin)) {
        problem(`tv.homeUrl '${tv.homeUrl}' is outside the app's tv.origins`);
      }
    }
    if (tv.origins === undefined) problem("a web app lists the origins it may reach in tv.origins");
    if (tv.package !== undefined || tv.exec !== undefined) problem("a web app has no tv.package or tv.exec");
  } else if (tv.runtime === "native") {
    const pkg = tv.package;
    const sources = isObject(pkg) ? Object.keys(pkg) : [];
    if (!isObject(pkg) || sources.length !== 1 || !["pacman", "flatpak"].includes(sources[0])) {
      problem('a native app names one package, like { "pacman": "steam" } or { "flatpak": "tv.plex.PlexHTPC" }');
    } else if (typeof pkg[sources[0]] !== "string" || !PACKAGE.test(pkg[sources[0]] as string)) {
      problem(`'${String(pkg[sources[0]])}' isn't a package name`);
    }
    if (!Array.isArray(tv.exec) || tv.exec.length === 0 || !tv.exec.every((arg) => typeof arg === "string")) {
      problem("a native app has a tv.exec: the command and its arguments");
    } else if (!COMMAND.test(tv.exec[0])) {
      problem(`tv.exec starts with a command name, not '${tv.exec[0]}'`);
    }
    if (tv.homeUrl !== undefined) problem("a native app has no tv.homeUrl");
  } else if (tv.runtime === "builtin") {
    // Only AgenTV's own apps come built in, and the installer never takes
    // one from the index (install.ts).
    if (tier !== "official") problem("only AgenTV's own built-in apps have tv.runtime builtin");
    if (tv.homeUrl !== undefined || tv.package !== undefined || tv.exec !== undefined) {
      problem("a built-in app has no tv.homeUrl, tv.package or tv.exec");
    }
  } else if (kinds.includes("tv-app")) {
    problem("tv.runtime has to be web or native");
  }

  for (const address of addresses) {
    for (const key of placeholders(address)) {
      if (!fields.has(key)) problem(`'${address}' uses {${key}}, which isn't one of the app's setup fields`);
    }
  }

  if (tv.icon !== undefined) {
    const why = unsafePath(tv.icon);
    if (why) {
      problem(`tv.icon ${why}: '${String(tv.icon)}'`);
    } else if (!ICONS.includes(extname(tv.icon as string).toLowerCase())) {
      problem(`tv.icon is a ${ICONS.join(", ")} file, not '${String(tv.icon)}'`);
    } else if (!files.has(posix.normalize(tv.icon as string))) {
      problem(`tv.icon '${String(tv.icon)}' isn't in the package`);
    }
  }

  if (tv.tiles !== undefined) {
    if (!isObject(tv.tiles)) {
      problem("tv.tiles maps the sizes s, m and l to a few words each");
    } else {
      for (const [size, label] of Object.entries(tv.tiles)) {
        if (!["s", "m", "l"].includes(size)) problem(`'${size}' isn't a tile size; they're s, m and l`);
        if (!text(label) || label.length > TILE_LABEL_MAX) {
          problem(`the label for tile size ${size} is up to ${TILE_LABEL_MAX} characters`);
        }
      }
      // Medium and large are drawn from tile(), except the medium "continue"
      // tile every app with playback gets from the ledger (ADR-016).
      const tile = capabilities.includes("tile");
      if ("l" in tv.tiles && !tile) problem("the large tile needs the tile capability");
      if ("m" in tv.tiles && !tile && !capabilities.includes("playback")) {
        problem("the medium tile needs the tile capability, or playback for the continue tile");
      }
    }
  }

  if (tv.childSafe !== undefined && typeof tv.childSafe !== "boolean") problem("tv.childSafe is true or false");
}

// Checks the app package in dir as an app of the given tier.
export function validatePackage(dir: string, tier: Tier = "community"): Result {
  const problems: string[] = [];
  const problem = (text: string) => problems.push(text);

  try {
    if (!lstatSync(dir).isDirectory()) return { problems: [`${dir} isn't a folder`] };
  } catch {
    return { problems: [`there's no app package at ${dir}`] };
  }

  const files = walk(dir, problem);
  if (!files.has("manifest.json")) return { problems: [...problems, "the package has no manifest.json"] };

  let m: unknown;
  try {
    m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch (error) {
    return { problems: [...problems, `manifest.json isn't valid JSON (${(error as Error).message})`] };
  }
  if (!isObject(m)) return { problems: [...problems, "manifest.json has to be an object"] };

  if (m.schemaVersion !== 1) problem("schemaVersion has to be 1");
  for (const field of ["id", "name", "version", "author", "license", "description"]) {
    if (!text(m[field])) problem(`the manifest needs a ${field}`);
  }
  if (typeof m.id === "string") checkId(m.id, m.author, tier, problem);
  if (typeof m.version === "string" && !VERSION.test(m.version)) {
    problem(`the version '${m.version}' isn't a version like 1.0.0`);
  }

  const kinds: Kind[] = [];
  if (!Array.isArray(m.kinds) || m.kinds.length === 0) {
    problem("kinds has to be a list with tv-app or tv-background-source");
  } else {
    for (const kind of m.kinds) {
      if (kind in KINDS && !kinds.includes(kind as Kind)) kinds.push(kind as Kind);
      else problem(`'${String(kind)}' isn't a kind an app can have; they're ${Object.keys(KINDS).join(" and ")}`);
    }
  }

  const code: string[] = [];
  if (!isObject(m.entryPoints)) {
    problem("entryPoints has to be an object");
  } else {
    for (const [key, path] of Object.entries(m.entryPoints)) {
      if (!Object.values(KINDS).includes(key as "tvApp")) {
        problem(`'${key}' isn't an entry point; they're ${Object.values(KINDS).join(" and ")}`);
        continue;
      }
      const why = unsafePath(path);
      if (why) {
        problem(`the entry point ${key} ${why}: '${String(path)}'`);
      } else if (!CODE.includes(extname(path as string))) {
        problem(`the entry point ${key} is a .ts or .js file, not '${String(path)}'`);
      } else if (!files.has(posix.normalize(path as string))) {
        problem(`the entry point ${key} '${String(path)}' isn't in the package`);
      }
    }
    for (const kind of kinds) {
      if (!(KINDS[kind] in m.entryPoints)) problem(`the kind ${kind} needs entryPoints.${KINDS[kind]}`);
    }
  }

  for (const file of files) {
    if (CODE.includes(extname(file))) code.push(file);
  }
  for (const file of [...code].sort()) checkCode(dir, files, file, problem);

  if (!isObject(m.tv)) {
    problem("the manifest needs a tv block");
  } else {
    checkTv(m.tv, kinds, files, tier, problem);
  }

  return problems.length ? { problems } : { manifest: m as unknown as Manifest, problems };
}

