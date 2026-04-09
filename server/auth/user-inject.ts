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
  position: fixed; top: 0; right: 12px; z-index: 1000;
  display: flex; align-items: center; gap: 6px;
  background: rgba(255,255,255,0.94);
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(0,0,0,0.06); border-top: none;
  border-radius: 0 0 28px 28px;
  padding: 10px 14px 10px 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.06), 0 0 0 0.5px rgba(0,0,0,0.03);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px; color: #374151;
">
  <a href="/auth/account" style="
    display: flex; align-items: center; gap: 7px; text-decoration: none; color: #374151;
    transition: opacity 0.15s;
  " onmouseover="this.style.opacity='0.7'" onmouseout="this.style.opacity='1'">
    <div style="
      width: 24px; height: 24px; border-radius: 50%;
      background: linear-gradient(-1.66deg, #266854 4.43%, #1f8a65 110.83%);
      color: #f7f7f4; font-size: 11px; font-weight: 600;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    ">${escapeHtml(initial)}</div>
    <span style="max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
      ${escapeHtml(displayLabel)}
    </span>
  </a>
  <span style="color: rgba(0,0,0,0.12); font-size: 16px; font-weight: 300;">|</span>
  <a href="/auth/logout" style="
    color: rgba(55,65,81,0.5); font-size: 12px; text-decoration: none;
    transition: color 0.15s;
  " onmouseover="this.style.color='#374151'" onmouseout="this.style.color='rgba(55,65,81,0.5)'"
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
