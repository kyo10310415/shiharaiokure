/**
 * 未払い履歴管理システム - メインサーバー
 * Express.js + Google Sheets API
 */

require('dotenv').config();

const { createApp } = require('./app');
const { loadAccessConfig } = require('./access');
const access = loadAccessConfig(process.env);
const cron = require('node-cron');

const {
  getActiveStudents,
  getPaymentData,
  writeMonthlyData,
  getOutputSpreadsheetData,
  colIndexToLetter,
  getColumnIndexForMonth,
  testConnection,
} = require('./googleSheets');

const PORT = process.env.PORT || 3000;

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
 * 前月の年月を「YYYY/M」形式で取得
 */
function getPreviousYearMonth() {
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth(); // getMonth()は0始まりなので「前月」= getMonth()そのまま
  return `${year}/${month}`;
}

/**
 * メインのデータ同期処理
 * ※取得対象は「前月」のデータ
 */
async function syncData(yearMonth) {
  // 引数指定がなければ前月を使用
  const targetMonth = yearMonth || getPreviousYearMonth();
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
    console.error('同期に失敗しました。接続設定を確認してください。');
    throw error;
  }
}

const app = createApp(access, {
  getActiveStudents, getPaymentData, getOutputSpreadsheetData,
  colIndexToLetter, getColumnIndexForMonth, testConnection,
  getCurrentYearMonth, getPreviousYearMonth, syncData,
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
    console.error('定期同期に失敗しました。接続設定を確認してください。');
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
