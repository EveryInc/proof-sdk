import type { Request, Response, NextFunction } from 'express';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeJs(value: string): string {
  return JSON.stringify(value);
}

/**
 * Builds a snippet to inject before </body> in HTML responses for authenticated users.
 * - Sets the viewer name in localStorage so the editor name prompt is skipped.
 * - Renders a small user pill in the top-right corner with name + logout link.
 */
function buildAuthSnippet(name: string, email: string): string {
  const displayLabel = name || email;
  const initial = (name || email).charAt(0).toUpperCase();

  return `
<script>
(function(){
  try { localStorage.setItem('proof-share-viewer-name', ${escapeJs(name || email)}); } catch(e){}
})();
</script>
<div id="proof-auth-user" style="
  position: fixed; top: 12px; right: 12px; z-index: 9999;
  display: flex; align-items: center; gap: 8px;
  font-family: 'Switzer','Switzer Variable',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  font-size: 13px; color: #26251e;
">
  <a href="/auth/account" style="
    display: flex; align-items: center; gap: 8px; text-decoration: none; color: #26251e;
    background: #edeae0; border: 1px solid rgba(38,37,30,0.06);
    border-radius: 33554400px; padding: 5px 14px 5px 5px;
    transition: border-color 0.15s;
  " onmouseover="this.style.borderColor='rgba(38,37,30,0.15)'"
     onmouseout="this.style.borderColor='rgba(38,37,30,0.06)'">
    <div style="
      width: 26px; height: 26px; border-radius: 50%;
      background: linear-gradient(-1.66deg, #266854 4.43%, #1f8a65 110.83%);
      color: #f7f7f4; font-size: 12px; font-weight: 600;
      display: flex; align-items: center; justify-content: center;
    ">${escapeHtml(initial)}</div>
    <span style="max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
      ${escapeHtml(displayLabel)}
    </span>
  </a>
  <a href="/auth/logout" style="
    color: rgba(38,37,30,0.4); font-size: 12px; text-decoration: none;
    padding: 4px 8px; border-radius: 33554400px;
    transition: color 0.15s, background 0.15s;
  " onmouseover="this.style.color='#26251e';this.style.background='rgba(38,37,30,0.06)'"
     onmouseout="this.style.color='rgba(38,37,30,0.4)';this.style.background='transparent'"
  >Sign out</a>
</div>`;
}

/**
 * Middleware that injects authenticated user info into HTML responses.
 * - Skips if no authenticated user on the request.
 * - Intercepts res.send/res.end to inject the snippet before </body>.
 */
export function createUserInjectMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.authenticatedUser;
    if (!user) {
      next();
      return;
    }

    const snippet = buildAuthSnippet(user.name || '', user.email);

    // Monkey-patch res.send to inject into HTML responses
    const originalSend = res.send.bind(res);
    res.send = function patchedSend(body?: unknown) {
      const contentType = res.getHeader('content-type');
      if (
        typeof body === 'string'
        && typeof contentType === 'string'
        && contentType.includes('text/html')
        && body.includes('</body>')
      ) {
        body = body.replace('</body>', `${snippet}\n</body>`);
      }
      return originalSend(body);
    } as typeof res.send;

    next();
  };
}
