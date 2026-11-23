#!/usr/bin/env node
// Dependency audit policy (BASE-124-A). Reads the JSON that OSV-Scanner wrote and decides whether the build fails:
// a High or Critical (CVSS >= 7.0) or unscored advisory in a production dependency blocks, unless a reviewed,
// unexpired entry in the accepted-advisories file covers it. It fails closed: a scanner error, a missing results
// file or an invalid accepted file never passes. Built-ins only; it starts no process and opens no connection.
"use strict";

const fs = require("node:fs");

const HIGH = 7.0;
const MAX_ACCEPT_DAYS = 90;
const MIN_REASON = 20;
// The group name OSV-Scanner gives an npm dev dependency. A package in these groups only is not production.
const DEV_GROUPS = ["dev"];
const ENTRY_KEYS = ["accepted", "expires", "id", "reason"];

/** Lockfile-controlled text made safe to print: one line, at most 200 characters, never a workflow command. */
function sanitize(text) {
  const flat = String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, 200);
  return flat.startsWith("::") ? ` ${flat}` : flat;
}

/** Days since the epoch for a real calendar date written as YYYY-MM-DD, or null. */
function dayNumber(text) {
  const m = typeof text === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) : null;
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(ms / 86400000);
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The valid entries of the accepted file, and one error line per broken rule. */
function readAccepted(accepted, today) {
  if (accepted === null) return { entries: [], errors: ["accepted file: not valid JSON"] };
  if (!Array.isArray(accepted)) return { entries: [], errors: ["accepted file: must be a JSON array"] };
  const errors = [];
  const entries = [];
  const seen = new Set();
  const now = dayNumber(today);
  accepted.forEach((entry, i) => {
    const at = `accepted file: entry ${i + 1}`;
    if (!isObject(entry)) return errors.push(`${at}: must be an object`);
    const keys = Object.keys(entry).sort();
    if (keys.length !== ENTRY_KEYS.length || keys.some((k, n) => k !== ENTRY_KEYS[n]) || keys.some((k) => typeof entry[k] !== "string")) {
      return errors.push(`${at}: must have exactly the string keys id, reason, accepted, expires`);
    }
    const problems = [];
    if (!/^\S{3,64}$/.test(entry.id)) problems.push("id must be 3 to 64 characters with no whitespace");
    if (entry.reason.trim().length < MIN_REASON) problems.push(`reason must be at least ${MIN_REASON} characters`);
    const from = dayNumber(entry.accepted);
    const to = dayNumber(entry.expires);
    if (from === null || to === null) problems.push("accepted and expires must be real dates as YYYY-MM-DD");
    else {
      if (now !== null && from > now) problems.push("accepted is after today");
      if (from > to) problems.push("accepted is after expires");
      if (to - from > MAX_ACCEPT_DAYS) problems.push(`expires is more than ${MAX_ACCEPT_DAYS} days after accepted`);
    }
    const key = entry.id.toLowerCase();
    if (seen.has(key)) problems.push("the same id appears twice");
    seen.add(key);
    if (problems.length > 0) return errors.push(`${at}: ${problems.join("; ")}`);
    entries.push({ id: entry.id, key, reason: entry.reason.trim(), expires: entry.expires, expired: now === null || to < now });
  });
  return { entries, errors };
}

/**
 * The verdict. Pure: `scan` is the parsed scanner JSON (null when unreadable), `accepted` the parsed accepted
 * file ([] when absent, null when it is not JSON), `scannerExit` the scanner's exit status, `today` YYYY-MM-DD.
 */
function audit({ scan, accepted, scannerExit, today }) {
  const out = { ok: false, errors: [], blocking: [], accepted: [], reported: [], stale: [] };
  const list = readAccepted(accepted, today);
  out.errors.push(...list.errors);
  // Entries are applied only when the whole file is valid: a broken file cannot accept anything.
  const entries = list.errors.length === 0 ? list.entries : [];
  if (dayNumber(today) === null) out.errors.push("today is not a date as YYYY-MM-DD");
  if (scannerExit !== 0 && scannerExit !== 1) out.errors.push(`scanner failed: exit status ${sanitize(scannerExit)} (0 and 1 are the only successful ones)`);
  if (!isObject(scan) || !Array.isArray(scan.results)) {
    out.errors.push("scanner results are missing or are not the expected JSON");
    return out;
  }
  const used = new Set();
  for (const result of scan.results) {
    if (!isObject(result) || !Array.isArray(result.packages)) {
      out.errors.push("scanner results: a result has no packages array");
      continue;
    }
    const source = isObject(result.source) && typeof result.source.path === "string" ? result.source.path : "";
    for (const pkg of result.packages) {
      if (!isObject(pkg) || !isObject(pkg.package) || !Array.isArray(pkg.groups)) {
        out.errors.push("scanner results: a package entry is not in the expected shape");
        continue;
      }
      const groups = pkg.dependency_groups;
      const devOnly = Array.isArray(groups) && groups.length > 0 && groups.every((g) => DEV_GROUPS.includes(g));
      for (const group of pkg.groups) {
        const ids = [group?.ids, group?.aliases].flatMap((v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []));
        const raw = group?.max_severity;
        const score = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
        const finding = {
          id: ids[0] ?? "(no id)",
          package: String(pkg.package.name ?? ""),
          version: String(pkg.package.version ?? ""),
          ecosystem: String(pkg.package.ecosystem ?? ""),
          source,
          severity: Number.isFinite(score) ? score : null,
          why: "",
        };
        if (devOnly) {
          out.reported.push({ ...finding, why: "dev-only" });
          continue;
        }
        if (finding.severity !== null && finding.severity < HIGH) {
          out.reported.push({ ...finding, why: "below-high" });
          continue;
        }
        const why = finding.severity === null ? "unscored" : "high-or-critical";
        const lower = ids.map((x) => x.toLowerCase());
        const entry = entries.find((e) => lower.includes(e.key));
        if (entry !== undefined) used.add(entry.key);
        if (entry === undefined) out.blocking.push({ ...finding, why });
        else if (entry.expired) out.blocking.push({ ...finding, why: "acceptance-expired" });
        else out.accepted.push({ ...finding, why, reason: entry.reason, expires: entry.expires });
      }
    }
  }
  out.stale = entries.filter((e) => !used.has(e.key)).map((e) => e.id);
  out.ok = out.errors.length === 0 && out.blocking.length === 0;
  return out;
}

