/**
 * 未払い履歴管理システム - メインサーバー
 * Express.js + Google Sheets API
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const {
  getActiveStudents,
  getPaymentData,
  createOutputSpreadsheet,
  writeMonthlyData,
  initOutputSpreadsheet,
  getOutputSpreadsheetData,
  colIndexToLetter,
  getColumnIndexForMonth,
  testConnection,
} = require('./googleSheets');

const app = express();
const PORT = process.env.PORT || 3000;

// ミドルウェア設定
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =============================
// ヘルパー関数
// =============================

/**
 * 現在の年月を「YYYY/M」形式で取得
 */
function getCurrentYearMonth() {
  const now = new Date();
  return `${now.getFullYear()}/${now.getMonth() + 1}`;
}

/**
 * メインのデータ同期処理
 */
async function syncData(yearMonth) {
  const targetMonth = yearMonth || getCurrentYearMonth();
  console.log(`\n========== データ同期開始: ${targetMonth} ==========`);
  
  try {
    // 1. アクティブ生徒を取得
    console.log('1. 生徒データを取得中...');
    const students = await getActiveStudents();
    
    // 2. 支払い状況を取得
    console.log('2. 支払い状況を取得中...');
    const paymentMap = await getPaymentData(targetMonth);
    
    // 3. 出力スプレッドシートに書き込み
    console.log('3. データを書き込み中...');
    const result = await writeMonthlyData(students, paymentMap, targetMonth);
    
    console.log(`========== 同期完了 ==========`);
    console.log(`更新: ${result.updated}件, 追加: ${result.added}件`);
    console.log(`対象月: ${result.targetMonth} (${result.targetColumn}列)`);
    
    return {
      success: true,
      ...result,
      studentsCount: students.length,
    };
  } catch (error) {
    console.error('同期エラー:', error.message);
    throw error;
  }
}

// =============================
// APIエンドポイント
// =============================

/**
 * GET /api/status
 * サーバー状態確認 & 接続テスト
 */
app.get('/api/status', async (req, res) => {
  try {
    const connectionTest = await testConnection();
    const currentMonth = getCurrentYearMonth();
    
    res.json({
      status: 'running',
      currentMonth,
      spreadsheets: {
        student: process.env.STUDENT_SPREADSHEET_ID ? '設定済み' : '未設定',
        payment: process.env.PAYMENT_SPREADSHEET_ID ? '設定済み' : '未設定',
        output: process.env.OUTPUT_SPREADSHEET_ID ? '設定済み' : '未設定',
      },
      connection: connectionTest,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/sync
 * 手動でデータ同期を実行
 * Body: { yearMonth: "2026/4" } (省略時は今月)
 */
app.post('/api/sync', async (req, res) => {
  try {
    const { yearMonth } = req.body || {};
    const result = await syncData(yearMonth);
    res.json(result);
  } catch (error) {
    console.error('同期エラー:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/create-spreadsheet
 * 出力用スプレッドシートを新規作成
 */
app.post('/api/create-spreadsheet', async (req, res) => {
  try {
    const { spreadsheetId, spreadsheetUrl } = await createOutputSpreadsheet();
    
    // 初期化
    process.env.OUTPUT_SPREADSHEET_ID = spreadsheetId;
    await initOutputSpreadsheet();
    
    res.json({
      success: true,
      spreadsheetId,
      spreadsheetUrl,
      message: '新規スプレッドシートを作成しました。OUTPUT_SPREADSHEET_IDをこのIDに設定してください。',
    });
  } catch (error) {
    console.error('スプレッドシート作成エラー:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/data
 * 出力スプレッドシートの現在のデータを取得
 */
app.get('/api/data', async (req, res) => {
  try {
    const rawData = await getOutputSpreadsheetData();
    
    if (rawData.length === 0) {
      return res.json({ headers: [], rows: [] });
    }
    
    const headers = rawData[0] || [];
    const rows = rawData.slice(1);
    
    res.json({
      headers,
      rows,
      totalStudents: rows.length,
    });
  } catch (error) {
    console.error('データ取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/students
 * アクティブ生徒一覧を取得
 */
app.get('/api/students', async (req, res) => {
  try {
    const students = await getActiveStudents();
    res.json({ students, count: students.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/payment/:yearMonth
 * 特定月の支払いデータを取得
 * 例: GET /api/payment/2026%2F4
 */
app.get('/api/payment/:yearMonth', async (req, res) => {
  try {
    const yearMonth = decodeURIComponent(req.params.yearMonth);
    const paymentMap = await getPaymentData(yearMonth);
    res.json({ yearMonth, data: paymentMap, count: Object.keys(paymentMap).length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/column-info/:yearMonth
 * 特定月の列情報を取得
 */
app.get('/api/column-info/:yearMonth', async (req, res) => {
  try {
    const yearMonth = decodeURIComponent(req.params.yearMonth);
    const colIndex = getColumnIndexForMonth(yearMonth);
    const colLetter = colIndexToLetter(colIndex);
    
    res.json({
      yearMonth,
      columnIndex: colIndex,
      columnLetter: colLetter,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /
 * フロントエンド（管理画面）
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =============================
// 自動スケジュール (毎月3日 22時 JST)
// =============================
cron.schedule('0 22 3 * *', async () => {
  console.log('\n⏰ 定期実行: 月次データ同期');
  try {
    await syncData();
    console.log('✅ 定期実行完了');
  } catch (error) {
    console.error('❌ 定期実行エラー:', error.message);
  }
}, {
  timezone: 'Asia/Tokyo',
});

// =============================
// サーバー起動
// =============================
app.listen(PORT, () => {
  console.log(`\n🚀 未払い履歴管理システム`);
  console.log(`   ポート: ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n📋 環境変数の状態:`);
  console.log(`   GOOGLE_SERVICE_ACCOUNT_JSON: ${process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? '✅ 設定済み' : '❌ 未設定'}`);
  console.log(`   STUDENT_SPREADSHEET_ID: ${process.env.STUDENT_SPREADSHEET_ID ? '✅ 設定済み' : '❌ 未設定'}`);
  console.log(`   PAYMENT_SPREADSHEET_ID: ${process.env.PAYMENT_SPREADSHEET_ID ? '✅ 設定済み' : '❌ 未設定'}`);
  console.log(`   OUTPUT_SPREADSHEET_ID: ${process.env.OUTPUT_SPREADSHEET_ID ? '✅ 設定済み' : '❌ 未設定'}`);
  console.log(`\n⏰ 自動実行スケジュール: 毎月3日 22:00 JST`);
});

module.exports = app;
