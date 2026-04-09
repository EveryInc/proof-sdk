/**
 * Welcome card overlay for new documents.
 * Shows when URL has ?welcome=1 and can be dismissed.
 */

function buildDocUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete('welcome');
  return url.toString();
}

function buildPrompt(docUrl: string): string {
  return `Here's my Proof document: ${docUrl}

Proof is a collaborative writing editor that tracks who wrote what (human vs AI). You can read the doc, suggest edits, leave comments, and rewrite content via its HTTP API. API docs: ${window.location.origin}/agent-docs

Connect to this document and help me get started. Write something to kick things off - here are some ideas:

- A plan for a new feature or project I'm working on
- Weekly goals for what I want to accomplish
- A draft blog post or essay on a topic I'm thinking about
- A grocery list or meal plan for the week
- A brainstorm of ideas for something I'm stuck on

Pick one that feels useful, or ask me what I'd like to work on. Use suggestions and comments to show me how collaboration works.`;
}

function injectStyles(): void {
  if (document.getElementById('welcome-card-styles')) return;
  const style = document.createElement('style');
  style.id = 'welcome-card-styles';
  style.textContent = `
    @keyframes welcome-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes welcome-slide-up {
      from { opacity: 0; transform: translateY(24px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes welcome-fade-out {
      from { opacity: 1; }
      to { opacity: 0; }
    }
    #welcome-overlay {
      position: fixed;
      inset: 0;
      z-index: 10000;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      display: flex;
      align-items: center;
      justify-content: center;
      animation: welcome-fade-in 200ms ease-out;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    #welcome-overlay.dismissing {
      animation: welcome-fade-out 150ms ease-in forwards;
    }
    .welcome-card {
      background: #fff;
      border-radius: 12px;
      border: 1px solid #e5e7eb;
      padding: 0;
      max-width: 460px;
      width: 92%;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06);
      animation: welcome-slide-up 300ms cubic-bezier(0.16, 1, 0.3, 1);
      color: #1a1a1a;
      overflow: hidden;
    }
    .welcome-body { padding: 32px 32px 0; }
    .welcome-card h2 {
      margin: 0 0 8px;
      font-size: 22px;
      font-weight: 700;
      color: #111;
      letter-spacing: -0.4px;
    }
    .welcome-card .welcome-subtitle {
      margin: 0 0 20px;
      font-size: 15px;
      color: #6b7280;
      line-height: 1.55;
    }
    .welcome-what-happens {
      background: #f9fafb;
      border: 1px solid #f3f4f6;
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 20px;
    }
    .welcome-what-happens-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #6b7280;
      margin-bottom: 10px;
    }
    .welcome-what-happens-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .welcome-what-happens-list li {
      font-size: 14px;
      color: #374151;
      line-height: 1.4;
      padding-left: 20px;
      position: relative;
    }
    .welcome-what-happens-list li::before {
      content: '';
      position: absolute;
      left: 0;
      top: 7px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #d1d5db;
    }
    .welcome-prompt-label {
      font-size: 13px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 8px;
    }
    .welcome-prompt-box {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 14px 16px;
      font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 12px;
      line-height: 1.6;
      color: #374151;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 100px;
      overflow-y: auto;
      user-select: all;
      cursor: text;
    }
    .welcome-copy-btn {
      width: 100%;
      margin-top: 14px;
      padding: 12px 16px;
      background: #111;
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 150ms ease;
      font-family: inherit;
      letter-spacing: -0.1px;
    }
    .welcome-copy-btn:hover { background: #333; }
    .welcome-copy-btn:active { background: #000; }
    .welcome-copy-btn.copied { background: #16a34a; }
    .welcome-footer { padding: 16px 32px 28px; text-align: center; }
    .welcome-dismiss-btn {
      padding: 0;
      background: none;
      border: none;
      color: #9ca3af;
      font-size: 13px;
      cursor: pointer;
      transition: color 100ms;
      font-family: inherit;
    }
    .welcome-dismiss-btn:hover { color: #6b7280; }
    .welcome-hint {
      margin-top: 14px;
      font-size: 12px;
      color: #9ca3af;
      line-height: 1.5;
    }
    @media (max-width: 520px) {
      .welcome-card { border-radius: 10px; }
      .welcome-body { padding: 24px 20px 0; }
      .welcome-footer { padding: 12px 20px 20px; }
      .welcome-card h2 { font-size: 20px; }
      .welcome-what-happens { padding: 14px 16px; }
    }
  `;
  document.head.appendChild(style);
}

function copyToClipboard(text: string, btn: HTMLButtonElement): void {
  const applyCopiedState = () => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 2000);
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(applyCopiedState).catch(() => {
      // no-op
    });
    return;
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (copied) applyCopiedState();
  } catch {
    // no-op
  }
}

function dismiss(overlay: HTMLElement): void {
  overlay.classList.add('dismissing');
  setTimeout(() => overlay.remove(), 150);
  const url = new URL(window.location.href);
  url.searchParams.delete('welcome');
  window.history.replaceState({}, '', url.toString());
}

export function showWelcomeCard(): void {
  if (document.getElementById('welcome-overlay')) return;
  injectStyles();

  const docUrl = buildDocUrl();
  const prompt = buildPrompt(docUrl);

  const overlay = document.createElement('div');
  overlay.id = 'welcome-overlay';

  const card = document.createElement('div');
  card.className = 'welcome-card';

  const body = document.createElement('div');
  body.className = 'welcome-body';

  const heading = document.createElement('h2');
  heading.textContent = 'Write with an AI agent';

  const subtitle = document.createElement('p');
  subtitle.className = 'welcome-subtitle';
  subtitle.textContent = 'Copy the prompt below and paste it into any AI agent - your Claw, Claude Code, ChatGPT, Codex - and it will connect to this document.';

  const whatHappens = document.createElement('div');
  whatHappens.className = 'welcome-what-happens';

  const whatTitle = document.createElement('div');
  whatTitle.className = 'welcome-what-happens-title';
  whatTitle.textContent = 'What your agent can do';

  const whatList = document.createElement('ul');
  whatList.className = 'welcome-what-happens-list';
  [
    'Suggest edits for you to accept or reject',
    'Leave comments and respond to yours',
    'Write with you - and you will always see who wrote what',
  ].forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    whatList.appendChild(li);
  });
  whatHappens.append(whatTitle, whatList);

  const promptLabel = document.createElement('div');
  promptLabel.className = 'welcome-prompt-label';
  promptLabel.textContent = 'Copy this prompt';

  const promptBox = document.createElement('div');
  promptBox.className = 'welcome-prompt-box';
  promptBox.textContent = prompt;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'welcome-copy-btn';
  copyBtn.textContent = 'Copy to clipboard';
  copyBtn.addEventListener('click', () => copyToClipboard(prompt, copyBtn));

  const hint = document.createElement('div');
  hint.className = 'welcome-hint';
  hint.textContent = 'Works with Claw, Claude Code, Codex, ChatGPT, Cursor, and more.';

  const footer = document.createElement('div');
  footer.className = 'welcome-footer';
  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'welcome-dismiss-btn';
  dismissBtn.textContent = 'Skip - just start writing';
  dismissBtn.addEventListener('click', () => dismiss(overlay));
  footer.appendChild(dismissBtn);

  body.append(heading, subtitle, whatHappens, promptLabel, promptBox, copyBtn, hint);
  card.append(body, footer);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) dismiss(overlay);
  });
}

export function maybeShowWelcomeCard(): void {
  let url: URL | null = null;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  if (url.searchParams.get('welcome') !== '1') return;
  showWelcomeCard();
}
