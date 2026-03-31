# 記帳本 PWA

個人財務管理應用，支援離線使用（PWA），可部署至 GitHub Pages。

## 功能
- 📅 日曆式記帳（日/月/年三種視圖）
- 💳 常態支出（信用卡、帳單等固定項目管理）
- 💰 薪資收入記錄
- 📈 投資追蹤（利息、股利、股票交易）
- 📊 年度資產、IRR 計算
- 📤 匯出 CSV / 📥 匯入 CSV 備份
- 🔌 離線可用（Service Worker）

## 部署到 GitHub Pages

1. 在 GitHub 建立新 Repository（命名任意，例如 `kaiji`）
2. 將以下4個檔案上傳到 repository 根目錄：
   - `index.html`
   - `app.js`
   - `sw.js`
   - `manifest.json`
3. 到 Repository Settings → Pages → Source 選擇 `main` branch，`/ (root)`
4. 儲存後等約 1 分鐘，即可透過 `https://你的帳號.github.io/kaiji/` 訪問

## 手機安裝為 App

### Android（Chrome）
1. 瀏覽器開啟網址
2. 點右上角選單 → 「新增至主畫面」

### iOS（Safari）
1. Safari 開啟網址
2. 點分享圖示 → 「加入主畫面」

## 資料備份
- **匯出**：設定（⚙）→ 匯出 CSV → 上傳至 Google Sheets 備份
- **匯入**：設定（⚙）→ 匯入 CSV → 選擇備份檔案

## CSV 格式
```
type,date,amount,note,category
expense,2024-01-15,500,午餐,daily
income,2024-01-01,45000,薪資,regular_income
expense,2024-01-01,8000,聯邦信用卡,regular_expense
invest,2024-01-01,1200,interest,invest
```
