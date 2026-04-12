/**
 * Google Sheets API 操作モジュール
 * サービスアカウント認証を使用してスプレッドシートにアクセス
 */

const { google } = require('googleapis');

/**
 * Google Sheets API クライアントを初期化する
 *
 * 認証情報の優先順位:
 * 1. GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY （推奨: Renderで最も確実）
 * 2. GOOGLE_SERVICE_ACCOUNT_JSON （Base64 or 生JSON）
 */
function getAuthClient() {
  let credentials;

  // --- 方式1: メールアドレスと秘密鍵を個別に設定（推奨） ---
  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    // 前後の余分な " や ' を除去
    let privateKey = process.env.GOOGLE_PRIVATE_KEY.trim().replace(/^["']|["']$/g, '');
    // \\n → 実際の改行に変換
    privateKey = privateKey.replace(/\\n/g, '\n');

    credentials = {
      client_email: process.env.GOOGLE_CLIENT_EMAIL.trim(),
      private_key: privateKey,
    };

  // --- 方式2: JSONをそのまま環境変数に設定 ---
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();

    // まずそのままJSONとして試みる（Renderで一番多いパターン）
    try {
      credentials = JSON.parse(raw);
    } catch (_e1) {
      // 失敗したらBase64としてデコードして試みる
      try {
        const decoded = Buffer.from(raw, 'base64').toString('utf-8');
        credentials = JSON.parse(decoded);
      } catch (_e2) {
        throw new Error(
          'GOOGLE_SERVICE_ACCOUNT_JSON の解析に失敗しました。\n' +
          '【推奨】GOOGLE_CLIENT_EMAIL と GOOGLE_PRIVATE_KEY を個別に設定してください。'
        );
      }
    }

    // private_key の \n を正規化
    if (credentials && credentials.private_key) {
      credentials.private_key = credentials.private_key.includes('\\n')
        ? credentials.private_key.replace(/\\n/g, '\n')
        : credentials.private_key;
    }

  } else {
    throw new Error(
      'Google認証情報が設定されていません。\n' +
      'GOOGLE_CLIENT_EMAIL と GOOGLE_PRIVATE_KEY を設定してください。'
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  return auth;
}

/**
 * Sheets API インスタンスを取得
 */
async function getSheetsClient() {
  const auth = getAuthClient();
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

/**
 * Drive API インスタンスを取得
 */
async function getDriveClient() {
  const auth = getAuthClient();
  const authClient = await auth.getClient();
  return google.drive({ version: 'v3', auth: authClient });
}

/**
 * 生徒データスプレッドシートからアクティブ・レッスン準備中の生徒を取得
 */
async function getActiveStudents() {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.STUDENT_SPREADSHEET_ID;
  
  if (!spreadsheetId) {
    throw new Error('STUDENT_SPREADSHEET_ID が設定されていません');
  }

  // 生徒データシートのB列(学籍番号)、C列(名前)、D列(ステータス)を取得
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: '生徒データ!B:D',
  });

  const rows = response.data.values || [];
  
  // ヘッダー行をスキップし、アクティブまたはレッスン準備中のみフィルタリング
  const activeStudents = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;
    
    const studentId = (row[0] || '').trim();
    const name = (row[1] || '').trim();
    const status = (row[2] || '').trim();
    
    if (!studentId) continue;
    
    if (status === 'アクティブ' || status === 'レッスン準備中') {
      activeStudents.push({
        studentId,
        name,
        status,
      });
    }
  }
  
  console.log(`✅ アクティブ/レッスン準備中の生徒: ${activeStudents.length}名`);
  return activeStudents;
}

/**
 * 支払い状況スプレッドシートから今月のデータを取得
 * ヘッダーが13行目、データが14行目から
 */
async function getPaymentData(targetYearMonth) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.PAYMENT_SPREADSHEET_ID;
  
  if (!spreadsheetId) {
    throw new Error('PAYMENT_SPREADSHEET_ID が設定されていません');
  }

  // RAW_支払い状況シートの全データを取得（13行目のヘッダーを含む）
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'RAW_支払い状況!A:ZZ',
  });

  const rows = response.data.values || [];
  
  if (rows.length < 13) {
    throw new Error('支払い状況シートのデータが不足しています');
  }

  // 13行目（index: 12）がヘッダー行
  const headerRow = rows[12];
  console.log('ヘッダー行:', JSON.stringify(headerRow));
  
  // 対象年月の列インデックスを探す
  // ヘッダーは「2026/4」「2026/5」などの形式
  let targetColIndex = -1;
  
  for (let i = 0; i < headerRow.length; i++) {
    const header = (headerRow[i] || '').trim();
    
    // 「2026/4」「2026/04」などのパターンを確認
    if (header === targetYearMonth) {
      targetColIndex = i;
      break;
    }
    
    // Date形式で比較（「2026/4/1 0:00:00」などのシリアル値変換後）
    // Googleスプレッドシートでは「2026/04/01 0:00:00」形式になることがある
    const headerDateMatch = header.match(/^(\d{4})\/(\d{1,2})/);
    const [targetYear, targetMonth] = targetYearMonth.split('/').map(Number);
    
    if (headerDateMatch) {
      const headerYear = parseInt(headerDateMatch[1]);
      const headerMonth = parseInt(headerDateMatch[2]);
      
      if (headerYear === targetYear && headerMonth === targetMonth) {
        targetColIndex = i;
        break;
      }
    }
  }
  
  if (targetColIndex === -1) {
    console.log(`⚠️ 対象年月 "${targetYearMonth}" の列が見つかりません`);
    console.log('利用可能なヘッダー:', headerRow.slice(0, 20));
    return {};
  }
  
  console.log(`✅ "${targetYearMonth}" の列: ${targetColIndex}番目`);
  
  // C列（index: 2）が学籍番号
  const paymentMap = {};
  
  // 14行目（index: 13）からデータを取得
  for (let i = 13; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 3) continue;
    
    const studentId = (row[2] || '').trim(); // C列
    if (!studentId) continue;
    
    const paymentStatus = targetColIndex < row.length 
      ? (row[targetColIndex] || '').trim() 
      : '';
    
    paymentMap[studentId] = paymentStatus;
  }
  
  console.log(`✅ 支払いデータ取得: ${Object.keys(paymentMap).length}件`);
  return paymentMap;
}

