// npm packages in a built app (builder/packages.ts, ADR-044): the guards
// on by default, what turning safeguards off changes and what it doesn't,
// the bundle, the nightly re-check, and the builder's requests through its
// filter. The registry, OSV.dev, npm and esbuild are stand-ins here; the
// filter and TLS are the real ones.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NetFilter } from "../../../daemon/net-filter.ts";
import { fetchVia, osvFor, registryFor } from "../../../builder/fetch.ts";
import { check, keptBuilds } from "../../../builder/npm-check.ts";
import { isMalware, jail, lockProblems, type Packument, Packages, type Vuln } from "../../../builder/packages.ts";

const scratch = mkdtempSync(join(tmpdir(), "agentv-packages-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const NOW = new Date("2026-10-27T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const REG = "https://registry.npmjs.org/";
const sha = "sha512-" + "A".repeat(86) + "==";

// The registry: each package's versions, and when each was published.
const registry: Record<string, Packument> = {
  "left-pad": { name: "left-pad", description: "pads", license: "WTFPL", "dist-tags": { latest: "1.4.0" }, versions: { "1.3.0": {}, "1.4.0": {} }, time: { "1.3.0": ago(400), "1.4.0": ago(3) } },
  "evil-pkg": { name: "evil-pkg", versions: { "1.0.0": {} }, time: { "1.0.0": ago(100) } },
  "vuln-pkg": { name: "vuln-pkg", versions: { "2.0.0": {} }, time: { "2.0.0": ago(100) } },
  "nice-pkg": { name: "nice-pkg", versions: { "1.0.0": {} }, time: { "1.0.0": ago(100) } },
  "git-pkg": { name: "git-pkg", versions: { "1.0.0": {} }, time: { "1.0.0": ago(100) } },
};

// What each package's tree is, as npm would lock it.
const trees: Record<string, { name: string; version: string; resolved?: string; integrity?: string }[]> = {
  "nice-pkg": [{ name: "nice-pkg", version: "1.0.0" }, { name: "evil-dep", version: "0.1.0" }],
  "git-pkg": [{ name: "git-pkg", version: "1.0.0", resolved: "git+https://github.com/x/git-pkg.git" }],
};

// OSV.dev: which package versions have which advisories.
const osv: Record<string, string[]> = { "evil-pkg@1.0.0": ["MAL-2026-1"], "evil-dep@0.1.0": ["GHSA-mal1-0000-0000"], "vuln-pkg@2.0.0": ["GHSA-high-0000-0000"], "left-pad@1.3.0": ["GHSA-low0-0000-0000"] };
const vulns: Record<string, Vuln> = {
  "MAL-2026-1": { id: "MAL-2026-1", summary: "Malicious code in evil-pkg" },
  "GHSA-mal1-0000-0000": { id: "GHSA-mal1-0000-0000", summary: "Malicious code in evil-dep", database_specific: { cwe_ids: ["CWE-506"], severity: "CRITICAL" } },
  "GHSA-high-0000-0000": { id: "GHSA-high-0000-0000", summary: "Prototype pollution", database_specific: { severity: "HIGH" } },
  "GHSA-low0-0000-0000": { id: "GHSA-low0-0000-0000", summary: "A slow regex", database_specific: { severity: "LOW" } },
};

interface Ran {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function packages(name: string, safeguards = true) {
  const work = join(scratch, name);
  mkdirSync(work, { recursive: true });
  const ran: Ran[] = [];
  const p = new Packages({
    work,
    safeguards,
    home: "/var/lib/agentv/builder",
    packument: async (n) => registry[n] ?? null,
    osvBatch: async (list) => list.map((x) => osv[`${x.name}@${x.version}`] ?? []),
    osvVuln: async (id) => vulns[id] ?? null,
    proxy: "http://127.0.0.1:8080",
    now: () => NOW,
    run: async (command, args, cwd, env) => {
      ran.push({ command, args, env });
      if (command === "npm" && args[0] === "install") {
        const [spec] = args.slice(1);
        const at = spec.lastIndexOf("@");
        const [pkg, version] = [spec.slice(0, at), spec.slice(at + 1)];
        const tree = trees[pkg] ?? [{ name: pkg, version }];
        const lock = { lockfileVersion: 3, packages: { "": { name: "app" }, ...Object.fromEntries(tree.map((t) => [`node_modules/${t.name}`, { version: t.version, resolved: t.resolved ?? `${REG}${t.name}/-/${t.name}-${t.version}.tgz`, integrity: t.integrity ?? sha }])) } };
        writeFileSync(join(cwd, "package-lock.json"), JSON.stringify(lock));
        const json = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
        json.dependencies = { ...json.dependencies, [pkg]: version };
        writeFileSync(join(cwd, "package.json"), JSON.stringify(json));
      }
      return { code: 0, out: "" };
    },
  });
  return { p, work, ran };
}

test("npm_info lists a package's versions, newest first, and says which are too new", async () => {
  const { p } = packages("info");
  const said = await p.info("left-pad");
  assert.match(said, /left-pad: pads/);
  assert.ok(said.indexOf("1.4.0") < said.indexOf("1.3.0"));
  assert.match(said, /1\.4\.0, .*too new: published 3 days ago/);
  await assert.rejects(p.info("--registry=https://evil.example"), /a package's name/);
  await assert.rejects(p.info("nope-not-here"), /there's no nope-not-here/);
});

test("by default a package comes at an exact version from before the wait, with no script run", async () => {
  const { p, work, ran } = packages("guarded");
  const said = await p.add("left-pad", undefined);
  assert.match(said, /added left-pad@1\.3\.0/, "the newest version older than 7 days");
  assert.match(said, /below high: left-pad@1\.3\.0: GHSA-low0/, "a low advisory is said, not refused");
  const install = ran.find((r) => r.args[0] === "install")!;
  assert.ok(install.args.includes("--package-lock-only") && install.args.includes("--ignore-scripts") && install.args.includes("--save-exact"));
  assert.ok(install.args.includes(`--before=${ago(7)}`), "the whole tree is from before the wait");
  assert.equal(install.env.npm_config_https_proxy, "http://127.0.0.1:8080", "through the sandbox's filter");
  const ci = ran.find((r) => r.args[0] === "ci")!;
  assert.equal(ci.command, "npm");
  assert.ok(ci.args.includes("--ignore-scripts"));
  assert.equal(JSON.parse(readFileSync(join(work, "package.json"), "utf8")).dependencies["left-pad"], "1.3.0");
  await assert.rejects(p.add("left-pad", "1.4.0"), /published 3 days ago, and the wait is 7 days/);
  await assert.rejects(p.add("left-pad", "^1.3.0"), /an exact version/);
});

test("known malware is refused anywhere in the tree, even with safeguards off, and the build is left as it was", async () => {
  for (const safeguards of [true, false]) {
    const { p, work, ran } = packages(`malware-${safeguards}`, safeguards);
    await p.add("left-pad", "1.3.0");
    const before = { pkg: readFileSync(join(work, "package.json"), "utf8"), lock: readFileSync(join(work, "package-lock.json"), "utf8") };
    await assert.rejects(p.add("evil-pkg", "1.0.0"), /known malware, refused whatever the safeguards say: evil-pkg@1\.0\.0: MAL-2026-1/);
    await assert.rejects(p.add("nice-pkg", "1.0.0"), /known malware.*evil-dep@0\.1\.0/, "a dependency's malware too");
    assert.equal(readFileSync(join(work, "package.json"), "utf8"), before.pkg);
    assert.equal(readFileSync(join(work, "package-lock.json"), "utf8"), before.lock);
    assert.equal(ran.filter((r) => r.args.includes("ci")).length, 1, "nothing of theirs was installed");
  }
  assert.ok(isMalware({ id: "GHSA-x", aliases: ["MAL-2026-9"] }));
});

test("a high or critical vulnerability is refused with safeguards on, and said with them off", async () => {
  await assert.rejects(packages("vuln-on").p.add("vuln-pkg", "2.0.0"), /a known high or critical vulnerability: vuln-pkg@2\.0\.0: GHSA-high/);
  const said = await packages("vuln-off", false).p.add("vuln-pkg", "2.0.0");
  assert.match(said, /which the safeguards would refuse: vuln-pkg@2\.0\.0: GHSA-high/);
});

test("with safeguards off, the wait is off and scripts run, under bubblewrap with the builder's home hidden", async () => {
  const { p, work, ran } = packages("off", false);
  assert.match(await p.add("left-pad", "1.4.0"), /added left-pad@1\.4\.0/);
  const install = ran.find((r) => r.args[0] === "install")!;
  assert.ok(!install.args.some((a) => a.startsWith("--before")));
  assert.ok(install.args.includes("--ignore-scripts"), "resolving the tree still runs nothing");
  const ci = ran.find((r) => r.command === "bwrap")!;
  assert.ok(ci, "npm ci runs in bubblewrap");
  const args = ci.args.join(" ");
  assert.ok(args.includes("--ro-bind / /"), "the system read-only");
  assert.ok(args.includes("--tmpfs /var/lib/agentv/builder"), "the builder's home, with its CLI and any sign-in, out of sight");
  assert.ok(args.includes(`--bind ${work} ${work}`), "only the work folder to write");
  assert.deepEqual(ci.args.slice(ci.args.indexOf("--") + 1, ci.args.indexOf("--") + 3), ["npm", "ci"]);
  assert.ok(!ci.args.includes("--ignore-scripts"));
  assert.equal(ci.env.HOME, "/tmp/home");
  assert.deepEqual(jail(work, "/h").slice(-1), ["--"]);
});

test("a package from anywhere but the registry, or without its integrity, is refused whatever the safeguards say", async () => {
  await assert.rejects(packages("git", false).p.add("git-pkg", "1.0.0"), /comes from git\+https:\/\/github\.com\/x\/git-pkg\.git, not the npm registry/);
  assert.match(lockProblems([{ name: "x", version: "1.0.0", resolved: `${REG}x/-/x-1.0.0.tgz`, integrity: "sha1-abc" }])[0], /no sha512 integrity/);
  assert.match(lockProblems([{ name: "x", version: "latest", resolved: `${REG}x` }])[0], /exact version/);
});

test("bundle builds app/main.js from src/main.js with esbuild, for a browser", async () => {
  const { p, work, ran } = packages("bundle");
  await assert.rejects(p.bundle(), /there's no src\/main\.js/);
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "src/main.js"), "import pad from 'left-pad';\n");
  assert.match(await p.bundle(), /bundled src\/main\.js into app\/main\.js/);
  const esbuild = ran.find((r) => r.command === "esbuild")!;
  for (const arg of ["src/main.js", "--bundle", "--platform=browser", "--outfile=app/main.js"]) assert.ok(esbuild.args.includes(arg), arg);
});

test("the nightly check warns about an app whose package turned bad, and keeps when it was first seen", async () => {
  const root = join(scratch, "builds");
  const add = (id: string, version: string, state: string, tree: { name: string; version: string }[]) => {
    const dir = join(root, id, version);
    mkdirSync(join(dir, "work"), { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ build: `b-${id}`, state }));
    writeFileSync(join(dir, "work", "package-lock.json"), JSON.stringify({ packages: Object.fromEntries(tree.map((t) => [`node_modules/${t.name}`, { version: t.version }])) }));
  };
  add("local.blocks", "1.0.0", "installed", [{ name: "left-pad", version: "1.3.0" }]);
  add("local.weather", "1.0.0", "installed", [{ name: "vuln-pkg", version: "2.0.0" }, { name: "evil-dep", version: "0.1.0" }]);
  add("local.halfway", "1.0.0", "failed", [{ name: "evil-pkg", version: "1.0.0" }]);
  assert.deepEqual(keptBuilds(root).map((b) => b.id).sort(), ["local.blocks", "local.weather"], "only approved and installed apps");
  const source = { batch: async (list: { name: string; version: string }[]) => list.map((x) => osv[`${x.name}@${x.version}`] ?? []), vuln: async (id: string) => vulns[id] ?? null };
  const first = await check(root, null, source, NOW);
  assert.equal(first.apps.length, 1, "a low advisory isn't a warning");
  assert.equal(first.apps[0].id, "local.weather");
  assert.match(first.apps[0].malware[0], /evil-dep/);
  assert.match(first.apps[0].serious[0], /vuln-pkg/);
  const later = await check(root, first, source, new Date(NOW.getTime() + 86_400_000));
  assert.equal(later.apps[0].since, first.apps[0].since);
});

// --- Through the filter, for real ----------------------------------------

test("the builder's requests go through its filter to the site itself, with the site's certificate checked", async () => {
  const dir = join(scratch, "tls");
  mkdirSync(dir, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=registry.test", "-addext", "subjectAltName=DNS:registry.test,DNS:api.osv.test", "-days", "2", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  const cert = readFileSync(join(dir, "cert.pem"));
  const site = createServer({ key: readFileSync(join(dir, "key.pem")), cert }, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/left-pad") res.end(JSON.stringify(registry["left-pad"]));
      else if (req.url === "/v1/querybatch") res.end(JSON.stringify({ results: JSON.parse(body).queries.map((q: { package: { name: string } }) => (q.package.name === "evil-pkg" ? { vulns: [{ id: "MAL-2026-1" }] } : {})) }));
      else if (req.url === "/v1/vulns/MAL-2026-1") res.end(JSON.stringify(vulns["MAL-2026-1"]));
      else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", () => done()));
  const port = (site.address() as { port: number }).port;
  const filter = new NetFilter({
    policy: (host, p, scheme) => scheme === "https" && ["registry.test", "api.osv.test"].includes(host) && p === port,
    resolve: async () => "127.0.0.1",
    forbid: () => false,
  });
  const proxy = `http://127.0.0.1:${await filter.listen(0)}`;
  try {
    const options = { ca: cert, port };
    const doc = await registryFor(proxy, options, "https://registry.test/")("left-pad");
    assert.equal(doc.name, "left-pad");
    const osvApi = osvFor(proxy, options, "https://api.osv.test/v1/");
    assert.deepEqual(await osvApi.batch([{ name: "left-pad", version: "1.3.0" }, { name: "evil-pkg", version: "1.0.0" }]), [[], ["MAL-2026-1"]]);
    assert.equal((await osvApi.vuln("MAL-2026-1")).id, "MAL-2026-1");
    await assert.rejects(fetchVia(proxy, "https://github.com/", { ca: cert, port }), /doesn't let it reach github\.com/, "S6.8: never GitHub");
    await assert.rejects(fetchVia(proxy, "https://registry.test/left-pad", { port }), /certificate|self-signed|self signed/i, "a certificate it can't check is refused");
    await assert.rejects(fetchVia(proxy, "http://registry.test/left-pad"), /https sites only/);
  } finally {
    site.close();
    await filter.close();
  }
});

