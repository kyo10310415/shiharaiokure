const test = require('node:test');
const assert = require('node:assert/strict');
const { google } = require('googleapis');
const sheetsService = require('../googleSheets');

// Keep real GoogleAuth, generated APIs and Gaxios serialization; replace only
// credential metadata and the final HTTP transport. No live credentials or I/O.
function offlineGoogle(t, respond) {
  for (const name of ['GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON',
    'STUDENT_SPREADSHEET_ID', 'OUTPUT_SPREADSHEET_ID']) {
    const old = process.env[name];
    t.after(() => old === undefined ? delete process.env[name] : process.env[name] = old);
  }
  process.env.GOOGLE_CLIENT_EMAIL = 'fixture@example.invalid';
  process.env.GOOGLE_PRIVATE_KEY = 'fixture-not-a-key';
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  process.env.STUDENT_SPREADSHEET_ID = 'fixture-students';
  process.env.OUTPUT_SPREADSHEET_ID = 'fixture-output';
  for (const mod of [require('node:http'), require('node:https')]) {
    t.mock.method(mod, 'request', () => { throw new Error('Unexpected network'); });
    t.mock.method(mod, 'get', () => { throw new Error('Unexpected network'); });
  }
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network'); });
  t.mock.method(console, 'log', () => {});
  const original = google.auth.GoogleAuth.prototype.getClient;
  const requests = [];
  t.mock.method(google.auth.GoogleAuth.prototype, 'getClient', async function () {
    const client = await original.call(this);
    assert.equal(client.email, 'fixture@example.invalid');
    client.getRequestMetadataAsync = async () => ({ headers: new Headers() });
    client.transporter.defaults.fetchImplementation = async (url, options) => {
      const request = { url: new URL(url), method: options.method, body: options.body ? JSON.parse(options.body) : undefined };
      requests.push(request);
      const { data = {}, status = 200 } = respond(request);
      return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    };
    return client;
  });
  return requests;
}

test('real Google client preserves student parsing and empty Sheets responses offline', async t => {
  let empty = false;
  const requests = offlineGoogle(t, () => ({ data: empty ? {} : { values: [
    ['id', 'name', 'status'], ['fixture-1', 'Fixture', 'アクティブ'], ['fixture-2', 'Fixture', '退会'],
  ] } }));
  assert.deepEqual(await sheetsService.getActiveStudents(), [{ studentId: 'fixture-1', name: 'Fixture', status: 'アクティブ' }]);
  empty = true;
  assert.deepEqual(await sheetsService.getActiveStudents(), []);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].url.hostname, 'sheets.googleapis.com');
  assert.match(decodeURIComponent(requests[0].url.pathname), /fixture-students\/values\/生徒データ!B:D$/);
});

test('Drive create and Sheets rename/init keep request bodies and methods offline', async t => {
  const requests = offlineGoogle(t, request => {
    if (request.url.hostname === 'www.googleapis.com') return { data: { id: 'fixture-created', webViewLink: 'https://example.invalid/fixture' } };
    if (request.method === 'GET') return { data: { sheets: [{ properties: { sheetId: 7, title: '未払い履歴' } }] } };
    return { data: {} };
  });
  assert.deepEqual(await sheetsService.createOutputSpreadsheet(), { spreadsheetId: 'fixture-created', spreadsheetUrl: 'https://example.invalid/fixture' });
  await sheetsService.initOutputSpreadsheet();
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].body.mimeType, 'application/vnd.google-apps.spreadsheet');
  assert.equal(requests[2].body.requests[0].updateSheetProperties.properties.sheetId, 7);
  const update = requests.find(r => r.method === 'PUT');
  assert.equal(update.url.searchParams.get('valueInputOption'), 'USER_ENTERED');
  assert.deepEqual(update.body.values[0], ['学籍番号', '名前', '支払い遅れ回数']);
});

test('monthly write keeps batch and append contracts offline', async t => {
  const requests = offlineGoogle(t, request => {
    if (request.method === 'GET' && request.url.pathname.includes('/values/')) return { data: { values: [['学籍番号', '名前'], ['', '合計'], ['fixture-existing', 'Fixture']] } };
    if (request.method === 'GET') return { data: { sheets: [{ properties: { title: '未払い履歴' } }] } };
    if (request.url.pathname.endsWith(':append')) return { data: { updates: { updatedRange: '未払い履歴!A4:J4' } } };
    return { data: {} };
  });
  const result = await sheetsService.writeMonthlyData([
    { studentId: 'fixture-existing', name: 'Fixture' }, { studentId: 'fixture-new', name: 'Fixture' },
  ], { 'fixture-new': '未払い' }, '2026/10');
  assert.equal(result.added, 1);
  const batches = requests.filter(r => r.url.pathname.endsWith('/values:batchUpdate'));
  assert.equal(batches.length, 2);
  assert.equal(batches[0].body.valueInputOption, 'USER_ENTERED');
  const append = requests.find(r => r.url.pathname.endsWith(':append'));
  assert.equal(append.body.values[0][0], 'fixture-new');
  assert.equal(append.url.searchParams.get('includeValuesInResponse'), 'false');
  assert.equal(batches[1].body.data[0].range, "'未払い履歴'!C4");
});

test('transport failures still reject and diagnostics mark connection unavailable', async t => {
  offlineGoogle(t, () => ({ status: 400, data: { error: { message: 'fixture-upstream-error' } } }));
  await assert.rejects(sheetsService.getActiveStudents());
  const result = await sheetsService.testConnection();
  assert.equal(result.studentSheet, false);
  assert.equal(result.outputSheet, false);
  assert.ok(result.errors.length > 0);
});