/**
 * 出力スプレッドシートを作成する
 */
async function createOutputSpreadsheet() {
  const drive = await getDriveClient();
  const sheets = await getSheetsClient();
  
  // 新規スプレッドシート作成
  const createResponse = await drive.files.create({
    requestBody: {
      name: '未払い履歴',
      mimeType: 'application/vnd.google-apps.spreadsheet',
    },
    fields: 'id, webViewLink',
  });
  
  const spreadsheetId = createResponse.data.id;
  const spreadsheetUrl = createResponse.data.webViewLink;
  
  console.log(`✅ 新規スプレッドシート作成: ${spreadsheetUrl}`);
  
  // シート名を「未払い履歴」に変更
  const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetId = spreadsheetInfo.data.sheets[0].properties.sheetId;
  
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: {
            sheetId,
            title: '未払い履歴',
          },
          fields: 'title',
        },
      }],
    },
  });
  
  console.log(`✅ シート名を「未払い履歴」に変更`);
  
  return { spreadsheetId, spreadsheetUrl };
}

/**
 * 出力スプレッドシートの実際のシート名を取得する共通関数
 */
async function getOutputSheetName(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetNames = meta.data.sheets.map(s => s.properties.title);
  console.log('📋 シート一覧:', sheetNames);

  // 「未払い履歴」を探す（スペース・全角差異も考慮）
  const found = sheetNames.find(name =>
    name.trim().replace(/[\s　]/g, '') === '未払い履歴'
  );
  const sheetName = found || sheetNames[0];
  console.log('📋 使用シート名:', JSON.stringify(sheetName));
  return sheetName;
}

/**
 * 出力スプレッドシートの現在の状態を取得
 * A列: 学籍番号, B列: 名前, C列: 未払い遅れ回数, D列以降: 月別支払い状況
 */
