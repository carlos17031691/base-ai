import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, YAMLSeq } from "yaml";
import { aiSync } from "./sync.js";

export interface Service {
  name: string;
  repo?: string;
  /** Omitted = the remote's default branch. */
  branch?: string;
  template?: string;
  ai?: "inherit" | "none";
}

const NAME_RE = /^[a-z0-9-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const manifestPath = (root: string) => join(root, "services.yaml");

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function validateName(name: string | undefined): string {
  if (!name || !NAME_RE.test(name)) throw new Error(`Invalid service name "${name ?? ""}" (must match ^[a-z0-9-]+$)`);
  return name;
}

function validateRepo(repo: string | undefined): string {
  if (!repo || repo.startsWith("-")) throw new Error(`Invalid repository URL "${repo ?? ""}"`);
  return repo;
}

function validateBranch(branch: string | undefined): string | undefined {
  if (branch !== undefined && (branch.startsWith("-") || !BRANCH_RE.test(branch))) throw new Error(`Invalid branch "${branch}"`);
  return branch;
}

/** Reads services.yaml preserving comments. */
function loadDoc(root: string) {
  const p = manifestPath(root);
  const doc = parseDocument(existsSync(p) ? readFileSync(p, "utf8") : "version: 1\nservices: []\n");
  let seq = doc.get("services");
  if (!isSeq(seq)) {
    seq = new YAMLSeq();
    doc.set("services", seq);
  }
  return { doc, seq: seq as YAMLSeq };
}

export function listServices(root: string): Service[] {
  return (loadDoc(root).seq.toJSON() as Service[]) ?? [];
}

function addEntry(root: string, svc: Service): void {
  const { doc, seq } = loadDoc(root);
  if (seq.items.some((i) => isMap(i) && i.get("name") === svc.name)) throw new Error(`Service "${svc.name}" already exists in services.yaml`);
  seq.flow = false;
  seq.add(doc.createNode(Object.fromEntries(Object.entries(svc).filter(([, v]) => v !== undefined))));
  writeFileSync(manifestPath(root), doc.toString());
}

/** Replaces {{name}} in the content of the copied template files. */
function renderTemplate(dir: string, name: string): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      renderTemplate(abs, name);
      continue;
    }
    const text = readFileSync(abs, "utf8");
    if (text.includes("{{name}}")) writeFileSync(abs, text.replaceAll("{{name}}", name));
  }
}

/** service new: creates src/<name> from templates/<template>, runs git init and registers it. */
export function serviceNew(root: string, rawName: string | undefined, template = "service", repo?: string): string {
  const name = validateName(rawName);
  const tpl = join(root, "templates", validateName(template));
  const dest = join(root, "src", name);
  if (!existsSync(tpl)) throw new Error(`Template not found: ${tpl}`);
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  if (repo) validateRepo(repo);

  addEntry(root, { name, repo, template, ai: "inherit" });
  cpSync(tpl, dest, { recursive: true });
  renderTemplate(dest, name);
  git(["init", "-q"], dest);
  if (repo) git(["remote", "add", "origin", repo], dest);
  aiSync(root);
  return dest;
}

/** service add: registers an existing repo and clones it. */
export function serviceAdd(root: string, rawName: string | undefined, rawRepo: string | undefined, branch?: string): string {
  const name = validateName(rawName);
  const repo = validateRepo(rawRepo);
  addEntry(root, { name, repo, branch: validateBranch(branch), ai: "inherit" });
  syncServices(root);
  return join(root, "src", name);
}

/** service remove: drops it from the manifest; with purge, deletes src/<name> only if it has no uncommitted changes. */
export function serviceRemove(root: string, rawName: string | undefined, purge = false): void {
  const name = validateName(rawName);
  const { doc, seq } = loadDoc(root);
  const idx = seq.items.findIndex((i) => isMap(i) && i.get("name") === name);
  if (idx < 0) throw new Error(`Service "${name}" is not in services.yaml`);
  const dest = join(root, "src", name);
  if (purge && existsSync(dest)) {
    if (git(["status", "--porcelain"], dest)) throw new Error(`${dest} has uncommitted changes; not deleting`);
    rmSync(dest, { recursive: true, force: true });
  }
  seq.items.splice(idx, 1);
  writeFileSync(manifestPath(root), doc.toString());
}

export interface ServiceSyncResult {
  name: string;
  action: "cloned" | "updated" | "skipped";
  reason?: string;
}

/** sync: clones what is missing and fast-forwards what exists. Never overwrites local changes. Idempotent. */
export function syncServices(root: string): ServiceSyncResult[] {
  const results: ServiceSyncResult[] = [];
  for (const s of listServices(root)) {
    const name = validateName(s.name);
    const dest = join(root, "src", name);
    if (!s.repo) {
      results.push({ name, action: "skipped", reason: existsSync(dest) ? "no remote repo" : "no repo and not present locally" });
      continue;
    }
    const repo = validateRepo(s.repo);
    const branch = validateBranch(s.branch);
    if (!existsSync(dest)) {
      git(["clone", "-q", ...(branch ? ["-b", branch] : []), "--", repo, dest]);
      results.push({ name, action: "cloned" });
      continue;
    }
    // Only tracked files count: untracked AI artefacts written by `ai sync` must not block updates.
    if (git(["status", "--porcelain", "--untracked-files=no"], dest)) {
      results.push({ name, action: "skipped", reason: "uncommitted local changes" });
      continue;
    }
    try {
      git(["pull", "-q", "--ff-only", ...(branch ? ["origin", branch] : [])], dest);
      results.push({ name, action: "updated" });
    } catch (e) {
      results.push({ name, action: "skipped", reason: `pull failed: ${(e as Error).message.split("\n")[0]}` });
    }
  }
  aiSync(root);
  return results;
}
