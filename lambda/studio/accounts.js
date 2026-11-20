// Voice Studio email + password accounts, for people without a Microsoft
// account (any Gmail etc.). Addresses are NOT verified, so a password account:
//   - can never be a super user (studio/index.js checks identity.passwordAccount);
//   - cannot use an NTU address (those must sign in with Microsoft);
//   - cannot claim an address that already has studio work from a Microsoft sign-in.
// Accounts live in their own S3 JSON (studio/accounts.json), never in the
// state document the console reads, so password hashes are never sent anywhere.
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { normalizeEmail } from '../shared/voiceIdentity.js';
import { clientError, isFixtureEmail } from './workflow.js';

export const ACCOUNTS_KEY = 'studio/accounts.json';
export const MIN_PASSWORD_LENGTH = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    scryptCallback(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export function normalizeAccounts(raw) {
  return { schemaVersion: 1, accounts: Array.isArray(raw?.accounts) ? raw.accounts : [] };
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function passwordMatches(password, stored) {
  const [scheme, saltText, hashText] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64');
  const actual = await scrypt(password, Buffer.from(saltText, 'base64'));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Addresses that must sign in with Microsoft (NTU's own tenant). */
export function requiresMicrosoft(email, env = process.env) {
  const domain = normalizeEmail(email).split('@')[1] || '';
  const homes = String(env.STUDIO_HOME_DOMAINS || 'ntu.edu.sg').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return homes.some((home) => domain === home || domain.endsWith(`.${home}`));
}

export function validateRegistration({ email, password, name }, env = process.env) {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) || normalized.length > 120) throw clientError(400, 'Enter a valid email address');
  if (requiresMicrosoft(normalized, env)) throw clientError(400, 'NTU addresses sign in with Microsoft — use "Sign in with Microsoft" instead');
  if (isFixtureEmail(normalized)) throw clientError(400, 'That address is reserved for test accounts');
  if (String(password || '').length < MIN_PASSWORD_LENGTH) throw clientError(400, `Use a password of at least ${MIN_PASSWORD_LENGTH} characters`);
  if (String(password).length > 200) throw clientError(400, 'That password is too long');
  const cleanName = String(name || '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 80);
  if (!cleanName) throw clientError(400, 'Enter your name');
  return { email: normalized, name: cleanName };
}

export function findAccount(accounts, email) {
  const normalized = normalizeEmail(email);
  return accounts.accounts.find((account) => account.email === normalized) || null;
}
