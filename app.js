const express = require('express');
const path = require('node:path');
const { requireAdmin } = require('./access');

function validYearMonth(value) {
  return typeof value === 'string' && /^\d{4}\/(?:[1-9]|1[0-2])$/.test(value) &&
    Number(value.split('/')[0]) * 12 + Number(value.split('/')[1]) >= 2026 * 12 + 3;
}

function createApp(access, services, env = process.env) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(requireAdmin(access));
  // Authenticate before body parsing and before serving any administration files.
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/debug-auth', (_req, res) => res.json({
    individual: { emailConfigured: !!env.GOOGLE_CLIENT_EMAIL, privateKeyConfigured: !!env.GOOGLE_PRIVATE_KEY },
    jsonConfigured: !!env.GOOGLE_SERVICE_ACCOUNT_JSON,
  }));

  app.get('/api/status', async (_req, res, next) => {
    try {
      const connection = await services.testConnection();
      res.json({ status: 'running', currentMonth: services.getCurrentYearMonth(), previousMonth: services.getPreviousYearMonth(),
        spreadsheets: {
          student: env.STUDENT_SPREADSHEET_ID ? '設定済み' : '未設定',
          payment: env.PAYMENT_SPREADSHEET_ID ? '設定済み' : '未設定',
          output: env.OUTPUT_SPREADSHEET_ID ? '設定済み' : '未設定',
        },
        connection: {
          authConfigured: !!connection.authConfigured, studentSheet: !!connection.studentSheet,
          paymentSheet: !!connection.paymentSheet, outputSheet: !!connection.outputSheet,
          errors: connection.errors?.length ? ['接続設定または権限を管理者が確認してください。'] : [],
        }, timestamp: new Date().toISOString(),
      });
    } catch (error) { next(error); }
  });

  app.post('/api/sync', async (req, res, next) => {
    const body = req.body || {};
    if (Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some((key) => key !== 'yearMonth') ||
        (body.yearMonth !== undefined && body.yearMonth !== '' && !validYearMonth(body.yearMonth))) {
      return res.status(400).json({ success: false, error: 'yearMonthのみ指定できます（2026/3以降、YYYY/M形式）。' });
    }
    try { res.json(await services.syncData(body.yearMonth || undefined)); }
    catch (error) { next(error); }
  });

  app.post('/api/create-spreadsheet', (_req, res) => res.status(410).json({
    success: false, error: '出力先の作成・変更は管理者が環境設定で行ってください。',
  }));

  app.get('/api/data', async (_req, res, next) => {
    try {
      const data = await services.getOutputSpreadsheetData();
      res.json({ headers: data[0] || [], rows: data.slice(1), totalStudents: Math.max(0, data.length - 1) });
    } catch (error) { next(error); }
  });
  app.get('/api/students', async (_req, res, next) => {
    try {
      const students = await services.getActiveStudents();
      res.json({ students, count: students.length });
    } catch (error) { next(error); }
  });
  app.get('/api/payment/:yearMonth', async (req, res, next) => {
    const yearMonth = req.params.yearMonth;
    if (!validYearMonth(yearMonth)) return res.status(400).json({ error: '年月が不正です。' });
    try {
      const data = await services.getPaymentData(yearMonth);
      res.json({ yearMonth, data, count: Object.keys(data).length });
    } catch (error) { next(error); }
  });
  app.get('/api/column-info/:yearMonth', (req, res, next) => {
    const yearMonth = req.params.yearMonth;
    if (!validYearMonth(yearMonth)) return res.status(400).json({ error: '年月が不正です。' });
    try {
      const columnIndex = services.getColumnIndexForMonth(yearMonth);
      res.json({ yearMonth, columnIndex, columnLetter: services.colIndexToLetter(columnIndex) });
    } catch (error) { next(error); }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use((error, _req, res, _next) => {
    const status = error.status === 400 || error.status === 413 ? error.status : 500;
    res.status(status).json({ success: false, error: '処理に失敗しました。入力・接続設定を管理者が確認してください。' });
  });
  return app;
}

module.exports = { createApp };
