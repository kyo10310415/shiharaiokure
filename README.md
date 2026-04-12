# 未払い履歴管理システム

Googleスプレッドシートから生徒データと支払い状況を自動取得し、未払い履歴を月別に蓄積・管理するシステムです。

## 機能概要

- **自動データ取得**: 生徒データシートからアクティブ・レッスン準備中の生徒情報を取得
- **支払い状況照合**: 支払い状況シートの今月データを学籍番号で照合
- **月別蓄積**: 出力スプレッドシートに月ごとに列を追加してデータを蓄積
- **自動実行**: 毎月1日の朝9時（JST）に自動でデータ同期
- **手動実行**: Web UIから任意の月のデータを手動同期可能

## データ構造

### 入力スプレッドシート

| シート | 内容 |
|--------|------|
| 生徒データ (1nwaXDkbkUX1FWlqGO4...) | B列: 学籍番号, C列: 名前, D列: ステータス |
| RAW_支払い状況 (1iqrAhNjW8jTvobkur5...) | 13行目: ヘッダー(2026/4等), C列: 学籍番号, 14行目〜: データ |

### 出力スプレッドシート（未払い履歴）

| 列 | 内容 |
|----|------|
| A列 | 学籍番号 |
| B列 | 名前 |
| C列 | 2026/4 の支払い状況 |
| D列 | 2026/5 の支払い状況 |
| E列 | 2026/6 の支払い状況 |
| ... | 月ごとに追加 |

## セットアップ手順

### 1. Google Cloud でサービスアカウントを作成

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. 新規プロジェクト作成 or 既存プロジェクトを選択
3. 「IAMと管理」>「サービスアカウント」>「+サービスアカウントを作成」
4. Google Sheets API と Google Drive API を有効化
5. サービスアカウントに「編集者」権限を付与
6. キーを追加（JSON形式）してダウンロード

### 2. JSONキーをBase64エンコード

```bash
base64 -i service-account.json | tr -d '\n'
```

### 3. 各スプレッドシートをサービスアカウントに共有

各スプレッドシートを開き、「共有」からサービスアカウントのメールアドレスを「編集者」として追加

### 4. Render にデプロイ

1. このリポジトリを GitHub にプッシュ
2. [Render](https://render.com/) でアカウント作成
3. 「New Web Service」> GitHub リポジトリを選択
4. 環境変数を設定（後述）

### 5. 環境変数の設定

Render ダッシュボードの Environment から設定：

```
GOOGLE_SERVICE_ACCOUNT_JSON = (Base64エンコードされたJSONキー)
STUDENT_SPREADSHEET_ID = 1nwaXDkbkUX1FWlqGO4_Ph3_I9SkidXyx4KnviwlSeR8
PAYMENT_SPREADSHEET_ID = 1iqrAhNjW8jTvobkur5N_9r9uUWFHCKqrhxM72X5z-iM
OUTPUT_SPREADSHEET_ID = (出力スプレッドシートID - 次のステップで取得)
```

### 6. 出力スプレッドシートを作成

1. デプロイ後、Web UI の「⚙️ セットアップ」タブにアクセス
2. 「出力スプレッドシートを作成」ボタンをクリック
3. 表示された Spreadsheet ID を Render の環境変数 `OUTPUT_SPREADSHEET_ID` に設定
4. Render サービスを再デプロイ

## API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| GET | /api/status | システム状態確認 |
| POST | /api/sync | データ同期実行（bodyに `yearMonth` を指定可） |
| POST | /api/create-spreadsheet | 出力スプレッドシート新規作成 |
| GET | /api/data | 出力スプレッドシートのデータ取得 |
| GET | /api/students | アクティブ生徒一覧 |
| GET | /api/payment/:yearMonth | 指定月の支払いデータ取得 |

## 技術スタック

- **Runtime**: Node.js
- **Framework**: Express.js
- **API**: Google Sheets API v4, Google Drive API v3
- **認証**: Google Service Account
- **スケジューラ**: node-cron
- **デプロイ**: Render

## ローカル開発

```bash
# 依存関係インストール
npm install

# .envファイルを作成（.env.exampleを参考に）
cp .env.example .env
# .envを編集して認証情報を設定

# 起動
npm start
```