async function getOutputSpreadsheetData() {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.OUTPUT_SPREADSHEET_ID;

  if (!spreadsheetId) {
    throw new Error('OUTPUT_SPREADSHEET_ID が設定されていません');
  }

  const sheetName = await getOutputSheetName(sheets, spreadsheetId);

  // シート名をシングルクォートで囲んで安全に指定
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A1:Z3000`,
  });

  return response.data.values || [];
}

/**
 * 年月文字列から列インデックスを計算する
 * A列(0): 学籍番号, B列(1): 名前, C列(2): 未払い遅れ回数
 * D列(3)以降: 月別支払い状況
 * 2026/4 → D列(index 3), 2026/5 → E列(index 4), ...
 * 基準: 2026/4 = D列(index 3)
 */
function getColumnIndexForMonth(yearMonth) {
  const [year, month] = yearMonth.split('/').map(Number);

  // 基準: 2026年4月 = D列 (index 3)
  const BASE_YEAR = 2026;
  const BASE_MONTH = 4;
  const BASE_COL_INDEX = 3;

  const monthsDiff = (year - BASE_YEAR) * 12 + (month - BASE_MONTH);
  return BASE_COL_INDEX + monthsDiff;
}

/**
 * 列インデックスをアルファベット表記に変換（A, B, C, ..., Z, AA, AB, ...）
 */
function colIndexToLetter(index) {
  let letter = '';
  let n = index + 1; // 1-basedに変換
  
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    n = Math.floor((n - 1) / 26);
  }
  
  return letter;
}

/**
 * 出力スプレッドシートに今月のデータを書き込む
 */
async function writeMonthlyData(students, paymentMap, targetYearMonth) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.OUTPUT_SPREADSHEET_ID;

  if (!spreadsheetId) {
    throw new Error('OUTPUT_SPREADSHEET_ID が設定されていません');
  }

  // 実際のシート名を取得
  const sn = await getOutputSheetName(sheets, spreadsheetId);

  // 現在のスプレッドシートデータを取得
  const currentData = await getOutputSpreadsheetData();

  // 現在の行データをマップ化（学籍番号 → 行番号 1-based）
  const studentRowMap = {};
  const headerRow = currentData[0] || [];

  for (let i = 1; i < currentData.length; i++) {
    const row = currentData[i];
    if (row && row[0]) {
      studentRowMap[row[0].trim()] = i + 1;
    }
  }

  // 対象月の列インデックスを取得
  const targetColIndex = getColumnIndexForMonth(targetYearMonth);
  const targetColLetter = colIndexToLetter(targetColIndex);

  console.log(`✅ 対象列: ${targetColLetter} (index: ${targetColIndex})`);

  // バッチ更新用データを準備
  const updateRequests = [];
  const newRows = [];

  // ヘッダー行に月ヘッダーが存在するか確認・追加
  if (!headerRow[targetColIndex] || headerRow[targetColIndex].trim() !== targetYearMonth) {
    updateRequests.push({
      range: `'${sn}'!${targetColLetter}1`,
      values: [[targetYearMonth]],
    });
  }

  // ヘッダー行 A1:C1 がなければ追加
  if (!headerRow[0] || headerRow[0].trim() !== '学籍番号') {
    updateRequests.push({
      range: `'${sn}'!A1:C1`,
      values: [['学籍番号', '名前', '未払い遅れ回数']],
    });
  }

  // 生徒ごとにデータを設定
  for (const student of students) {
    const { studentId, name } = student;
    const paymentStatus = paymentMap[studentId] || '';

    if (studentRowMap[studentId]) {
      const rowNum = studentRowMap[studentId];

      // A列・B列を更新
      updateRequests.push({
        range: `'${sn}'!A${rowNum}:B${rowNum}`,
        values: [[studentId, name]],
      });

      // C列: COUNTIF数式（D列以降の「未払い」を含むセル数）
      updateRequests.push({
        range: `'${sn}'!C${rowNum}`,
        values: [[`=COUNTIF(D${rowNum}:${rowNum},"*未払い*")`]],
      });

      // 対象月の列を更新
      updateRequests.push({
        range: `'${sn}'!${targetColLetter}${rowNum}`,
        values: [[paymentStatus]],
      });
    } else {
      newRows.push({ studentId, name, paymentStatus });
    }
  }

  // 既存行を更新
  if (updateRequests.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updateRequests,
      },
    });
    console.log(`✅ 既存データ更新: ${updateRequests.length}件`);
  }

  // 新規行を追加
  if (newRows.length > 0) {
    const appendData = newRows.map((row) => {
      const rowData = new Array(targetColIndex + 1).fill('');
      rowData[0] = row.studentId;
      rowData[1] = row.name;
      rowData[2] = ''; // C列: append後にCOUNTIF数式を設定
      rowData[targetColIndex] = row.paymentStatus;
      return rowData;
    });

    // append で行を追加（行番号が確定する）
    const appendResponse = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sn}'!A:A`,
      valueInputOption: 'USER_ENTERED',
      includeValuesInResponse: false,
      requestBody: { values: appendData },
    });

    // append後の実際の開始行番号を取得
    const updatedRange = appendResponse.data.updates?.updatedRange || '';
    const rowMatch = updatedRange.match(/(\d+):/);
    const startRow = rowMatch ? parseInt(rowMatch[1]) : (currentData.length + 1);

    // 新規行のC列にCOUNTIF数式を設定
    const formulaRequests = newRows.map((_, i) => {
      const rowNum = startRow + i;
      return {
        range: `'${sn}'!C${rowNum}`,
        values: [[`=COUNTIF(D${rowNum}:${rowNum},"*未払い*")`]],
      };
    });

    if (formulaRequests.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: formulaRequests,
        },
      });
    }

    console.log(`✅ 新規行追加: ${newRows.length}件`);
  }
  
  return {
    updated: updateRequests.length,
    added: newRows.length,
    targetMonth: targetYearMonth,
    targetColumn: targetColLetter,
  };
}

