const test = require('node:test');
const assert = require('node:assert/strict');
const { IncomingMessage, ServerResponse } = require('node:http');
const { Socket } = require('node:net');
const { Script } = require('node:vm');
const { createApp } = require('../app');
const { loadAccessConfig } = require('../access');

const env = {
  PAYMENT_ADMIN_USERNAME: 'fixture-admin', PAYMENT_ADMIN_PASSWORD: 'fixture-password-'.repeat(4),
  PAYMENT_PUBLIC_ORIGIN: 'https://payment.example.invalid',
  GOOGLE_CLIENT_EMAIL: 'PRIVATE_EMAIL_FIXTURE', GOOGLE_PRIVATE_KEY: 'PRIVATE_KEY_FIXTURE',
  GOOGLE_SERVICE_ACCOUNT_JSON: 'PRIVATE_JSON_FIXTURE', OUTPUT_SPREADSHEET_ID: 'FIXED_OUTPUT_FIXTURE',
};
const access = loadAccessConfig(env);
const basic = 'Basic ' + Buffer.from(`${env.PAYMENT_ADMIN_USERNAME}:${env.PAYMENT_ADMIN_PASSWORD}`).toString('base64');

// Express is dispatched entirely in memory: no listening socket, cron, Google module or network request.
function request(app, url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = options.method || 'GET'; req.url = url;
    req.headers = Object.fromEntries(Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = options.body === undefined ? '' : JSON.stringify(options.body);
    if (body) { req.headers['content-type'] = 'application/json'; req.headers['content-length'] = Buffer.byteLength(body).toString(); }
    const res = new ServerResponse(req); const chunks = [];
    res.write = (chunk, encoding, callback) => {
      if (chunk) chunks.push(Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
      if (typeof encoding === 'function') encoding();
      if (typeof callback === 'function') callback();
      return true;
    };
    res.end = (chunk, encoding) => {
      if (chunk) chunks.push(Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
      res.emit('finish'); socket.destroy();
      resolve({ status: res.statusCode, headers: res.getHeaders(), text: Buffer.concat(chunks).toString() });
      return res;
    };
    app.handle(req, res, reject);
    req.push(body || null); if (body) req.push(null);
  });
}

function fixture() {
  const calls = [];
  const services = {
    getCurrentYearMonth: () => '2026/10', getPreviousYearMonth: () => '2026/9',
    async getActiveStudents() { calls.push('students'); return [{ studentId: 'SYNTHETIC_ID', name: 'SYNTHETIC_NAME' }]; },
    async getPaymentData(month) { calls.push(['payment', month]); return { SYNTHETIC_ID: '完了' }; },
    async getOutputSpreadsheetData() { calls.push('data'); return [['学籍番号', '名前'], ['SYNTHETIC_ID', 'SYNTHETIC_NAME']]; },
    getColumnIndexForMonth: () => 4, colIndexToLetter: () => 'E',
    async testConnection() { calls.push('status'); return { authConfigured: true, studentSheet: true, paymentSheet: true,
      outputSheet: true, errors: ['PRIVATE_CONNECTION_ERROR_FIXTURE'], extra: 'PRIVATE_EXTRA_FIXTURE' }; },
    async syncData(month) { calls.push(['sync', month]); return { success: true, updated: 1 }; },
    async createOutputSpreadsheet() { throw new Error('Creation must never be called'); },
  };
  return { app: createApp(access, services, env), calls, services };
}

test('access settings must be explicit and HTTPS, no insecure defaults', () => {
  for (const key of ['PAYMENT_ADMIN_USERNAME', 'PAYMENT_ADMIN_PASSWORD', 'PAYMENT_PUBLIC_ORIGIN']) {
    assert.throws(() => loadAccessConfig({ ...env, [key]: undefined }));
  }
  assert.throws(() => loadAccessConfig({ ...env, PAYMENT_ADMIN_PASSWORD: 'short' }));
  assert.throws(() => loadAccessConfig({ ...env, PAYMENT_PUBLIC_ORIGIN: 'http://public.example.invalid' }));
  assert.throws(() => loadAccessConfig({ ...env, PAYMENT_PUBLIC_ORIGIN: 'https://payment.example.invalid/path' }));
  assert.doesNotThrow(() => loadAccessConfig({ ...env, PAYMENT_PUBLIC_ORIGIN: 'http://localhost:3000' }));
});

test('health alone is public, anonymous dashboard/static/API denied without services', async () => {
  const { app, calls } = fixture();
  assert.equal((await request(app, '/health')).status, 200);
  for (const path of ['/', '/index.html', '/favicon.svg', '/api/students', '/api/data', '/api/debug-auth', '/api/status', '/api/payment/2026%2F4']) {
    const response = await request(app, path);
    assert.equal(response.status, 401, path); assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(!response.text.includes('SYNTHETIC_')); assert.ok(!response.text.includes('PRIVATE_'));
  }
  for (const path of ['/api/sync', '/api/create-spreadsheet']) {
    assert.equal((await request(app, path, { method: 'POST' })).status, 401);
  }
  assert.deepEqual(calls, []);
});

test('wrong credentials rejected, authenticated data/status routes work without raw diagnostics', async () => {
  const { app } = fixture();
  assert.equal((await request(app, '/api/data', { headers: { Authorization: 'Basic !!!' } })).status, 401);
  assert.equal((await request(app, '/api/data', { headers: { Authorization: 'Basic ' + Buffer.from('wrong:wrong').toString('base64') } })).status, 401);
  for (const path of ['/api/data', '/api/students', '/api/payment/2026%2F4', '/api/column-info/2026%2F4', '/api/status']) {
    const response = await request(app, path, { headers: { Authorization: basic } });
    assert.equal(response.status, 200, path);
    assert.ok(!response.text.includes('PRIVATE_'));
  }
  const dashboard = await request(app, '/', { headers: { Authorization: basic } });
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.text.includes('X-Payment-Request'));
  assert.ok(!dashboard.text.includes(env.PAYMENT_ADMIN_PASSWORD));
  for (const match of dashboard.text.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Script(match[1]));
});

