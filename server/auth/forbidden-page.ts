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
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?v=20260309p">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://api.fontshare.com/v2/css?f[]=switzer@1,2&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Switzer', 'Switzer Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f5f3ec;
      color: #26251e;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      width: min(520px, 100%);
      background: #edeae0;
      border: 1px solid rgba(38, 37, 30, 0.03);
      border-radius: 4px;
      padding: 40px 32px;
      text-align: center;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 26px; font-weight: 400; color: #26251e; margin-bottom: 12px; letter-spacing: -0.325px; }
    .detail { font-size: 16px; line-height: 1.6; color: rgba(38, 37, 30, 0.6); margin-bottom: 28px; }
    .detail strong { color: #26251e; }
    .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
    .btn {
      display: inline-flex; align-items: center; padding: 12.48px 21.6px;
      border-radius: 33554400px; font-family: inherit; font-size: 16px; font-weight: 400;
      text-decoration: none;
      transition: filter 0.2s ease, transform 0.1s ease, box-shadow 0.2s ease;
    }
    .btn-primary {
      background: linear-gradient(-1.66deg, #266854 4.43%, #1f8a65 110.83%);
      color: #f7f7f4; border: none;
    }
    .btn-primary:hover { filter: brightness(1.1); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(38, 104, 84, 0.3); }
    .btn-secondary {
      background: transparent; color: #26251e;
      border: 1px solid rgba(38, 37, 30, 0.12);
    }
    .btn-secondary:hover { background: rgba(38, 37, 30, 0.04); }
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
