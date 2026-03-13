import crypto from 'crypto';

const SLUG_LENGTH = 8;
const SLUG_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generateSlug(): string {
  const bytes = crypto.randomBytes(SLUG_LENGTH);
  let slug = '';
  for (let i = 0; i < SLUG_LENGTH; i++) {
    slug += SLUG_CHARS[bytes[i] % SLUG_CHARS.length];
  }
  return slug;
}
