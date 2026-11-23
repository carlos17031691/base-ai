/**
 * Package check (BASE-046-D1): every template path that the shipped rules, skills, role definitions and
 * state-machine doc reference in inline code must be in the npm package. Pure functions; the I/O
 * (npm pack listing, reading the sources) lives in scripts/check-package.mjs.
 */

export interface PackageSource {
  file: string;
  text: string;
}

export interface MissingRef {
  ref: string;
  required: string;
  file: string;
}

const PREFIXES = [".ai/", ".claude/", "docs/", "templates/"];
const ROOT_FILES = [".coderabbit.yaml", "sonar-project.properties"];

/** Paths created at run time, never shipped, with the reason. */
export const EXEMPT: Record<string, string> = {
  ".ai/tasks/": "created by the planner at run time",
  ".ai/usage/": "written by `base-ai usage record` at run time",
  ".claude/settings.json": "written by `base-ai ai sync` when usage.hook is claude-code",
};

/** Inline-code spans (no whitespace) that name a template path. Fenced code blocks are ignored. */
export function extractPathRefs(markdown: string): string[] {
  const text = markdown.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
  const refs = new Set<string>();
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const ref = m[1];
    if (ROOT_FILES.includes(ref) || PREFIXES.some((p) => ref.startsWith(p))) refs.add(ref);
  }
  return [...refs];
}

/** The part of a ref that must exist: cut at the first placeholder segment, keeping the directory before it. */
export function requiredPath(ref: string): string {
  const segments = ref.split("/");
  const i = segments.findIndex((s) => /[<>*{]|XXXX/.test(s));
  if (i === -1) return ref;
  return segments.slice(0, i).join("/") + "/";
}

/** Refs whose required path is neither exempt nor in the packed list (paths as `template/<path>`). */
export function findMissing(sources: PackageSource[], packed: string[]): MissingRef[] {
  const files = new Set(packed);
  const missing: MissingRef[] = [];
  for (const { file, text } of sources) {
    for (const ref of extractPathRefs(text)) {
      const required = requiredPath(ref);
      if (Object.keys(EXEMPT).some((e) => required === e || required.startsWith(e))) continue;
      const target = `template/${required}`;
      const present = required.endsWith("/")
        ? packed.some((p) => p.startsWith(target))
        : files.has(target) || packed.some((p) => p.startsWith(`${target}/`));
      if (!present) missing.push({ ref, required, file });
    }
  }
  return missing;
}
