const { createHash, timingSafeEqual } = require('node:crypto');

function loadAccessConfig(env) {
  const username = env.PAYMENT_ADMIN_USERNAME || '';
  const password = env.PAYMENT_ADMIN_PASSWORD || '';
  if (!/^[A-Za-z0-9_.@-]{1,100}$/.test(username)) {
    throw new Error('PAYMENT_ADMIN_USERNAME is required and must be a valid account name');
  }
  if (password.length < 32 || password.length > 512 || /\s/.test(password)) {
    throw new Error('PAYMENT_ADMIN_PASSWORD must be an independently generated secret of at least 32 characters');
  }
  let origin;
  try { origin = new URL(env.PAYMENT_PUBLIC_ORIGIN || ''); }
  catch { throw new Error('PAYMENT_PUBLIC_ORIGIN is required'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))) {
    throw new Error('PAYMENT_PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed only for local development)');
  }
  return { username, password, publicOrigin: origin.origin };
}

function equalSecret(actual, expected) {
  return timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}

function requireAdmin(config) {
  return (req, res, next) => {
    const encoded = (req.get('Authorization') || '').match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i)?.[1];
    const credentials = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
    const separator = credentials.indexOf(':');
    const username = separator < 0 ? '' : credentials.slice(0, separator);
    const password = separator < 0 ? '' : credentials.slice(separator + 1);
    const userMatches = equalSecret(username, config.username);
    const passwordMatches = equalSecret(password, config.password);
    if (!userMatches || !passwordMatches) {
      res.set('WWW-Authenticate', 'Basic realm="Payment history admin", charset="UTF-8"');
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('Origin');
      if (req.get('X-Payment-Request') !== '1' || (origin && origin !== config.publicOrigin)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    next();
  };
}

module.exports = { loadAccessConfig, requireAdmin };
