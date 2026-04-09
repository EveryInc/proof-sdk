/**
 * Renders a styled "Forbidden" page for users who are authenticated
 * but belong to an organization not allowed to access this instance.
 */
export function renderForbiddenPage(options: {
  email: string;
  organizationName: string | null;
  loginUrl: string;
  switchOrgUrl: string | null;
}): string {
  const { email, organizationName, loginUrl, switchOrgUrl } = options;

  const switchOrgButton = switchOrgUrl
    ? `<a href="${escapeAttr(switchOrgUrl)}" class="btn btn-secondary">Switch Organisation</a>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Access Denied | Proof</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      width: min(520px, 100%);
      background: rgba(15, 23, 42, 0.92);
      border: 1px solid #334155;
      border-radius: 24px;
      padding: 40px 32px;
      box-shadow: 0 20px 50px rgba(15, 23, 42, 0.45);
      text-align: center;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; font-weight: 600; color: #f8fafc; margin-bottom: 12px; }
    .detail { font-size: 15px; line-height: 1.6; color: #94a3b8; margin-bottom: 28px; }
    .detail strong { color: #cbd5e1; }
    .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
    .btn {
      display: inline-flex; align-items: center; padding: 10px 20px;
      border-radius: 10px; font-size: 14px; font-weight: 500;
      text-decoration: none; transition: background 0.15s, border-color 0.15s;
    }
    .btn-primary { background: #3b82f6; color: #fff; border: 1px solid #3b82f6; }
    .btn-primary:hover { background: #2563eb; border-color: #2563eb; }
    .btn-secondary { background: transparent; color: #cbd5e1; border: 1px solid #475569; }
    .btn-secondary:hover { background: rgba(71, 85, 105, 0.3); border-color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#128274;</div>
    <h1>Forbidden</h1>
    <p class="detail">
      You are logged in as <strong>${escapeHtml(email)}</strong>${organizationName ? ` (${escapeHtml(organizationName)})` : ''}.
      <br>Your organisation does not have access to this application.
    </p>
    <div class="actions">
      <a href="${escapeAttr(loginUrl)}" class="btn btn-primary">Switch Account</a>
      ${switchOrgButton}
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
