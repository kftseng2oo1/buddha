# 🪔 阿拉燈 · 佛法心靈導師

以佛法為依據的 AI 對話導師，可選擇傳承與上師風格，並記得過去的對話重點。

**線上使用**：https://kftseng2oo1.github.io/buddha/

## 主要功能
- 選擇傳承：通用佛法、南傳上座部、禪宗、淨土宗、藏傳佛教、聖嚴法師、星雲大師，或自訂上師
- 選擇語氣：溫柔慈悲、嚴謹莊重、詩意禪意、實用務實
- 快捷追問：📖 引用經典、🧘 修行方法、💬 說淺白些、🌱 日常應用、🔮 持續修持
- 每日法語、對話記憶（自動擷取重點、每日摘要），下次對話會參考
- 回答會附經典出處，並提醒以原典與真實師父為準

## 技術與依賴
- 單檔 HTML PWA（`index.html` 內含全部 HTML/CSS/JS），`manifest.json` + `sw.js` 提供安裝到主畫面與離線快取。
- AI：`claude-sonnet-4-20250514`，經 `twinklehub.kftseng2oo1.workers.dev` 的 `/claude` 代理；記憶也存在 Worker 端
- 本機設定：`buddha_cfg`、`buddha_uid`

## 相關 repo
- [dama](https://github.com/kftseng2oo1/dama)：法身實相實修
