import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, YAMLSeq } from "yaml";
import { aiSync } from "./sync.js";

export interface Service {
  name: string;
  repo?: string;
  branch?: string;
  template?: string;
  ai?: "inherit" | "none";
}

const NAME_RE = /^[a-z0-9-]+$/;
const manifestPath = (root: string) => join(root, "services.yaml");

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function validateName(name: string | undefined): string {
  if (!name || !NAME_RE.test(name)) throw new Error(`Nombre de servicio inválido "${name ?? ""}" (usa ^[a-z0-9-]+$)`);
  return name;
}

function validateRepo(repo: string | undefined): string {
  if (!repo || repo.startsWith("-")) throw new Error(`URL de repositorio inválida "${repo ?? ""}"`);
  return repo;
}

/** Lee services.yaml conservando comentarios. */
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
  if (seq.items.some((i) => isMap(i) && i.get("name") === svc.name)) throw new Error(`El servicio "${svc.name}" ya existe en services.yaml`);
  seq.flow = false;
  seq.add(doc.createNode(Object.fromEntries(Object.entries(svc).filter(([, v]) => v !== undefined))));
  writeFileSync(manifestPath(root), doc.toString());
}

/** Copia la plantilla reemplazando {{name}} en nombres y contenido de archivos de texto. */
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

/** service new: crea src/<name> desde templates/<template>, inicializa git y lo registra. */
export function serviceNew(root: string, rawName: string | undefined, template = "service", repo?: string): string {
  const name = validateName(rawName);
  const tpl = join(root, "templates", validateName(template));
  const dest = join(root, "src", name);
  if (!existsSync(tpl)) throw new Error(`No existe la plantilla ${tpl}`);
  if (existsSync(dest)) throw new Error(`${dest} ya existe`);
  if (repo) validateRepo(repo);

  addEntry(root, { name, repo, branch: "main", template, ai: "inherit" });
  cpSync(tpl, dest, { recursive: true });
  renderTemplate(dest, name);
  git(["init", "-q", "-b", "main"], dest);
  if (repo) git(["remote", "add", "origin", repo], dest);
  aiSync(root);
  return dest;
}

/** service add: registra un repo existente y lo clona. */
export function serviceAdd(root: string, rawName: string | undefined, rawRepo: string | undefined, branch = "main"): string {
  const name = validateName(rawName);
  const repo = validateRepo(rawRepo);
  addEntry(root, { name, repo, branch, ai: "inherit" });
  syncServices(root);
  return join(root, "src", name);
}

/** service remove: lo quita del manifiesto; con purge borra src/<name> solo si no hay cambios sin commitear. */
export function serviceRemove(root: string, rawName: string | undefined, purge = false): void {
  const name = validateName(rawName);
  const { doc, seq } = loadDoc(root);
  const idx = seq.items.findIndex((i) => isMap(i) && i.get("name") === name);
  if (idx < 0) throw new Error(`El servicio "${name}" no está en services.yaml`);
  const dest = join(root, "src", name);
  if (purge && existsSync(dest)) {
    if (git(["status", "--porcelain"], dest)) throw new Error(`${dest} tiene cambios sin commitear; no se borra`);
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

/** sync: clona lo que falta y actualiza (ff-only) lo existente. Nunca pisa cambios locales. Idempotente. */
export function syncServices(root: string): ServiceSyncResult[] {
  const results: ServiceSyncResult[] = [];
  for (const s of listServices(root)) {
    const name = validateName(s.name);
    const dest = join(root, "src", name);
    if (!s.repo) {
      results.push({ name, action: "skipped", reason: existsSync(dest) ? "sin repo remoto" : "sin repo y no existe localmente" });
      continue;
    }
    const repo = validateRepo(s.repo);
    const branch = s.branch ?? "main";
    if (!existsSync(dest)) {
      git(["clone", "-q", "-b", branch, "--", repo, dest]);
      results.push({ name, action: "cloned" });
      continue;
    }
    if (git(["status", "--porcelain", "--untracked-files=no"], dest)) {
      results.push({ name, action: "skipped", reason: "cambios locales sin commitear" });
      continue;
    }
    try {
      git(["pull", "-q", "--ff-only", "origin", branch], dest);
      results.push({ name, action: "updated" });
    } catch (e) {
      results.push({ name, action: "skipped", reason: `pull falló: ${(e as Error).message.split("\n")[0]}` });
    }
  }
  aiSync(root);
  return results;
}
