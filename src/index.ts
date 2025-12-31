import { Hono } from 'hono'

// 定義環境變數結構 (告訴程式碼 DB 是什麼)
type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// 1. 首頁測試
app.get('/', (c) => {
  return c.text('成功！後端系統已連線 (Pages + D1)')
})

// 2. 資料庫測試：列出所有分類
app.get('/api/categories', async (c) => {
  try {
    // 執行 SQL: 查詢 categories 表格
    const { results } = await c.env.DB.prepare('SELECT * FROM categories').all()
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: '讀取失敗', message: e.message }, 500)
  }
})

export default app 