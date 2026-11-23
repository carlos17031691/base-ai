/**
 * Pages served by `base-ai dashboard`, held in memory: nothing is ever served from disk (BASE-101-D1).
 * D2 adds the HUD UI here. The placeholder has no script, no inline style and no external reference, so it
 * satisfies `Content-Security-Policy: default-src 'self'`.
 */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>base-ai dashboard</title>
</head>
<body>
<h1>base-ai dashboard</h1>
<p>The pipeline view arrives in a later version. The read-only JSON API is available now:</p>
<ul>
<li><a href="/api/tasks">/api/tasks</a>: every task with its state, next actor, rounds and token totals</li>
<li><a href="/healthz">/healthz</a></li>
</ul>
</body>
</html>
`;
