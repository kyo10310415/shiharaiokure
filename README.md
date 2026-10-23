# 未払い履歴管理システム

Googleスプレッドシートから生徒データと支払い状況を自動取得し、未払い履歴を月別に蓄積・管理するシステムです。

## 管理画面・APIのアクセス制御（SEC-004修正）

全画面・静的ファイル・業務APIは、管理者専用のHTTP Basic認証で保護します。Googleのサービスアカウント認証とは別の設定です。正規のHTTPS URLをブラウザで開き、認証ダイアログへ管理者資格情報を入力してください。共有端末に保存せず、終了時はブラウザを終了してください。個人別ユーザー・MFA・SSO統合は本修正の範囲外です。

必須の環境変数:

- `PAYMENT_ADMIN_USERNAME`: 管理者名（英数字、`_ . @ -`、100文字以内）。
- `PAYMENT_ADMIN_PASSWORD`: 安全にランダム生成した32文字以上のパスワード。空白は使わず、秘密設定に保存し、Git/画面/ログへ出さない。
- `PAYMENT_PUBLIC_ORIGIN`: ブラウザから開く正規のHTTPS origin（例: `https://payment.example.invalid`）。パス・クエリなし。ローカル開発のみ `http://localhost:3000` 等を許可。

未設定・短いパスワード・不正なoriginは、HTTP待受け/Google連携の初期化/cron開始前に起動を拒否します。秘密値の既定値はありません。

管理用POSTには `X-Payment-Request: 1` が必要です。Originがある場合は上記originと完全一致を要求します。画面の同期ボタンはこのヘッダーを自動送信します。管理者がCLIから呼ぶ場合もBasic認証とこのヘッダーが必要です。外部サイト向けCORS許可はありません。

- `GET /health` のみ認証なしで利用可。固定の稼働状態だけを返し、Googleへの接続はしません。ホストのヘルスチェックはこのパスを使います。
- `/api/debug-auth` は管理者限定で、認証設定の有無をbooleanで返すだけです。メールアドレス、鍵/JSONの断片、長さは返しません。
- `/api/status` やエラー応答には外部APIの生の例外を返しません。
- `/api/sync` は `yearMonth` だけを受け付け、2026/3以降の `YYYY/M` 形式を検査。指定省略時は従来どおり前月。
- `/api/create-spreadsheet` は廃止し、認証済みでも410を返します。ブラウザ/APIから出力先を作成・変更できません。既存の `OUTPUT_SPREADSHEET_ID` のみを使います。出力シートは所有者が準備しサービスアカウントへ共有してからホスト設定で指定してください。
- 内部cronはHTTPを経由せず従来どおり `syncData()` を呼びます。外部から管理APIを呼ぶ運用があれば認証とヘッダー付与が必要です。

本コード修正だけでホストの設定は変わりません。所有者が上記設定、HTTPS、正規出力先、ヘルスチェックを準備してから適用してください。本番設定変更・実データの同期は修正時には実行していません。

### 検証と既知の制約

`npm test` はExpressをメモリ内で呼び出す回帰テストです。HTTP待受け・Google・cron・実シートの読書きは行いません。匿名拒否、管理者認証、CSRF、出力先変更拒否、診断値の非出力、管理画面JSの構文を確認します。

既存のpackage.jsonとLockfileはExpressなど複数依存の版指定が不整合です。本修正では依存版やLockfileを更新していません。承認された依存保守で整合と実稼働版を確認してください。今回はLockfileのExpress 5.2.1と、manifestの4系列を満たすExpress 4.22.1の両方で回帰テストを実施しました。

DB/シート構造の変更はありません。ロールバック時は旧コードの匿名APIを再公開せず、公開停止か上流アクセス制御を先行してください。設定を戻す場合も漏洩済みの秘密値へは戻さず、出力シートIDは承認された既存値を保持してください。

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

1. 所有者がGoogle Drive上で出力用のGoogleスプレッドシートを準備
2. サービスアカウントへ必要な編集権限を付与
3. 承認された既存シートのIDをホストの `OUTPUT_SPREADSHEET_ID` に設定
4. 管理者として画面へログインし、必要な同期を実行（初回同期で既存処理がヘッダーを用意）

Web/APIから出力先の作成・差替えはできません。既存データがある場合はIDを保持してください。

## API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| GET | /health | 認証なし・固定の稼働状態のみ |
| GET | /api/status | システム状態確認 |
| POST | /api/sync | データ同期実行（bodyに `yearMonth` を指定可） |
| POST | /api/create-spreadsheet | 廃止（管理者認証後に410） |
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