const describe = (f) => `${sanitize(f.id)}  ${sanitize(f.package)}@${sanitize(f.version)} (${sanitize(f.ecosystem)})  severity ${f.severity === null ? "unscored" : f.severity}  ${f.why}  ${sanitize(f.source)}`;

/** The console report, one line per finding. */
function renderText(r, acceptedPath) {
  const lines = [];
  const section = (title, items, extra) => {
    if (items.length === 0) return;
    lines.push(`${title} (${items.length}):`);
    for (const f of items) lines.push(`  ${describe(f)}${extra ? extra(f) : ""}`);
  };
  section("BLOCKING", r.blocking);
  section("ACCEPTED", r.accepted, (f) => `  until ${sanitize(f.expires)}: ${sanitize(f.reason)}`);
  section("REPORTED, not blocking", r.reported);
  for (const id of r.stale) lines.push(`stale accepted entry (matches no finding, can be removed): ${sanitize(id)}`);
  for (const e of r.errors) lines.push(`ERROR: ${sanitize(e)}`);
  if (r.blocking.length > 0) {
    lines.push("To fix: upgrade or remove the package. Only when neither is possible, add a reviewed entry");
    lines.push(`(id, reason, accepted, expires; at most ${MAX_ACCEPT_DAYS} days) to ${sanitize(acceptedPath)} by pull request.`);
  }
  lines.push(r.ok ? "dependency audit: PASS" : `dependency audit: FAIL (${r.blocking.length} blocking, ${r.errors.length} error(s))`);
  return lines.join("\n");
}

const cell = (text) => sanitize(text).replace(/[|`<>]/g, (c) => ({ "|": "\\|", "`": "\\`", "<": "&lt;", ">": "&gt;" })[c]);

/** The same content as a Markdown job summary. */
function renderMarkdown(r) {
  const lines = [`### Dependency audit: ${r.ok ? "PASS" : "FAIL"}`, ""];
  const rows = [
    ...r.blocking.map((f) => ["BLOCKING", f]),
    ...r.accepted.map((f) => ["ACCEPTED", f]),
    ...r.reported.map((f) => ["reported", f]),
  ];
  if (rows.length > 0) {
    lines.push("| Status | Advisory | Package | Severity | Why |", "|---|---|---|---|---|");
    for (const [status, f] of rows) {
      lines.push(`| ${status} | ${cell(f.id)} | ${cell(`${f.package}@${f.version}`)} | ${f.severity === null ? "unscored" : f.severity} | ${cell(f.why)} |`);
    }
    lines.push("");
  }
  for (const e of r.errors) lines.push(`- ERROR: ${cell(e)}`);
  return `${lines.join("\n")}\n`;
}

function readJson(path, whenMissing) {
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return whenMissing;
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function main(argv) {
  const usage = "usage: dependency-audit.cjs --results <file> --accepted <file> --scanner-exit <n>";
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!["--results", "--accepted", "--scanner-exit"].includes(name) || argv[i + 1] === undefined || name in opts) {
      console.error(usage);
      return 1;
    }
    opts[name] = argv[i + 1];
  }
  if (!("--results" in opts) || !("--accepted" in opts) || !/^-?\d+$/.test(opts["--scanner-exit"] ?? "")) {
    console.error(usage);
    return 1;
  }
  const result = audit({
    scan: readJson(opts["--results"], null),
    accepted: readJson(opts["--accepted"], []),
    scannerExit: Number(opts["--scanner-exit"]),
    today: new Date().toISOString().slice(0, 10),
  });
  console.log(renderText(result, opts["--accepted"]));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      fs.appendFileSync(summary, renderMarkdown(result));
    } catch (e) {
      // The summary is a convenience; the verdict above does not depend on it.
      console.error(`could not write the job summary: ${sanitize(e && e.message)}`);
    }
  }
  return result.ok ? 0 : 1;
}

module.exports = { audit, sanitize, renderText, renderMarkdown, main, DEV_GROUPS };

if (require.main === module) process.exit(main(process.argv.slice(2)));
