# Local Auth Strategy Design

**Date:** 2026-04-09

## Goal

Add a `local` auth strategy to the existing pluggable auth system. Users register and log in with email/password. Registration is gated by an optional invite code (env var). Sessions reuse the existing `share_auth_sessions` table.

## Architecture

A new `LocalAuthStrategy` class in `server/auth/local.ts` implementing the existing `AuthStrategy` interface. A new `local_users` table in SQLite stores credentials. Server-rendered HTML forms handle login and registration (no SPA/JS needed). One new line in the factory switch in `server/auth/index.ts`.

## Database

New `local_users` table:

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `email` | TEXT | NOT NULL, UNIQUE (case-insensitive via collation) |
| `password_hash` | TEXT | NOT NULL |
| `name` | TEXT | |
| `created_at` | TEXT | NOT NULL (ISO 8601) |

Sessions are stored in the existing `share_auth_sessions` table with `provider = 'local'`. The `access_token` JSON blob stores `{ localUserId: number }`.

## Password Hashing

Node's built-in `crypto.scrypt` with a random 16-byte salt. Stored as `salt:hash` in the `password_hash` column. No external dependency needed. No password requirements enforced.

## Registration Flow

- `PROOF_LOCAL_INVITE_CODE` env var controls registration access.
- When set: the registration form shows an "Invite Code" field and validates it on submit.
- When unset: open registration, no invite code field shown.
- `GET /auth/register` renders the registration form (email, password, name, invite code if required).
- `POST /auth/register` validates input, checks invite code if required, checks email uniqueness, creates user, creates session, redirects to `return_to` (default `/`).
- Error states: invalid invite code, email already taken, missing required fields. Errors shown inline on the form.

## Login Flow

- `GET /auth/login` renders the login form (email, password) with a link to the registration page.
- `POST /auth/login` verifies credentials against `local_users`, creates session in `share_auth_sessions`, sets `proof_session` cookie, redirects to `return_to`.
- Error states: invalid credentials. Generic "Invalid email or password" message (no user enumeration).
- `GET /auth/logout` revokes session, clears cookie, redirects to `/auth/login`.

## Form Styling

Server-rendered HTML matching the existing dark theme (same palette as `forbidden-page.ts` and `share-web-routes.ts` `renderUnavailableHtml`): `#0f172a` background, `#334155` borders, `#f8fafc` headings, `#3b82f6` primary buttons.

## Security

- `return_to` parameter validated with `sanitizeReturnTo` (same as WorkOS strategy) to prevent open redirects.
- Timing-safe password comparison via `crypto.timingSafeEqual`.
- Generic error messages on login failure to prevent user enumeration.
- Invite code comparison is constant-time.

## Configuration

| Env Var | Required | Description |
|---------|----------|-------------|
| `PROOF_AUTH_STRATEGY` | Yes | Set to `local` |
| `PROOF_LOCAL_INVITE_CODE` | No | When set, registration requires this code. When unset, open registration. |

## Files

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `server/auth/local.ts` | `LocalAuthStrategy` class: routes, user resolution, password hashing, form rendering |
| Modify | `server/auth/index.ts` | Add `case 'local'` to factory switch |
| Modify | `server/db.ts` | Add `local_users` table creation + `createLocalUser`, `getLocalUserByEmail` helpers |
| Modify | `.env.example` | Document `PROOF_LOCAL_INVITE_CODE` |

## What This Does NOT Include

- Email verification
- Password reset flow
- Rate limiting on login attempts (can be added later)
- Admin UI for user management
- Password requirements
