import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { q } from './db.js';

const SECRET = process.env.JWT_SECRET || 'troque-este-segredo';

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = scryptSync(pw, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return test.length === ref.length && timingSafeEqual(test, ref);
}

export function signToken(user) {
  return jwt.sign({ uid: user.id, tid: user.tenant_id }, SECRET, { expiresIn: '30d' });
}

export function readToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

/** Middleware: exige Bearer token e carrega req.user / req.tenantId */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  const payload = token && readToken(token);
  if (!payload) return res.status(401).json({ error: 'Não autenticado' });

  const { rows } = await q(
    `SELECT u.*, t.active FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
    [payload.uid]
  );
  const user = rows[0];
  if (!user || user.active === false) return res.status(401).json({ error: 'Conta inativa' });

  req.user = user;
  req.tenantId = user.tenant_id;
  next();
}
