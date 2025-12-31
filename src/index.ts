import { Hono } from 'hono'
type Bindings = {
  DB: D1Database
}
const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => {
  return c.text('Hello! 您的記帳系統後端已啟動！')
})

export default app