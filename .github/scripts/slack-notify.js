#!/usr/bin/env node
/**
 * slack-notify.js
 * Formats and sends rich Slack Block Kit notifications for SDLC events.
 * Gracefully exits 0 if SLACK_WEBHOOK_URL is not configured.
 */

const fs = require('fs');

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
  const ticketMatch = (prTitle + ' ' + headRef).match(/([A-Z]{2,10}-\d+|#\d+)/i);
  const ticketId = ticketMatch ? ticketMatch[1].toUpperCase() : 'N/A';

  const version = process.env.RELEASE_VERSION || (prTitle.match(/v?\d+\.\d+\.\d+/) || ['latest'])[0];
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
      console.error(`[slack-notify] Error posting to Slack: ${res.status} ${res.statusText} - ${text}`);
    } else {
      console.log(`[slack-notify] Notification successfully delivered to Slack (${eventType}).`);
    }
  } catch (err) {
    console.error('[slack-notify] Network failure posting to Slack:', err.message);
  }
}

function buildSlackMessage(type, ctx) {
  switch (type) {
    case 'pr_opened':
      return {
        attachments: [
          {
            color: '#1f6feb',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '📋 Nuevo Pull Request Abierto', emoji: true },
              },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: `*Repositorio:*\n<${ctx.repoUrl}|${ctx.repo}>` },
                  { type: 'mrkdwn', text: `*Pull Request:*\n<${ctx.prUrl}|${ctx.prNumber} ${ctx.prTitle}>` },
                  { type: 'mrkdwn', text: `*Autor:*\n@${ctx.prAuthor}` },
                  { type: 'mrkdwn', text: `*Ramas:*\n\`${ctx.headRef}\` ➔ \`${ctx.baseRef}\`` },
                ],
              },
              {
                type: 'context',
                elements: [
                  { type: 'mrkdwn', text: `🔖 *Ticket:* \`${ctx.ticketId}\` | ⏳ Ejecutando análisis de CI, SonarCloud y CodeRabbit...` },
                ],
              },
            ],
          },
        ],
      };

    case 'pr_ready_for_review':
      return {
        attachments: [
          {
            color: '#238636',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '✅ PR Listo para Aprobación Humana', emoji: true },
              },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: `*Pull Request:*\n<${ctx.prUrl}|${ctx.prNumber} ${ctx.prTitle}>` },
                  { type: 'mrkdwn', text: `*Autor:*\n@${ctx.prAuthor}` },
                  { type: 'mrkdwn', text: `*Ticket ID:*\n\`${ctx.ticketId}\`` },
                  { type: 'mrkdwn', text: `*Quality Gates:*\nTests OK • SonarCloud Passed` },
                ],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '🛡️ *Regla SDLC:* Verificar y resolver todos los comentarios de revisión antes del merge. Requiere aprobación humana.',
                  },
                ],
              },
            ],
          },
        ],
      };

    case 'ci_failure':
      return {
        attachments: [
          {
            color: '#da3633',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 Fallo en Pipeline de CI / Quality Gate', emoji: true },
              },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: `*Repositorio:*\n<${ctx.repoUrl}|${ctx.repo}>` },
                  { type: 'mrkdwn', text: `*Rama / Ref:*\n\`${ctx.refName}\`` },
                  { type: 'mrkdwn', text: `*Ejecutado por:*\n@${ctx.actor}` },
                  { type: 'mrkdwn', text: `*Logs CI:*\n<${ctx.runUrl}|Ver detalles del fallo>` },
                ],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '⚠️ Un check automatizado o compuerta de calidad ha fallado. Revisa los logs para corregirlo.',
                  },
                ],
              },
            ],
          },
        ],
      };

    case 'release_published':
      return {
        attachments: [
          {
            color: '#8957e5',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚀 Nuevo Release Desplegado en Producción', emoji: true },
              },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: `*Repositorio:*\n<${ctx.repoUrl}|${ctx.repo}>` },
                  { type: 'mrkdwn', text: `*Versión:*\n<${ctx.releaseUrl}|${ctx.version}>` },
                  { type: 'mrkdwn', text: `*Publicado por:*\n@${ctx.actor}` },
                  { type: 'mrkdwn', text: `*Destino:*\nProducción (\`main\`)` },
                ],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '📦 Paquete publicado en npm con Provenance y tag inmutable de Git creado.',
                  },
                ],
              },
            ],
          },
        ],
      };

    default:
      return {
        text: `[base-ai SDLC] Evento ${type} en <${ctx.repoUrl}|${ctx.repo}>`,
      };
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildSlackMessage, main };
