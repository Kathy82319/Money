import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// 1. 取得筆記列表 (按日期排序)
app.get('/', async (c) => {
    const { results } = await c.env.DB.prepare('SELECT * FROM notes ORDER BY date DESC, created_at DESC').all()
    return c.json(results)
})

// 2. 新增筆記
app.post('/', async (c) => {
    try {
        const { date, title, content, tag } = await c.req.json()
        const res = await c.env.DB.prepare(
            'INSERT INTO notes (date, title, content, tag) VALUES (?, ?, ?, ?) RETURNING id'
        ).bind(date, title || '無標題', content || '', tag || 'general').first()
        return c.json({ success: true, id: res.id })
    } catch(e: any) { return c.json({ error: e.message }, 500) }
})

// 3. 更新筆記
app.put('/:id', async (c) => {
    try {
        const id = c.req.param('id')
        const { date, title, content, tag } = await c.req.json()
        await c.env.DB.prepare(
            'UPDATE notes SET date=?, title=?, content=?, tag=? WHERE id=?'
        ).bind(date, title, content, tag, id).run()
        return c.json({ success: true })
    } catch(e: any) { return c.json({ error: e.message }, 500) }
})

// 4. 刪除筆記
app.delete('/:id', async (c) => {
    try {
        const id = c.req.param('id')
        await c.env.DB.prepare('DELETE FROM notes WHERE id=?').bind(id).run()
        return c.json({ success: true })
    } catch(e: any) { return c.json({ error: e.message }, 500) }
})

export default app