import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { randomUUID } from 'crypto';
import { Router, urlencoded, type Request, type Response } from 'express';
import type { AuthStrategy, AuthenticatedUser } from './strategy.js';
import { getSessionCookie, setSessionCookie, clearSessionCookie } from '../cookies.js';
import {
  createShareAuthSession,
  getShareAuthSession,
  revokeShareAuthSession,
  createLocalUser,
  getLocalUserByEmail,
  getLocalUserById,
  updateLocalUserName,
  updateLocalUserEmail,
  updateLocalUserPassword,
  touchShareAuthSessionVerification,
} from '../db.js';

// ── Password hashing ─────────────────────────────────────────────────────────

function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString('hex');
    scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve(`${salt}:${derived.toString('hex')}`);
    });
  });
}

function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) { resolve(false); return; }
    scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve(timingSafeEqual(Buffer.from(hash, 'hex'), derived));
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeReturnTo(value: string): string {
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  return '/';
}

function getInviteCode(): string | null {
  const code = (process.env.PROOF_LOCAL_INVITE_CODE || '').trim();
  return code || null;
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

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

function formPage(options: {
  title: string;
  error?: string | null;
  fields: string;
  submitLabel: string;
  footerHtml?: string;
  action: string;
  returnTo: string;
}): string {
  const { title, error, fields, submitLabel, footerHtml, action, returnTo } = options;
  const errorBlock = error
    ? `<div class="error">${escapeHtml(error)}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | Proof</title>
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?v=20260309p">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://api.fontshare.com/v2/css?f[]=switzer@1,2&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Switzer', 'Switzer Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f5f3ec; color: #26251e;
      min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      width: min(420px, 100%); background: #edeae0;
      border: 1px solid rgba(38, 37, 30, 0.03); border-radius: 4px;
      padding: 40px 32px; position: relative;
    }
    h1 { font-size: 26px; font-weight: 400; color: #26251e; margin-bottom: 24px; text-align: center; letter-spacing: -0.325px; }
    .error {
      background: rgba(220, 38, 38, 0.08); border: 1px solid rgba(220, 38, 38, 0.15);
      color: #991b1b; border-radius: 4px; padding: 10px 14px;
      font-size: 14px; margin-bottom: 20px; text-align: center;
    }
    label { display: block; font-size: 14px; font-weight: 400; color: rgba(38, 37, 30, 0.6); margin-bottom: 6px; }
    input[type="text"], input[type="email"], input[type="password"] {
      width: 100%; padding: 10px 14px; border-radius: 4px;
      border: 1px solid rgba(38, 37, 30, 0.12); background: #f5f3ec; color: #26251e;
      font-family: inherit; font-size: 15px; margin-bottom: 16px; outline: none; transition: border-color 0.15s;
    }
    input:focus { border-color: #266854; }
    .btn {
      width: 100%; padding: 12.48px; border-radius: 33554400px; border: none;
      background: linear-gradient(-1.66deg, #266854 4.43%, #1f8a65 110.83%);
      color: #f7f7f4; font-family: inherit; font-size: 16px; font-weight: 400;
      cursor: pointer; margin-top: 4px;
      transition: filter 0.2s ease, transform 0.1s ease, box-shadow 0.2s ease;
    }
    .btn:hover { filter: brightness(1.1); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(38, 104, 84, 0.3); }
    .btn:active { transform: translateY(1px); }
    .footer { text-align: center; margin-top: 20px; font-size: 14px; color: rgba(38, 37, 30, 0.6); }
    .footer a { color: #14a378; font-weight: 600; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    ${errorBlock}
    <form method="POST" action="${escapeAttr(action)}">
      <input type="hidden" name="return_to" value="${escapeAttr(returnTo)}">
      ${fields}
      <button type="submit" class="btn">${escapeHtml(submitLabel)}</button>
    </form>
    ${footerHtml ? `<div class="footer">${footerHtml}</div>` : ''}
  </div>
</body>
</html>`;
}

// ── Strategy ─────────────────────────────────────────────────────────────────

export class LocalAuthStrategy implements AuthStrategy {
  readonly name = 'local';
  readonly router: Router;

  constructor() {
    this.router = this.buildRouter();
  }

  resolveUser(req: Request): AuthenticatedUser | null {
    const sessionToken = getSessionCookie(req);
    if (!sessionToken) return null;

    const session = getShareAuthSession(sessionToken);
    if (!session || session.revoked_at || session.provider !== 'local') return null;
    if (new Date(session.session_expires_at) < new Date()) return null;

    let data: { localUserId: number };
    try {
      data = JSON.parse(session.access_token);
    } catch {
      return null;
    }

    return {
      id: String(data.localUserId),
      email: session.email,
      name: session.name,
      organizationId: null,
      organizationName: null,
      sessionToken,
    };
  }

  checkAccess(_user: AuthenticatedUser, _req: Request): string | null {
    return null;
  }

  loginUrl(returnTo: string): string {
    return `/auth/login?return_to=${encodeURIComponent(returnTo)}`;
  }

  logout(req: Request, res: Response): void {
    const sessionToken = getSessionCookie(req);
    if (sessionToken) revokeShareAuthSession(sessionToken);
    clearSessionCookie(req, res);
    res.redirect('/auth/login');
  }

  private createSession(userId: number, email: string, name: string | null, req: Request, res: Response): void {
    const sessionToken = randomUUID();
    const now = new Date();
    const sessionExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    createShareAuthSession({
      sessionToken,
      provider: 'local',
      everyUserId: 0,
      email,
      name,
      accessToken: JSON.stringify({ localUserId: userId }),
      accessExpiresAt: sessionExpiresAt.toISOString(),
      sessionExpiresAt: sessionExpiresAt.toISOString(),
    });

    setSessionCookie(req, res, sessionToken);
  }

  private buildRouter(): Router {
    const router = Router();
    const parseForm = urlencoded({ extended: false });

    // ── Login ────────────────────────────────────────────────────────────

    router.get('/auth/login', (req: Request, res: Response) => {
      const returnTo = sanitizeReturnTo(typeof req.query.return_to === 'string' ? req.query.return_to : '/');
      const registerLink = `/auth/register${returnTo !== '/' ? `?return_to=${encodeURIComponent(returnTo)}` : ''}`;
      res.type('html').send(formPage({
        title: 'Sign In',
        action: '/auth/login',
        returnTo,
        submitLabel: 'Sign In',
        fields: `
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required autofocus>
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required>`,
        footerHtml: `Don't have an account? <a href="${escapeAttr(registerLink)}">Register</a>`,
      }));
    });

    router.post('/auth/login', parseForm, async (req: Request, res: Response) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const returnTo = sanitizeReturnTo(typeof req.body?.return_to === 'string' ? req.body.return_to : '/');

      if (!email || !password) {
        res.status(400).type('html').send(formPage({
          title: 'Sign In', action: '/auth/login', returnTo, submitLabel: 'Sign In',
          error: 'Email and password are required.',
          fields: `
            <label for="email">Email</label>
            <input type="email" id="email" name="email" value="${escapeAttr(email)}" required autofocus>
            <label for="password">Password</label>
            <input type="password" id="password" name="password" required>`,
          footerHtml: `Don't have an account? <a href="/auth/register">Register</a>`,
        }));
        return;
      }

      const user = getLocalUserByEmail(email);
      const valid = user ? await verifyPassword(password, user.password_hash) : false;

      if (!user || !valid) {
        res.status(401).type('html').send(formPage({
          title: 'Sign In', action: '/auth/login', returnTo, submitLabel: 'Sign In',
          error: 'Invalid email or password.',
          fields: `
            <label for="email">Email</label>
            <input type="email" id="email" name="email" value="${escapeAttr(email)}" required autofocus>
            <label for="password">Password</label>
            <input type="password" id="password" name="password" required>`,
          footerHtml: `Don't have an account? <a href="/auth/register">Register</a>`,
        }));
        return;
      }

      this.createSession(user.id, user.email, user.name, req, res);
      res.redirect(returnTo);
    });

    // ── Register ─────────────────────────────────────────────────────────

    router.get('/auth/register', (req: Request, res: Response) => {
      const returnTo = sanitizeReturnTo(typeof req.query.return_to === 'string' ? req.query.return_to : '/');
      const inviteRequired = getInviteCode() !== null;
      const loginLink = `/auth/login${returnTo !== '/' ? `?return_to=${encodeURIComponent(returnTo)}` : ''}`;
      res.type('html').send(formPage({
        title: 'Register',
        action: '/auth/register',
        returnTo,
        submitLabel: 'Create Account',
        fields: `
          <label for="name">Name</label>
          <input type="text" id="name" name="name">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required autofocus>
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required>
          ${inviteRequired ? `<label for="invite_code">Invite Code</label>
          <input type="text" id="invite_code" name="invite_code" required>` : ''}`,
        footerHtml: `Already have an account? <a href="${escapeAttr(loginLink)}">Sign in</a>`,
      }));
    });

    router.post('/auth/register', parseForm, async (req: Request, res: Response) => {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const inviteInput = typeof req.body?.invite_code === 'string' ? req.body.invite_code.trim() : '';
      const returnTo = sanitizeReturnTo(typeof req.body?.return_to === 'string' ? req.body.return_to : '/');
      const inviteRequired = getInviteCode();
      const inviteRequiredBool = inviteRequired !== null;

      const renderError = (error: string) => {
        res.status(400).type('html').send(formPage({
          title: 'Register', action: '/auth/register', returnTo, submitLabel: 'Create Account',
          error,
          fields: `
            <label for="name">Name</label>
            <input type="text" id="name" name="name" value="${escapeAttr(name)}">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" value="${escapeAttr(email)}" required>
            <label for="password">Password</label>
            <input type="password" id="password" name="password" required>
            ${inviteRequiredBool ? `<label for="invite_code">Invite Code</label>
            <input type="text" id="invite_code" name="invite_code" value="${escapeAttr(inviteInput)}" required>` : ''}`,
          footerHtml: `Already have an account? <a href="/auth/login">Sign in</a>`,
        }));
      };

      if (!email || !password) {
        renderError('Email and password are required.');
        return;
      }

      if (inviteRequired && !constantTimeCompare(inviteInput, inviteRequired)) {
        renderError('Invalid invite code.');
        return;
      }

      const existing = getLocalUserByEmail(email);
      if (existing) {
        renderError('An account with this email already exists.');
        return;
      }

      const passwordHash = await hashPassword(password);
      const user = createLocalUser({ email, passwordHash, name: name || null });

      this.createSession(user.id, user.email, user.name, req, res);
      res.redirect(returnTo);
    });

    // ── Account settings ──────────────────────────────────────────────────

    const successBanner = (msg: string) =>
      `<div style="background:rgba(38,104,84,0.08);border:1px solid rgba(38,104,84,0.15);color:#266854;border-radius:4px;padding:10px 14px;font-size:14px;margin-bottom:20px;text-align:center;">${escapeHtml(msg)}</div>`;

    const errorBanner = (msg: string) =>
      `<div class="error">${escapeHtml(msg)}</div>`;

    const sectionDivider = '<hr style="border:none;border-top:1px solid rgba(38,37,30,0.08);margin:24px 0;">';

    const renderAccountPage = (user: AuthenticatedUser, opts?: { nameMsg?: string; emailMsg?: string; emailErr?: string; pwMsg?: string; pwErr?: string }) => {
      const o = opts ?? {};
      return formPage({
        title: 'Account',
        action: '/auth/account/name',
        returnTo: '/',
        submitLabel: 'Update Name',
        fields: `
          ${o.nameMsg ? successBanner(o.nameMsg) : ''}
          <label for="name">Name</label>
          <input type="text" id="name" name="name" value="${escapeAttr(user.name || '')}">
        </form>
        ${sectionDivider}
        <form method="POST" action="/auth/account/email">
          ${o.emailMsg ? successBanner(o.emailMsg) : ''}${o.emailErr ? errorBanner(o.emailErr) : ''}
          <label for="email">Email</label>
          <input type="email" id="email" name="email" value="${escapeAttr(user.email)}" required>
          <label for="email_password">Current Password</label>
          <input type="password" id="email_password" name="password" required>
          <button type="submit" class="btn" style="margin-bottom:0;">Update Email</button>
        </form>
        ${sectionDivider}
        <form method="POST" action="/auth/account/password">
          ${o.pwMsg ? successBanner(o.pwMsg) : ''}${o.pwErr ? errorBanner(o.pwErr) : ''}
          <label for="current_password">Current Password</label>
          <input type="password" id="current_password" name="current_password" required>
          <label for="new_password">New Password</label>
          <input type="password" id="new_password" name="new_password" required>
          <button type="submit" class="btn" style="margin-bottom:0;">Update Password</button>`,
        footerHtml: '<a href="/">&larr; Back</a>',
      });
    };

    router.get('/auth/account', (req: Request, res: Response) => {
      const user = req.authenticatedUser;
      if (!user) { res.redirect('/auth/login'); return; }
      res.type('html').send(renderAccountPage(user));
    });

    router.post('/auth/account/name', parseForm, (req: Request, res: Response) => {
      const user = req.authenticatedUser;
      if (!user) { res.redirect('/auth/login'); return; }

      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      updateLocalUserName(Number(user.id), name || null);
      touchShareAuthSessionVerification({ sessionToken: user.sessionToken, name: name || null });

      // Reflect updated name in the rendered page
      const updated = { ...user, name: name || null };
      res.type('html').send(renderAccountPage(updated, { nameMsg: 'Name updated.' }));
    });

    router.post('/auth/account/email', parseForm, async (req: Request, res: Response) => {
      const user = req.authenticatedUser;
      if (!user) { res.redirect('/auth/login'); return; }

      const newEmail = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';

      if (!newEmail || !password) {
        res.status(400).type('html').send(renderAccountPage(user, { emailErr: 'Email and current password are required.' }));
        return;
      }

      // Verify current password
      const dbUser = getLocalUserById(Number(user.id));
      if (!dbUser || !(await verifyPassword(password, dbUser.password_hash))) {
        res.status(401).type('html').send(renderAccountPage(user, { emailErr: 'Incorrect password.' }));
        return;
      }

      // Check uniqueness
      const existing = getLocalUserByEmail(newEmail);
      if (existing && existing.id !== dbUser.id) {
        res.status(400).type('html').send(renderAccountPage(user, { emailErr: 'That email is already in use.' }));
        return;
      }

      updateLocalUserEmail(dbUser.id, newEmail);
      touchShareAuthSessionVerification({ sessionToken: user.sessionToken, email: newEmail });

      const updated = { ...user, email: newEmail };
      res.type('html').send(renderAccountPage(updated, { emailMsg: 'Email updated.' }));
    });

    router.post('/auth/account/password', parseForm, async (req: Request, res: Response) => {
      const user = req.authenticatedUser;
      if (!user) { res.redirect('/auth/login'); return; }

      const currentPassword = typeof req.body?.current_password === 'string' ? req.body.current_password : '';
      const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';

      if (!currentPassword || !newPassword) {
        res.status(400).type('html').send(renderAccountPage(user, { pwErr: 'Both fields are required.' }));
        return;
      }

      const dbUser = getLocalUserById(Number(user.id));
      if (!dbUser || !(await verifyPassword(currentPassword, dbUser.password_hash))) {
        res.status(401).type('html').send(renderAccountPage(user, { pwErr: 'Incorrect current password.' }));
        return;
      }

      const newHash = await hashPassword(newPassword);
      updateLocalUserPassword(dbUser.id, newHash);

      res.type('html').send(renderAccountPage(user, { pwMsg: 'Password updated.' }));
    });

    // ── Logout ───────────────────────────────────────────────────────────

    router.get('/auth/logout', (req: Request, res: Response) => {
      this.logout(req, res);
    });

    return router;
  }
}
