import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { buildSlackMessage } = require("../../../.github/scripts/slack-notify.js");

test("buildSlackMessage generates rich block kit payloads for all SDLC events", () => {
  const ctx = {
    repo: "carlos17031691/base-ai",
    repoUrl: "https://github.com/carlos17031691/base-ai",
    runUrl: "https://github.com/carlos17031691/base-ai/actions/runs/123",
    actor: "carlos17031691",
    refName: "feat/BASE-008-sdlc-slack-integration",
    prNumber: "#19",
    prTitle: "feat(BASE-008): integrate SDLC workflow with Slack",
    prUrl: "https://github.com/carlos17031691/base-ai/pull/19",
    prAuthor: "carlos17031691",
    headRef: "feat/BASE-008-sdlc-slack-integration",
    baseRef: "development",
    ticketId: "BASE-008",
    version: "0.8.0",
    releaseUrl: "https://github.com/carlos17031691/base-ai/releases/tag/v0.8.0",
  };

  // 1. pr_opened
  const prOpened = buildSlackMessage("pr_opened", ctx);
  assert.ok(prOpened.attachments);
  assert.equal(prOpened.attachments[0].color, "#1f6feb");
  assert.ok(JSON.stringify(prOpened).includes("Nuevo Pull Request Abierto"));
  assert.ok(JSON.stringify(prOpened).includes("BASE-008"));

  // 2. pr_ready_for_review
  const prReady = buildSlackMessage("pr_ready_for_review", ctx);
  assert.equal(prReady.attachments[0].color, "#238636");
  assert.ok(JSON.stringify(prReady).includes("PR Listo para Aprobación Humana"));
  assert.ok(JSON.stringify(prReady).includes("SonarCloud Passed"));

  // 3. ci_failure
  const ciFail = buildSlackMessage("ci_failure", ctx);
  assert.equal(ciFail.attachments[0].color, "#da3633");
  assert.ok(JSON.stringify(ciFail).includes("Fallo en Pipeline de CI"));

  // 4. release_published
  const relPub = buildSlackMessage("release_published", ctx);
  assert.equal(relPub.attachments[0].color, "#8957e5");
  assert.ok(JSON.stringify(relPub).includes("Nuevo Release Desplegado en Producción"));
  assert.ok(JSON.stringify(relPub).includes("0.8.0"));
});