test('diagnostics returns booleans only, including configured credential values', async () => {
  const { app } = fixture();
  const response = await request(app, '/api/debug-auth', { headers: { Authorization: basic } });
  assert.equal(response.status, 200); assert.ok(!response.text.includes('PRIVATE_'));
  assert.deepEqual(JSON.parse(response.text), { individual: { emailConfigured: true, privateKeyConfigured: true }, jsonConfigured: true });
});

test('writes require header and reject foreign origin before calling sync', async () => {
  const { app, calls } = fixture();
  assert.equal((await request(app, '/api/sync', { method: 'POST', headers: { Authorization: basic }, body: {} })).status, 403);
  assert.equal((await request(app, '/api/sync', { method: 'POST', headers: { Authorization: basic, 'X-Payment-Request': '1', Origin: 'https://foreign.example.invalid' }, body: {} })).status, 403);
  assert.deepEqual(calls, []);
  const response = await request(app, '/api/sync', { method: 'POST', headers: { Authorization: basic, 'X-Payment-Request': '1', Origin: env.PAYMENT_PUBLIC_ORIGIN }, body: { yearMonth: '2026/4' } });
  assert.equal(response.status, 200); assert.deepEqual(calls, [['sync', '2026/4']]);
});

test('output destination cannot be replaced or created through HTTP', async () => {
  const { app, calls } = fixture();
  const headers = { Authorization: basic, 'X-Payment-Request': '1', Origin: env.PAYMENT_PUBLIC_ORIGIN };
  for (const body of [{ spreadsheetId: 'ATTACKER_FIXTURE' }, { yearMonth: '2026/4', outputSpreadsheetId: 'ATTACKER_FIXTURE' }, { yearMonth: 123 }, { yearMonth: '2025/1' }, []]) {
    assert.equal((await request(app, '/api/sync', { method: 'POST', headers, body })).status, 400);
  }
  assert.equal((await request(app, '/api/create-spreadsheet', { method: 'POST', headers, body: {} })).status, 410);
  assert.equal(env.OUTPUT_SPREADSHEET_ID, 'FIXED_OUTPUT_FIXTURE');
  assert.deepEqual(calls, []);
});

test('server exception details are not returned', async () => {
  const { services } = fixture();
  services.getActiveStudents = async () => { throw new Error('PRIVATE_EXCEPTION_FIXTURE'); };
  const response = await request(createApp(access, services, env), '/api/students', { headers: { Authorization: basic } });
  assert.equal(response.status, 500); assert.ok(!response.text.includes('PRIVATE_'));
});
