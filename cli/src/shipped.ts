/**
 * Single predicate for what a base-ai template ships: used by `init` (copy from the template root)
 * and by `scripts/bundle-template.mjs` (copy into the npm package), so the two can never disagree.
 */

/** The only Markdown files under docs/ that ship: referenced by the rules and the role definitions. */
export const SHIPPED_DOCS = ["docs/task-state-machine.md"];

const EXCLUDED_AI = [".ai/generated.json", ".ai/context-index.json"];

/** True when `rel` (a path relative to the template root, file or directory) is shipped. */
export function isShippedPath(rel: string): boolean {
  const p = rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (p === "") return true;
  if (p === ".coderabbit.yaml" || p === "sonar-project.properties") return true;

  if (p === ".ai" || p.startsWith(".ai/")) {
    if (EXCLUDED_AI.includes(p)) return false;
    // Task directories are local pipeline state, never part of a template.
    return p !== ".ai/tasks" && !p.startsWith(".ai/tasks/");
  }
  if (p === "templates" || p.startsWith("templates/")) return true;

  if (p === ".claude" || p === ".claude/agents") return true;
  if (p.startsWith(".claude/agents/")) {
    const parts = p.slice(".claude/agents/".length).split("/");
    // A definition `<role>.md`, a reference directory `<role>` (no extension) and its `<role>/<name>.md` files.
    if (parts.length === 1) return parts[0].endsWith(".md") || !parts[0].includes(".");
    return parts.length === 2 && !parts[0].includes(".") && parts[1].endsWith(".md");
  }

  if (p === "docs" || p.startsWith("docs/")) {
    // The README's images (BASE-101-D5): this repository's own, never part of a new project.
    if (p === "docs/assets" || p.startsWith("docs/assets/")) return false;
    if (!p.endsWith(".md")) return true; // directories and the non-Markdown skeleton (.gitkeep)
    return SHIPPED_DOCS.includes(p);
  }
  return false;
}
