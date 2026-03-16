/**
 * Name prompt for web share viewers.
 * Shows a modal asking "What's your name?" on first visit.
 * Stores name in localStorage for future visits.
 */

const STORAGE_KEY = 'proof-share-viewer-name';

function shouldAutofocusInput(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
      return false;
    }
  } catch {
    // Ignore matchMedia failures and fall back to viewport width.
  }
  return window.innerWidth > 900;
}

export function getViewerName(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setViewerName(name: string): void {
  localStorage.setItem(STORAGE_KEY, name);
}

export function clearViewerName(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Show name prompt modal if no name is stored.
 * Returns the viewer's name (from storage or newly entered).
 */
export function promptForName(options?: { force?: boolean; initialValue?: string }): Promise<string> {
  const existing = getViewerName();
  if (existing && !options?.force) return Promise.resolve(existing);

  return new Promise((resolve) => {
    if (!document.body) {
      resolve('Anonymous');
      return;
    }

    const overlay = document.createElement('div');
    overlay.dataset.proofNamePrompt = 'overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 10000;
      background: rgba(0,0,0,0.3);
      display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    `;

    const dialog = document.createElement('div');
    dialog.dataset.proofNamePrompt = 'dialog';
    dialog.style.cssText = `
      background: white; border-radius: 16px; padding: 36px 32px 32px;
      max-width: 340px; width: 90%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      text-align: center;
    `;

    const wordmark = document.createElement('div');
    wordmark.textContent = 'Proof';
    wordmark.style.cssText = 'font-size: 15px; font-weight: 600; color: #333; letter-spacing: -0.3px; margin-bottom: 20px;';

    const title = document.createElement('h2');
    title.textContent = 'Choose a display name';
    title.style.cssText = 'margin: 0 0 6px; font-size: 18px; font-weight: 600; color: #111;';

    const subtitle = document.createElement('p');
    subtitle.textContent = 'Your name appears on comments and edits.';
    subtitle.style.cssText = 'margin: 0 0 20px; color: #888; font-size: 13px; line-height: 1.4;';

    const input = document.createElement('input');
    input.dataset.proofNamePrompt = 'input';
    input.type = 'text';
    input.placeholder = 'Your name';
    input.autocomplete = 'name';
    input.autocapitalize = 'words';
    input.enterKeyHint = 'done';
    input.value = options?.initialValue ?? existing ?? '';
    input.style.cssText = `
      width: 100%; padding: 10px 14px; border: 1px solid #e0e0e0;
      border-radius: 10px; font-size: 16px; outline: none;
      box-sizing: border-box; text-align: center;
      transition: border-color 0.15s;
    `;
    input.addEventListener('focus', () => {
      input.style.borderColor = '#333';
    });
    input.addEventListener('blur', () => {
      input.style.borderColor = '#e0e0e0';
    });

    const button = document.createElement('button');
    button.dataset.proofNamePrompt = 'submit';
    button.textContent = 'Continue';
    button.style.cssText = `
      width: 100%; margin-top: 12px; min-height: 44px; padding: 10px 14px;
      background: #111; color: white; border: none;
      border-radius: 10px; font-size: 15px; font-weight: 500;
      cursor: pointer; transition: background 0.15s;
    `;
    button.addEventListener('mouseenter', () => {
      button.style.background = '#333';
    });
    button.addEventListener('mouseleave', () => {
      button.style.background = '#111';
    });

    const skipLink = document.createElement('button');
    skipLink.dataset.proofNamePrompt = 'anonymous';
    skipLink.textContent = 'Continue anonymously';
    skipLink.setAttribute('aria-label', 'Continue anonymously');
    skipLink.style.cssText = `
      width: 100%; margin-top: 8px; min-height: 44px; padding: 10px 14px;
      background: #f5f5f5; color: #444; border: 1px solid #e5e5e5;
      border-radius: 10px; font-size: 14px; font-weight: 500;
      cursor: pointer; font-family: inherit; transition: background 0.15s, color 0.15s;
    `;
    skipLink.addEventListener('mouseenter', () => {
      skipLink.style.background = '#ededed';
      skipLink.style.color = '#222';
    });
    skipLink.addEventListener('mouseleave', () => {
      skipLink.style.background = '#f5f5f5';
      skipLink.style.color = '#444';
    });

    const submit = () => {
      const name = input.value.trim() || 'Anonymous';
      setViewerName(name);
      overlay.remove();
      resolve(name);
    };

    const continueAsViewer = () => {
      setViewerName('Anonymous');
      overlay.remove();
      resolve('Anonymous');
    };

    button.addEventListener('click', submit);
    skipLink.addEventListener('click', continueAsViewer);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') continueAsViewer();
    });

    dialog.appendChild(wordmark);
    dialog.appendChild(title);
    dialog.appendChild(subtitle);
    dialog.appendChild(input);
    dialog.appendChild(button);
    dialog.appendChild(skipLink);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    if (shouldAutofocusInput()) {
      setTimeout(() => input.focus(), 100);
    }
  });
}