/**
 * 出力スプレッドシートを初期化（ヘッダー行を設定）
 */
async function initOutputSpreadsheet() {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.OUTPUT_SPREADSHEET_ID;

  if (!spreadsheetId) {
    throw new Error('OUTPUT_SPREADSHEET_ID が設定されていません');
  }

  const sn = await getOutputSheetName(sheets, spreadsheetId);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sn}'!A1:C1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [['学籍番号', '名前', '未払い遅れ回数']],
    },
  });

  console.log('✅ ヘッダー行を初期化しました');
}

/**
 * スプレッドシートのデータ読み取り権限を確認するためのテスト
 * ※認証情報未設定・接続失敗時でも必ず結果オブジェクトを返す（例外を投げない）
 */
async function testConnection() {
  const results = {
    studentSheet: false,
    paymentSheet: false,
    outputSheet: false,
    authConfigured: false,
    errors: [],
  };

  // 認証情報が設定されているか先にチェック
  const hasAuth = !!(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY)
  );

  if (!hasAuth) {
    results.errors.push('Google認証情報が未設定です（GOOGLE_SERVICE_ACCOUNT_JSON を設定してください）');
    return results;
  }

  results.authConfigured = true;

  // Sheetsクライアントを一度だけ取得（失敗したら全シート失敗）
  let sheets;
  try {
    sheets = await getSheetsClient();
  } catch (e) {
    results.errors.push(`認証エラー: ${e.message}`);
    return results;
  }

  // 生徒データシートの接続テスト
  try {
    const studentId = process.env.STUDENT_SPREADSHEET_ID;
    if (!studentId) {
      results.errors.push('STUDENT_SPREADSHEET_ID が未設定です');
    } else {
      await sheets.spreadsheets.values.get({
        spreadsheetId: studentId,
        range: '生徒データ!A1',
      });
      results.studentSheet = true;
    }
  } catch (e) {
    results.errors.push(`生徒データシートエラー: ${e.message}`);
  }

  // 支払い状況シートの接続テスト
  try {
    const paymentId = process.env.PAYMENT_SPREADSHEET_ID;
    if (!paymentId) {
      results.errors.push('PAYMENT_SPREADSHEET_ID が未設定です');
    } else {
      await sheets.spreadsheets.values.get({
        spreadsheetId: paymentId,
        range: 'RAW_支払い状況!A13',
      });
      results.paymentSheet = true;
    }
  } catch (e) {
    results.errors.push(`支払い状況シートエラー: ${e.message}`);
  }

  // 出力シートの接続テスト
  try {
    const outputId = process.env.OUTPUT_SPREADSHEET_ID;
    if (!outputId) {
      // 未設定はエラーではなく「未設定」として扱う
    } else {
      const outSheetName = await getOutputSheetName(sheets, outputId);
      await sheets.spreadsheets.values.get({
        spreadsheetId: outputId,
        range: `'${outSheetName}'!A1`,
      });
      results.outputSheet = true;
    }
  } catch (e) {
    results.errors.push(`出力シートエラー: ${e.message}`);
  }

  return results;
}

module.exports = {
  getActiveStudents,
  getPaymentData,
  createOutputSpreadsheet,
  writeMonthlyData,
  initOutputSpreadsheet,
  getOutputSpreadsheetData,
  getColumnIndexForMonth,
  colIndexToLetter,
  testConnection,
};
