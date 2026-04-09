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

  var displayLabel = ${escapeJs(displayLabel)};
  var initial = ${escapeJs(initial)};
  var injected = false;

  function createUserFragment() {
    var sep = document.createElement('span');
    sep.className = 'share-pill-sep';
    sep.style.cssText = 'width:1px;height:16px;background:rgba(0,0,0,0.08);flex-shrink:0;';

    var avatar = document.createElement('div');
    avatar.style.cssText = 'width:24px;height:24px;border-radius:50%;background:linear-gradient(-1.66deg,#266854 4.43%,#1f8a65 110.83%);color:#f7f7f4;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    avatar.textContent = initial;

    var nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:#374151;';
    nameSpan.textContent = displayLabel;

    var link = document.createElement('a');
    link.href = '/auth/account';
    link.style.cssText = 'display:flex;align-items:center;gap:7px;text-decoration:none;transition:opacity 0.15s;';
    link.onmouseover = function(){ link.style.opacity='0.7'; };
    link.onmouseout = function(){ link.style.opacity='1'; };
    link.appendChild(avatar);
    link.appendChild(nameSpan);

    var logout = document.createElement('a');
    logout.href = '/auth/logout';
    logout.textContent = 'Sign out';
    logout.style.cssText = 'color:rgba(55,65,81,0.5);font-size:12px;text-decoration:none;white-space:nowrap;transition:color 0.15s;';
    logout.onmouseover = function(){ logout.style.color='#374151'; };
    logout.onmouseout = function(){ logout.style.color='rgba(55,65,81,0.5)'; };

    var frag = document.createDocumentFragment();
    frag.appendChild(sep);
    frag.appendChild(link);
    frag.appendChild(logout);
    return frag;
  }

  function injectInto(banner) {
    if (injected) return;
    if (banner.querySelector('[data-proof-auth]')) return;
    var wrapper = document.createElement('div');
    wrapper.setAttribute('data-proof-auth', '1');
    wrapper.style.cssText = 'display:flex;align-items:center;gap:10px;margin-left:auto;padding-left:4px;';
    wrapper.appendChild(createUserFragment());
    banner.appendChild(wrapper);
    injected = true;
  }

  function tryInject() {
    var banner = document.getElementById('share-banner');
    if (banner) { injectInto(banner); return true; }
    return false;
  }

  // Standalone fallback tab for pages without #share-banner (e.g. home page).
  function showStandaloneTab() {
    if (document.getElementById('proof-auth-user')) return;
    var tab = document.createElement('div');
    tab.id = 'proof-auth-user';
    tab.style.cssText = 'position:fixed;top:0;right:12px;z-index:1000;display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.94);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(0,0,0,0.06);border-top:none;border-radius:0 0 28px 28px;padding:10px 14px 10px 10px;box-shadow:0 6px 24px rgba(0,0,0,0.06),0 0 0 0.5px rgba(0,0,0,0.03);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;color:#374151;';

    var link = document.createElement('a');
    link.href = '/auth/account';
    link.style.cssText = 'display:flex;align-items:center;gap:7px;text-decoration:none;color:#374151;transition:opacity 0.15s;';
    link.onmouseover = function(){ link.style.opacity='0.7'; };
    link.onmouseout = function(){ link.style.opacity='1'; };
    var av = document.createElement('div');
    av.style.cssText = 'width:24px;height:24px;border-radius:50%;background:linear-gradient(-1.66deg,#266854 4.43%,#1f8a65 110.83%);color:#f7f7f4;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    av.textContent = initial;
    var nm = document.createElement('span');
    nm.style.cssText = 'max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    nm.textContent = displayLabel;
    link.appendChild(av);
    link.appendChild(nm);

    var pipe = document.createElement('span');
    pipe.style.cssText = 'color:rgba(0,0,0,0.12);font-size:16px;font-weight:300;';
    pipe.textContent = '|';

    var lo = document.createElement('a');
    lo.href = '/auth/logout';
    lo.textContent = 'Sign out';
    lo.style.cssText = 'color:rgba(55,65,81,0.5);font-size:12px;text-decoration:none;white-space:nowrap;transition:color 0.15s;';
    lo.onmouseover = function(){ lo.style.color='#374151'; };
    lo.onmouseout = function(){ lo.style.color='rgba(55,65,81,0.5)'; };

    tab.appendChild(link);
    tab.appendChild(pipe);
    tab.appendChild(lo);
    document.body.appendChild(tab);
  }

  function removeStandaloneTab() {
    var el = document.getElementById('proof-auth-user');
    if (el) el.remove();
  }

  // Try to inject into #share-banner. If it doesn't appear within 1.5s,
  // show the standalone tab instead.
  var fallbackTimer = null;

  if (!tryInject()) {
    var obs = new MutationObserver(function() {
      if (tryInject()) {
        obs.disconnect();
        clearTimeout(fallbackTimer);
        removeStandaloneTab();
      }
    });
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });

    // Fallback: if no banner after 1.5s, show standalone tab.
    fallbackTimer = setTimeout(function(){
      obs.disconnect();
      if (!injected) showStandaloneTab();
    }, 1500);
  }

  // Re-inject if the banner is recreated (e.g. on navigation).
  // Also remove the standalone tab if the banner appears later.
  var reObs = new MutationObserver(function() {
    var banner = document.getElementById('share-banner');
    if (banner && !banner.querySelector('[data-proof-auth]')) {
      injected = false;
      injectInto(banner);
      removeStandaloneTab();
    }
  });
  reObs.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
</script>`;
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
