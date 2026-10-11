import { randomBytes, timingSafeEqual } from 'node:crypto';

export function newAccessToken() {
  return randomBytes(32).toString('base64url');
}

export function requestOrigin(request, port) {
  const host = request.headers.host;
  if (typeof host !== 'string' || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) return null;
  if (request.rawHeaders?.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length !== 1) return null;
  const origin = new URL(`http://${host}`);
  if (Number(origin.port || 80) !== port) return null;
  // Absolute-form targets must agree with Host, rather than supplying a second authority.
  if (!request.url.startsWith('/')) {
    try {
      const target = new URL(request.url);
      if (target.origin !== origin.origin || target.username || target.password) return null;
    } catch { return null; }
  }
  return origin.origin;
}

export function browserContextAllowed(request, origin) {
  const supplied = request.headers.origin;
  if (supplied !== undefined) {
    try {
      const parsed = new URL(supplied);
      if (parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    } catch { return false; }
  }
  const site = request.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

export function hasAccess(request, token) {
  const supplied = request.headers.authorization;
  if (typeof supplied !== 'string' || !supplied.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(supplied.slice(7));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
