import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextIndex, searchContext } from "../context.js";

test("indexes root and service docs/contracts by section and retrieves ranked citations", () => {
  const d = mkdtempSync(join(tmpdir(), "base-ai-ctx-"));
  mkdirSync(join(d, "docs/architecture/adrs"), { recursive: true });
  writeFileSync(
    join(d, "docs/architecture/adrs/ADR-0001-vector-db.md"),
    "# ADR-0001: Use pgvector for embeddings\n\n- **Status:** Accepted\n\n## Decision\nWe use PostgreSQL with pgvector and hybrid BM25 search.",
  );
  mkdirSync(join(d, "src/billing/docs/operations/runbooks"), { recursive: true });
  mkdirSync(join(d, "src/billing/contracts"), { recursive: true });
  writeFileSync(
    join(d, "src/billing/docs/operations/runbooks/webhook-retry.md"),
    "# Billing Webhook Runbook\n\n## Mitigation\nReplay dead-letter queue events using idempotency keys.",
  );
  writeFileSync(join(d, "src/billing/contracts/openapi.yaml"), "openapi: 3.1.0\ninfo:\n  title: Billing Invoices API\n");

  const idx = buildContextIndex(d);
  assert.ok(idx.chunks.length >= 4);

  const ragHits = searchContext(d, "pgvector hybrid embeddings");
  assert.equal(ragHits[0].kind, "adr");
  assert.equal(ragHits[0].status, "Accepted");
  assert.match(ragHits[0].id, /^docs\/architecture\/adrs\/ADR-0001-vector-db\.md#L/);

  const svcHits = searchContext(d, "dead-letter idempotency", 5, "service:billing");
  assert.equal(svcHits[0].kind, "runbook");
  assert.equal(svcHits[0].scope, "service:billing");

  const contractHits = searchContext(d, "Invoices openapi");
  assert.equal(contractHits[0].kind, "contract");
});
