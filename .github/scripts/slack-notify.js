#!/usr/bin/env node
/**
 * slack-notify.js
 * Formats and sends rich Slack Block Kit notifications for SDLC events.
 * Gracefully exits 0 if SLACK_WEBHOOK_URL is not configured.
 */

const fs = require('fs');

function sanitizeLog(input) {
  return String(input || '')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 500);
}

function formatBlockKit(color, headerText, fields, contextText) {
  return {
    attachments: [
      {
        color,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
          {
            type: 'section',
            fields: fields.map(([label, value]) => ({
              type: 'mrkdwn',
              text: `*${label}:*\n${value}`,
            })),
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: contextText }],
          },
        ],
      },
    ],
  };
}

async function main() {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl || webhookUrl.trim() === '') {
    console.log('[slack-notify] SLACK_WEBHOOK_URL not configured. Skipping Slack notification.');
    return;
  }

  const eventType = process.argv[2] || process.env.SLACK_EVENT_TYPE || 'generic';
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const repo = process.env.GITHUB_REPOSITORY || 'unknown/repository';
  const repoUrl = `${serverUrl}/${repo}`;
  const runId = process.env.GITHUB_RUN_ID || '';
  const runUrl = runId ? `${repoUrl}/actions/runs/${runId}` : repoUrl;
  const actor = process.env.GITHUB_ACTOR || 'developer';
  const refName = process.env.GITHUB_REF_NAME || 'branch';

  let eventPayload = {};
  if (process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    try {
      eventPayload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    } catch {
      eventPayload = {};
    }
  }

  const pr = eventPayload.pull_request || {};
  const prNumber = pr.number ? `#${pr.number}` : '';
  const prTitle = pr.title || 'Pull Request';
  const prUrl = pr.html_url || (pr.number ? `${repoUrl}/pull/${pr.number}` : repoUrl);
  const prAuthor = pr.user ? pr.user.login : actor;
  const headRef = pr.head ? pr.head.ref : refName;
  const baseRef = pr.base ? pr.base.ref : 'development';

  // Extract Ticket ID from title or branch
  const ticketMatch = /\b([A-Z]{2,10}-\d+|#\d+)\b/i.exec(prTitle + ' ' + headRef);
  const ticketId = ticketMatch ? ticketMatch[1].toUpperCase() : 'N/A';

  const versionMatch = /\bv?\d{1,5}\.\d{1,5}\.\d{1,5}\b/.exec(prTitle);
  const version = process.env.RELEASE_VERSION || (versionMatch ? versionMatch[0] : 'latest');
  const releaseUrl = `${repoUrl}/releases/tag/${version.startsWith('v') ? version : 'v' + version}`;

  const message = buildSlackMessage(eventType, {
    repo,
    repoUrl,
    runUrl,
    actor,
    refName,
    prNumber,
    prTitle,
    prUrl,
    prAuthor,
    headRef,
    baseRef,
    ticketId,
    version,
    releaseUrl,
  });

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[slack-notify] Error posting to Slack: ${res.status} ${res.statusText} - ${sanitizeLog(text)}`);
    } else {
      console.log(`[slack-notify] Notification successfully delivered to Slack (${eventType}).`);
    }
  } catch (err) {
    console.error('[slack-notify] Network failure posting to Slack:', sanitizeLog(err.message));
  }
}

function buildSlackMessage(type, ctx) {
  switch (type) {
    case 'pr_opened':
      return formatBlockKit(
        '#1f6feb',
        '📋 Nuevo Pull Request Abierto',
        [
          ['Repositorio', `<${ctx.repoUrl}|${ctx.repo}>`],
          ['Pull Request', `<${ctx.prUrl}|${ctx.prNumber} ${ctx.prTitle}>`],
          ['Autor', `@${ctx.prAuthor}`],
          ['Ramas', `\`${ctx.headRef}\` ➔ \`${ctx.baseRef}\``],
        ],
        `🔖 *Ticket:* \`${ctx.ticketId}\` | ⏳ Ejecutando análisis de CI, SonarCloud y CodeRabbit...`
      );

    case 'pr_ready_for_review':
      return formatBlockKit(
        '#238636',
        '✅ PR Listo para Aprobación Humana',
        [
          ['Pull Request', `<${ctx.prUrl}|${ctx.prNumber} ${ctx.prTitle}>`],
          ['Autor', `@${ctx.prAuthor}`],
          ['Ticket ID', `\`${ctx.ticketId}\``],
          ['Quality Gates', 'Tests OK • SonarCloud Passed'],
        ],
        '🛡️ *Regla SDLC:* Verificar y resolver todos los comentarios de revisión antes del merge. Requiere aprobación humana.'
      );

    case 'ci_failure':
      return formatBlockKit(
        '#da3633',
        '🚨 Fallo en Pipeline de CI / Quality Gate',
        [
          ['Repositorio', `<${ctx.repoUrl}|${ctx.repo}>`],
          ['Rama / Ref', `\`${ctx.refName}\``],
          ['Ejecutado por', `@${ctx.actor}`],
          ['Logs CI', `<${ctx.runUrl}|Ver detalles del fallo>`],
        ],
        '⚠️ Un check automatizado o compuerta de calidad ha fallado. Revisa los logs para corregirlo.'
      );

    case 'release_published':
      return formatBlockKit(
        '#8957e5',
        '🚀 Nuevo Release Desplegado en Producción',
        [
          ['Repositorio', `<${ctx.repoUrl}|${ctx.repo}>`],
          ['Versión', `<${ctx.releaseUrl}|${ctx.version}>`],
          ['Publicado por', `@${ctx.actor}`],
          ['Destino', 'Producción (`main`)'],
        ],
        '📦 Paquete publicado en npm con Provenance y tag inmutable de Git creado.'
      );

    default:
      return {
        text: `[base-ai SDLC] Evento ${type} en <${ctx.repoUrl}|${ctx.repo}>`,
      };
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[slack-notify] Fatal error:', sanitizeLog(err.message));
    process.exit(1);
  });
}

module.exports = { buildSlackMessage, sanitizeLog, formatBlockKit, main };
