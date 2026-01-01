import { Hono } from 'hono'
import notes from './notes' // 假設您的 notes.ts 還在，若上次是一併寫在 index 則需調整，這裡假設您有保留 notes.ts

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// ==========================================
// [BACKEND] API 路由掛載
// ==========================================
app.route('/api/notes', notes)

// ==========================================
// [BACKEND] API 區域 (記帳相關)
// ==========================================

// 1. 分類 API
app.get('/api/categories', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM categories ORDER BY type, id').all()
  return c.json(results)
})

app.post('/api/categories', async (c) => {
    try {
        const { name, type } = await c.req.json()
        if(!name || !type) return c.json({error: '缺少欄位'}, 400)
        const maxId = await c.env.DB.prepare('SELECT MAX(id) as maxId FROM categories').first('maxId') as number
        const newId = (maxId || 0) + 1
        await c.env.DB.prepare('INSERT INTO categories (id, name, type) VALUES (?, ?, ?)').bind(newId, name, type).run()
        return c.json({success: true})
    } catch(e: any) { return c.json({error: e.message}, 500) }
})

app.delete('/api/categories/:id', async (c) => {
    try {
        await c.env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(c.req.param('id')).run()
        return c.json({success: true})
    } catch(e: any) { return c.json({error: e.message}, 500) }
})

// 2. 帳戶 API
app.get('/api/accounts', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM accounts ORDER BY type, id').all()
  return c.json(results)
})

// 3. 交易 API
app.get('/api/transactions', async (c) => {
  const accountId = c.req.query('account_id')
  const limit = c.req.query('limit') || '50'
  
  let sql = `
      SELECT t.*, c.name as category_name, c.type as category_type
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.parent_id IS NULL 
  `
  const params: any[] = []

  if (accountId) {
      sql += ` AND t.account_id = ? `
      params.push(accountId)
  }

  sql += ` ORDER BY t.date DESC, t.created_at DESC LIMIT ? `
  params.push(limit)

  const { results: parents } = await c.env.DB.prepare(sql).bind(...params).all()

  const transactionsWithChildren = await Promise.all(parents.map(async (p: any) => {
      const { results: children } = await c.env.DB.prepare(`
          SELECT t.*, c.name as category_name 
          FROM transactions t
          LEFT JOIN categories c ON t.category_id = c.id
          WHERE t.parent_id = ?
          ORDER BY t.id
      `).bind(p.id).all()
      return { ...p, children: children || [] }
  }))
  return c.json(transactionsWithChildren)
})

// 4. 統計 API
app.get('/api/stats', async (c) => {
    const start = c.req.query('start')
    const end = c.req.query('end')
    const accountIds = c.req.query('account_ids')
    
    let filters = ''
    const params: any[] = []

    if (start) { filters += ` AND t.date >= ? `; params.push(start) }
    if (end) { filters += ` AND t.date <= ? `; params.push(end) }

    if (accountIds) {
        const ids = accountIds.split(',').map(n => parseInt(n)).filter(n => !isNaN(n))
        if (ids.length > 0) {
            filters += ` AND t.account_id IN (${ids.join(',')}) `
        }
    }
    
    const excludeFilter = ` AND c.name NOT IN ('借入/負債', '帳戶間移轉') AND c.type != 'TRANSFER' `

    const { results: totals } = await c.env.DB.prepare(`
        SELECT t.type, SUM(t.amount_twd) as total 
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.parent_id IS NULL ${excludeFilter} ${filters}
        GROUP BY t.type
    `).bind(...params).all()

    const { results: monthly } = await c.env.DB.prepare(`
        SELECT strftime('%Y-%m', t.date) as month, t.type, SUM(t.amount_twd) as total 
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.parent_id IS NULL ${excludeFilter} ${filters}
        GROUP BY month, t.type
        ORDER BY month
    `).bind(...params).all()

    const { results: categories } = await c.env.DB.prepare(`
        SELECT c.name, t.type, SUM(t.amount_twd) as total
        FROM transactions t
        JOIN categories c ON t.category_id = c.id
        WHERE 1=1 ${excludeFilter} ${filters}
        GROUP BY c.name, t.type
        ORDER BY total DESC
    `).bind(...params).all()

    const { results: rawNotes } = await c.env.DB.prepare(`
        SELECT t.note, t.amount_twd
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.note IS NOT NULL AND t.note != '' ${excludeFilter} ${filters}
    `).bind(...params).all()

    const keywordMap = new Map<string, number>()
    rawNotes.forEach((row: any) => {
        let key = row.note.replace(/[\[\]]/g, '').trim()
        if (!key || /^\d+$/.test(key)) return
        keywordMap.set(key, (keywordMap.get(key) || 0) + (row.amount_twd || 0))
    })

    const keywords = Array.from(keywordMap.entries())
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 15)

    return c.json({ totals, monthly, categories, keywords })
})

app.delete('/api/transactions/:id', async (c) => {
    try {
        await c.env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(c.req.param('id')).run()
        return c.json({ success: true })
    } catch (e: any) { return c.json({ error: e.message }, 500) }
})

app.put('/api/transactions/:id', async (c) => {
    try {
        const id = c.req.param('id')
        const body = await c.req.json()
        const main = body.main || body
        const children = body.children || []

        if (!main.date || !main.account_id || main.amount_twd === undefined) return c.json({ error: '缺少欄位' }, 400)

        await c.env.DB.prepare(`
            UPDATE transactions 
            SET date=?, account_id=?, category_id=?, type=?, amount_twd=?, note=?
            WHERE id=?
        `).bind(main.date, main.account_id, main.category_id, main.type, main.amount_twd, main.note, id).run()

        await c.env.DB.prepare('DELETE FROM transactions WHERE parent_id = ?').bind(id).run()

        if (children.length > 0) {
            const stmt = c.env.DB.prepare(`INSERT INTO transactions (date, account_id, category_id, type, amount_twd, note, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            const batch = children.map((child: any) => stmt.bind(main.date, main.account_id, child.category_id, main.type, child.amount_twd, child.note, id))
            await c.env.DB.batch(batch)
        }

        return c.json({ success: true })
    } catch (e: any) { return c.json({ error: e.message }, 500) }
})

app.post('/api/transactions', async (c) => {
  try {
    const body = await c.req.json()
    const main = body.main || body
    const children = body.children || []

    if (!main.date || !main.account_id || main.amount_twd === undefined) return c.json({ error: '缺少欄位' }, 400)

    const result = await c.env.DB.prepare(`
      INSERT INTO transactions (date, account_id, category_id, type, amount_twd, amount_foreign, exchange_rate, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).bind(main.date, main.account_id, main.category_id, main.type, main.amount_twd, main.amount_foreign||null, main.exchange_rate||1, main.note).first()

    if (children.length > 0 && result.id) {
        const stmt = c.env.DB.prepare(`INSERT INTO transactions (date, account_id, category_id, type, amount_twd, note, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        const batch = children.map((child: any) => stmt.bind(main.date, main.account_id, child.category_id, main.type, child.amount_twd, child.note, result.id))
        await c.env.DB.batch(batch)
    }
    return c.json({ success: true })
  } catch (e: any) { return c.json({ error: e.message }, 500) }
})

// ==========================================
// [FRONTEND]
// ==========================================

app.get('/', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="zh-TW">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>資產管家</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap');
        body { font-family: 'Noto Sans TC', sans-serif; }
        .scroller::-webkit-scrollbar { width: 6px; }
        .scroller::-webkit-scrollbar-track { background: transparent; }
        .scroller::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        .fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
        .fade-enter-from, .fade-leave-to { opacity: 0; }
        .modal-enter-active, .modal-leave-active { transition: all 0.2s ease; }
        .modal-enter-from, .modal-leave-to { opacity: 0; transform: scale(0.95); }
        
        /* 筆記本專用樣式 */
        .note-active { border-left: 4px solid #0f172a; background-color: #f1f5f9; }
        textarea:focus { outline: none; }
      </style>
    </head>
    <body class="bg-slate-50 text-slate-800 h-screen overflow-hidden flex">
      
      <div id="app" class="w-full flex h-full">
        
        <aside class="w-64 bg-slate-900 text-slate-300 flex-col hidden md:flex shrink-0 shadow-xl z-20">
          <div class="p-6 text-xl font-bold text-white flex items-center gap-3 border-b border-slate-800">
            <div class="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center text-white text-sm"><i class="fa-solid fa-wallet"></i></div>
            資產管家
          </div>
          <nav class="p-4 space-y-2 flex-1 overflow-y-auto scroller">
             <button @click="changeView('dashboard')" :class="navClass('dashboard')"><i class="fa-solid fa-chart-pie w-5"></i> 總覽</button>
             <button @click="changeView('add')" :class="navClass('add')"><i class="fa-solid fa-circle-plus w-5"></i> 新增記帳</button>
             <button @click="changeView('notes')" :class="navClass('notes')"><i class="fa-solid fa-book w-5"></i> 記事本</button>
             
             <div class="pt-4 pb-2 px-4 flex justify-between items-center text-xs font-bold text-slate-500 uppercase">
                <span>銀行帳戶</span>
                <button @click="changeView('accounts')" class="hover:text-white transition"><i class="fa-solid fa-list-ul"></i> 全部</button>
             </div>
             <div class="space-y-1">
                 <button v-for="acc in accounts" :key="acc.id" @click="openDetail(acc)" 
                    :class="['w-full text-left px-4 py-2 rounded-lg text-sm transition flex items-center justify-between group', (currentView==='account_detail' && currentAccount?.id===acc.id) ? 'bg-slate-800 text-white' : 'hover:bg-slate-800/50']">
                    <span class="truncate">{{ acc.name }}</span>
                    <span class="text-xs bg-slate-800 px-1.5 py-0.5 rounded text-slate-400 group-hover:bg-slate-700">{{ acc.currency }}</span>
                 </button>
             </div>
          </nav>
        </aside>

        <main class="flex-1 flex flex-col h-full overflow-hidden relative">
            <header class="bg-white p-3 flex justify-between items-center md:hidden border-b border-slate-200 z-20 shrink-0">
                <div class="font-bold text-slate-800 flex items-center gap-2">
                    <i class="fa-solid fa-wallet text-emerald-500"></i> 資產管家
                </div>
                <div class="flex bg-slate-100 rounded-lg p-1">
                    <button @click="changeView('dashboard')" :class="mobileNavClass('dashboard')"><i class="fa-solid fa-chart-pie"></i></button>
                    <button @click="changeView('add')" :class="mobileNavClass('add')"><i class="fa-solid fa-plus"></i></button>
                    <button @click="changeView('notes')" :class="mobileNavClass('notes')"><i class="fa-solid fa-book"></i></button>
                    <button @click="changeView('accounts')" :class="mobileNavClass('accounts')"><i class="fa-solid fa-building-columns"></i></button>
                </div>
            </header>

            <div class="flex-1 overflow-y-auto bg-slate-50 p-4 md:p-8 scroller relative">
                
                <div v-if="currentView === 'notes'" class="absolute inset-0 flex bg-white md:rounded-2xl md:m-6 md:shadow-xl md:border border-slate-200 overflow-hidden">
                    <div :class="['flex-col border-r border-slate-100 bg-white h-full z-10 transition-transform duration-300 absolute md:relative w-full md:w-80', (isMobile && currentNote) ? '-translate-x-full' : 'translate-x-0', 'md:flex md:translate-x-0']">
                        <div class="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                            <h2 class="font-bold text-lg text-slate-700">筆記列表</h2>
                            <button @click="createNewNote" class="bg-slate-900 text-white px-3 py-1.5 rounded-lg text-sm font-bold shadow hover:bg-slate-700"><i class="fa-solid fa-plus"></i> 新增</button>
                        </div>
                        <div class="flex-1 overflow-y-auto scroller">
                            <div v-for="note in notesList" :key="note.id" @click="selectNote(note)" :class="['p-4 border-b border-slate-50 cursor-pointer hover:bg-slate-50 transition group relative', currentNote?.id === note.id ? 'note-active' : '']">
                                <div class="flex gap-4">
                                    <div class="flex flex-col items-center justify-center bg-slate-100 rounded-lg w-14 h-14 shrink-0 text-slate-600">
                                        <div class="text-xl font-bold leading-none">{{ getDay(note.date) }}</div>
                                        <div class="text-[10px] uppercase font-bold text-slate-400">{{ getMonth(note.date) }}</div>
                                    </div>
                                    <div class="overflow-hidden">
                                        <div class="font-bold text-slate-800 truncate mb-1">{{ note.title || '無標題' }}</div>
                                        <div class="text-xs text-slate-400 truncate">{{ note.content }}</div>
                                        <div class="mt-2 flex items-center gap-2">
                                            <span :class="['w-2 h-2 rounded-full', getTagColor(note.tag)]"></span>
                                            <span class="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{{ getTagName(note.tag) }}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div :class="['flex-1 flex flex-col bg-slate-50 h-full w-full absolute md:relative transition-transform duration-300', (isMobile && !currentNote) ? 'translate-x-full' : 'translate-x-0', 'md:translate-x-0']">
                        <div v-if="!currentNote" class="flex-1 flex flex-col items-center justify-center text-slate-300">
                            <i class="fa-solid fa-book-open text-6xl mb-4"></i><p>選擇一則筆記開始閱讀</p>
                        </div>
                        <div v-else class="flex flex-col h-full">
                            <div class="p-4 border-b border-slate-200 bg-white flex justify-between items-center shrink-0">
                                <div class="flex items-center gap-3">
                                    <button @click="currentNote=null" class="md:hidden text-slate-500 hover:text-slate-800"><i class="fa-solid fa-arrow-left text-xl"></i></button>
                                    <input type="date" v-model="currentNote.date" class="bg-slate-100 border-none rounded px-2 py-1 text-sm font-mono text-slate-600 outline-none">
                                </div>
                                <div class="flex gap-2">
                                    <button @click="deleteNote" class="text-slate-400 hover:text-rose-500 px-3"><i class="fa-solid fa-trash-can"></i></button>
                                    <button @click="saveNote" class="bg-emerald-600 text-white px-4 py-1.5 rounded-lg text-sm font-bold shadow hover:bg-emerald-700">儲存</button>
                                </div>
                            </div>
                            <div class="flex-1 overflow-y-auto p-6 md:p-10">
                                <div class="max-w-3xl mx-auto h-full flex flex-col">
                                    <input v-model="currentNote.title" type="text" placeholder="輸入標題..." lang="zh-TW" class="text-3xl font-bold text-slate-800 bg-transparent outline-none placeholder:text-slate-300 mb-4 w-full">
                                    <div class="flex gap-2 mb-6">
                                        <button v-for="tag in ['general','diary','todo','idea']" :key="tag" @click="currentNote.tag=tag"
                                            :class="['px-3 py-1 rounded-full text-xs font-bold transition border', currentNote.tag===tag ? getTagActiveColor(tag) : 'bg-white text-slate-400 border-slate-200 hover:border-slate-300']">
                                            {{ getTagName(tag) }}
                                        </button>
                                    </div>
                                    <textarea v-model="currentNote.content" placeholder="寫點什麼..." lang="zh-TW" inputmode="text" class="flex-1 w-full bg-transparent resize-none text-slate-600 leading-relaxed text-lg placeholder:text-slate-300"></textarea>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'dashboard'" class="max-w-6xl mx-auto space-y-6">
                    
                    <div class="bg-white p-4 rounded-xl shadow-sm border border-slate-200">
                        <div class="text-xs font-bold text-slate-500 uppercase mb-3"><i class="fa-solid fa-filter mr-1"></i> 顯示銀行 (點擊開關)</div>
                        <div class="flex flex-wrap gap-2">
                            <button @click="toggleBank('all')" :class="['px-3 py-1 rounded-full text-xs font-bold transition border', selectedBanks.length===accounts.length ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200']">全部</button>
                            <button v-for="acc in accounts" :key="acc.id" @click="toggleBank(acc.id)"
                                :class="['px-3 py-1 rounded-full text-xs font-bold transition border flex items-center gap-1', selectedBanks.includes(acc.id) ? 'bg-blue-100 text-blue-800 border-blue-200' : 'bg-slate-50 text-slate-400 border-slate-100 decoration-slate-400']">
                                <i v-if="selectedBanks.includes(acc.id)" class="fa-solid fa-check"></i>{{ acc.name }}
                            </button>
                        </div>
                    </div>

                    <div class="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-wrap items-center gap-4">
                        <div class="text-sm font-bold text-slate-600"><i class="fa-solid fa-calendar-days mr-2"></i>查詢區間</div>
                        <div class="flex items-center gap-2">
                            <input type="date" v-model="dateRange.start" class="bg-slate-50 border border-slate-300 rounded px-2 py-1 text-sm">
                            <span class="text-slate-400">~</span>
                            <input type="date" v-model="dateRange.end" class="bg-slate-50 border border-slate-300 rounded px-2 py-1 text-sm">
                        </div>
                        <div class="flex gap-2">
                            <button @click="fetchStats" class="bg-slate-800 text-white px-3 py-1 rounded text-sm font-bold hover:bg-slate-700">查詢</button>
                            <button @click="resetDateRange" class="text-slate-500 px-3 py-1 rounded text-sm hover:bg-slate-100">全部</button>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div class="bg-slate-800 text-white p-6 rounded-2xl shadow-lg relative overflow-hidden">
                            <div class="text-slate-400 text-sm mb-1">總淨資產 (TWD)</div>
                            <div class="text-3xl font-bold">{{ formatCurrency(totalNetWorth) }}</div>
                            <i class="fa-solid fa-shield-cat absolute -bottom-4 -right-4 text-8xl opacity-10"></i>
                        </div>
                        <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                            <div class="text-slate-500 text-sm mb-1">區間總收入 <span class="text-xs text-slate-300">(已排除轉帳)</span></div>
                            <div class="text-3xl font-bold text-emerald-600">+{{ formatCurrency(stats.income) }}</div>
                        </div>
                        <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                            <div class="text-slate-500 text-sm mb-1">區間總支出</div>
                            <div class="text-3xl font-bold text-rose-600">-{{ formatCurrency(stats.expense) }}</div>
                        </div>
                    </div>

                    <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                        <div class="flex justify-between items-center mb-4">
                            <h3 class="font-bold text-slate-700">每月收支趨勢</h3>
                            <button @click="showDataLabels = !showDataLabels" :class="['text-xs px-2 py-1 rounded border transition', showDataLabels ? 'bg-slate-100 text-slate-600 border-slate-300' : 'text-slate-400 border-slate-100']">
                                <i :class="['fa-solid', showDataLabels ? 'fa-eye' : 'fa-eye-slash']"></i> 顯示數值
                            </button>
                        </div>
                        <div class="h-64 md:h-80"><canvas id="barChart"></canvas></div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[500px]">
                            <div class="flex justify-between items-center mb-4 shrink-0">
                                <h3 class="font-bold text-slate-700">分類佔比分析</h3>
                                <div class="flex bg-slate-100 rounded p-0.5">
                                    <button @click="pieType='EXPENSE'" :class="['text-xs px-3 py-1.5 rounded transition font-bold', pieType==='EXPENSE'?'bg-white shadow text-rose-500':'text-slate-400']">支出</button>
                                    <button @click="pieType='INCOME'" :class="['text-xs px-3 py-1.5 rounded transition font-bold', pieType==='INCOME'?'bg-white shadow text-emerald-500':'text-slate-400']">收入</button>
                                </div>
                            </div>
                            <div class="flex-1 flex flex-col md:flex-row items-center gap-4 overflow-hidden">
                                <div class="w-full md:w-1/2 h-64 md:h-full relative">
                                    <canvas id="pieChart"></canvas>
                                    <div v-if="!hasPieData" class="absolute inset-0 flex items-center justify-center text-slate-300 text-sm">無數據</div>
                                </div>
                                <div class="w-full md:w-1/2 h-full overflow-y-auto scroller pr-2">
                                    <div v-if="hasPieData" class="space-y-3">
                                        <div v-for="(item, idx) in pieChartLegendData" :key="idx" class="flex items-center justify-between text-sm p-2 hover:bg-slate-50 rounded-lg transition">
                                            <div class="flex items-center gap-2">
                                                <span class="w-3 h-3 rounded-full shrink-0 shadow-sm" :style="{backgroundColor: item.color}"></span>
                                                <span class="text-slate-700 font-bold truncate max-w-[100px]">{{ item.name }}</span>
                                            </div>
                                            <div class="text-right">
                                                <div class="font-mono font-bold text-slate-800">{{ item.amount }}</div>
                                                <div class="text-xs text-slate-400">{{ item.percent }}</div>
                                            </div>
                                        </div>
                                    </div>
                                    <div v-else class="h-full flex items-center justify-center text-slate-300 text-xs">尚無分類數據</div>
                                </div>
                            </div>
                        </div>

                        <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[500px]">
                            <div class="flex justify-between items-center mb-4">
                                <h3 class="font-bold text-slate-700">常出現的關鍵字 (Top 15)</h3>
                                <div class="text-xs text-slate-400 bg-slate-100 px-2 py-1 rounded">總金額</div>
                            </div>
                            <div class="flex-1 relative overflow-hidden">
                                <canvas id="keywordChart"></canvas>
                                <div v-if="stats.keywords.length===0" class="absolute inset-0 flex items-center justify-center text-slate-300 text-sm">無數據</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'add'" class="max-w-4xl mx-auto flex flex-col gap-6">
                    <div class="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden relative">
                        <button @click="showCategoryModal=true" class="absolute top-4 right-4 text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-1.5 rounded-lg font-bold transition flex items-center gap-1">
                            <i class="fa-solid fa-gear"></i> 分類管理
                        </button>
                        <div class="bg-slate-50 p-4 border-b border-slate-100 flex justify-center mt-6 md:mt-0">
                            <div class="grid grid-cols-4 gap-2 bg-slate-200/50 p-1 rounded-xl w-full max-w-lg">
                                <button v-for="t in ['EXPENSE','INCOME','TRANSFER','TRANSFER_IN']" :key="t" @click="form.type=t"
                                    :class="['py-2 rounded-lg text-sm font-bold transition flex items-center justify-center gap-1', form.type===t ? typeColor(t) + ' text-white shadow-md' : 'text-slate-500 hover:text-slate-700']">{{ typeName(t) }}</button>
                            </div>
                        </div>
                        <div class="p-6 grid gap-6">
                            <div class="grid grid-cols-2 gap-4">
                                <div><label class="text-xs font-bold text-slate-400 uppercase mb-1 block">日期</label><input type="date" v-model="form.date" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500"></div>
                                <div><label class="text-xs font-bold text-slate-400 uppercase mb-1 block">帳戶</label><select v-model="form.account_id" @change="fetchRecent" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500"><option v-for="acc in accounts" :value="acc.id">{{ acc.name }}</option></select></div>
                            </div>
                            <div class="relative">
                                <div class="flex justify-between mb-1"><label class="text-xs font-bold text-slate-400 uppercase">金額</label><label class="text-xs flex items-center gap-2"><input type="checkbox" v-model="isDetailMode" class="rounded text-blue-600"> 明細模式</label></div>
                                <input type="number" v-model="form.amount_twd" :readonly="isDetailMode" placeholder="0" :class="['w-full rounded-xl px-4 py-4 text-3xl font-mono font-bold outline-none transition', isDetailMode?'bg-slate-100 text-slate-400':'bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-blue-500 text-slate-800']">
                            </div>
                            <div v-if="isDetailMode" class="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-2">
                                <div v-for="(child, idx) in form.children" :key="idx" class="flex gap-2">
                                    <select v-model="child.category_id" class="w-1/3 bg-white border border-slate-200 rounded-lg px-2 py-2 text-sm focus:border-blue-500"><option v-for="c in filteredCategories" :value="c.id">{{ c.name }}</option></select>
                                    <input type="text" v-model="child.note" placeholder="備註" lang="zh-TW" inputmode="text" class="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-500">
                                    <input type="number" v-model="child.amount_twd" class="w-24 bg-white border border-slate-200 rounded-lg px-2 py-2 text-sm text-right font-mono focus:border-blue-500">
                                    <button @click="removeChild(idx)" class="text-slate-400 hover:text-rose-500"><i class="fa-solid fa-xmark"></i></button>
                                </div>
                                <button @click="addChild" class="text-xs text-blue-600 font-bold hover:underline">+ 新增一列</button>
                            </div>
                            <div v-else class="grid grid-cols-2 gap-4">
                                <div><label class="text-xs font-bold text-slate-400 uppercase mb-1 block">分類</label><select v-model="form.category_id" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500"><option v-for="c in filteredCategories" :value="c.id">{{ c.name }}</option></select></div>
                                <div><label class="text-xs font-bold text-slate-400 uppercase mb-1 block">備註</label><input type="text" v-model="form.note" lang="zh-TW" inputmode="text" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500"></div>
                            </div>
                        </div>
                        <div class="p-4 bg-slate-50 border-t border-slate-100 flex justify-end gap-3">
                            <button @click="submit" :disabled="isSubmitting" class="bg-slate-900 text-white px-8 py-3 rounded-xl font-bold shadow hover:bg-slate-800 transition disabled:opacity-50 w-full md:w-auto">確認記帳</button>
                        </div>
                    </div>
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col overflow-hidden">
                        <div class="p-4 border-b border-slate-100 font-bold text-slate-600 bg-slate-50 flex justify-between items-center">
                            <span><i class="fa-solid fa-clock-rotate-left mr-2"></i> {{ selectedAccountName }} 近期明細</span>
                        </div>
                        <div class="overflow-x-auto">
                            <table class="w-full text-left text-sm">
                                <thead class="text-xs text-slate-400 uppercase bg-white border-b border-slate-100">
                                    <tr><th class="p-3">日期</th><th class="p-3">分類</th><th class="p-3">備註</th><th class="p-3 text-right">金額</th><th class="p-3 text-center w-24">操作</th></tr>
                                </thead>
                                <tbody class="divide-y divide-slate-50">
                                    <tr v-for="t in recentTransactions" :key="t.id" class="hover:bg-slate-50 group">
                                        <td class="p-3 text-slate-500 font-mono">{{ t.date }}</td>
                                        <td class="p-3 font-bold text-slate-700">{{ t.category_name }}</td>
                                        <td class="p-3 text-slate-500">{{ t.note }}</td>
                                        <td :class="['p-3 text-right font-mono font-bold', getAmountClass(t)]">{{ (t.type==='EXPENSE'||t.type==='TRANSFER')?'-':'+' }}{{ formatAmount(t) }}</td>
                                        <td class="p-3 text-center flex justify-center items-center gap-4">
                                            <button @click="openEditModal(t)" class="text-slate-300 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition"><i class="fa-solid fa-pen"></i></button>
                                            <button @click="deleteTransaction(t.id)" class="text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition"><i class="fa-solid fa-trash-can"></i></button>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'accounts'" class="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    <div v-for="acc in accounts" :key="acc.id" @click="openDetail(acc)" class="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm cursor-pointer hover:border-blue-400 hover:shadow-md transition relative group overflow-hidden">
                        <div class="flex justify-between items-start z-10 relative">
                            <div class="font-bold text-lg text-slate-700">{{ acc.name }}</div>
                            <span class="text-xs font-bold bg-slate-100 px-2 py-1 rounded text-slate-500">{{ acc.currency }}</span>
                        </div>
                        <div class="mt-4 z-10 relative">
                            <div class="text-3xl font-mono font-bold text-slate-800">{{ formatCurrency(acc.balance_twd, acc.currency) }}</div>
                            <div class="text-xs text-slate-400 mt-1">目前餘額</div>
                        </div>
                        <i class="fa-solid fa-building-columns absolute -bottom-4 -right-4 text-8xl text-slate-50 group-hover:text-blue-50 transition"></i>
                    </div>
                </div>

                <div v-if="currentView === 'account_detail'" class="max-w-5xl mx-auto h-full flex flex-col">
                    <div class="bg-white rounded-2xl shadow-lg border border-slate-200 flex-1 flex flex-col overflow-hidden">
                        <div class="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                            <button @click="currentView='accounts'" class="text-slate-500 hover:text-slate-800 font-bold text-sm"><i class="fa-solid fa-arrow-left mr-1"></i> 返回</button>
                            <div class="text-right">
                                <div class="font-bold text-slate-800">{{ currentAccount?.name }}</div>
                                <div class="text-xs text-slate-400">當前餘額: {{ formatCurrency(currentAccount?.balance_twd, currentAccount?.currency) }}</div>
                            </div>
                        </div>
                        <div class="flex-1 overflow-y-auto scroller">
                            <table class="w-full text-left">
                                <thead class="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0 z-10 shadow-sm">
                                    <tr><th class="p-4 w-10"></th><th class="p-4">日期</th><th class="p-4">說明</th><th class="p-4">備註</th><th class="p-4 text-right">金額</th><th class="p-4 text-right">結餘</th><th class="p-4 text-center w-24">操作</th></tr>
                                </thead>
                                <tbody class="divide-y divide-slate-50 text-sm">
                                    <template v-for="t in detailTransactions" :key="t.id">
                                        <tr :class="['hover:bg-slate-50 group cursor-pointer', t.type==='BALANCE'?'bg-slate-100 text-slate-500 font-bold':'']" @click="t.expanded = !t.expanded">
                                            <td class="p-4 text-center"><i v-if="t.children?.length" :class="['fa-solid text-xs text-slate-300', t.expanded?'fa-chevron-down':'fa-chevron-right']"></i></td>
                                            <td class="p-4 font-mono whitespace-nowrap">{{ t.date }}</td>
                                            <td class="p-4 font-bold text-slate-700 whitespace-nowrap">{{ t.type==='BALANCE'?'初始餘額':t.category_name }}<div class="text-xs text-slate-400 font-normal" v-if="t.children?.length">{{ t.children.length }} 筆明細</div></td>
                                            <td class="p-4 text-slate-500 max-w-xs truncate">{{ t.note }}</td>
                                            <td :class="['p-4 text-right font-mono font-bold whitespace-nowrap', getAmountClass(t)]">{{ t.type==='BALANCE'?'':((t.type==='EXPENSE'||t.type==='TRANSFER')?'-':'+') }}{{ t.amount_twd ? formatCurrency(t.amount_twd, currentAccount?.currency) : '-' }}</td>
                                            <td class="p-4 text-right font-mono text-slate-500 whitespace-nowrap">{{ formatCurrency(t.running_balance, currentAccount?.currency) }}</td>
                                            <td class="p-4 text-center flex justify-center items-center gap-4" @click.stop>
                                                <div v-if="t.type!=='BALANCE'" class="flex gap-4">
                                                    <button @click="openEditModal(t)" class="text-slate-300 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition"><i class="fa-solid fa-pen"></i></button>
                                                    <button @click="deleteTransaction(t.id)" class="text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition"><i class="fa-solid fa-trash-can"></i></button>
                                                </div>
                                            </td>
                                        </tr>
                                        <tr v-if="t.expanded && t.children?.length" class="bg-slate-50/80 shadow-inner"><td colspan="7" class="p-2 pl-16 pr-4"><div v-for="child in t.children" :key="child.id" class="flex justify-between text-xs text-slate-500 py-1 border-b border-slate-200 last:border-0"><span>{{ child.category_name }} <span class="text-slate-400 ml-1">{{ child.note }}</span></span><span class="font-mono">{{ formatCurrency(child.amount_twd, currentAccount?.currency) }}</span></div></td></tr>
                                    </template>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <transition name="modal"><div v-if="showEditModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"><div class="p-4 bg-slate-900 text-white font-bold flex justify-between items-center"><span>編輯交易</span><button @click="showEditModal=false" class="text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button></div><div class="p-6 overflow-y-auto scroller"><div class="grid grid-cols-4 gap-2 bg-slate-100 p-1 rounded-xl mb-4"><button v-for="t in ['EXPENSE','INCOME','TRANSFER','TRANSFER_IN']" :key="t" @click="editForm.type=t" :class="['py-2 rounded-lg text-xs font-bold transition', editForm.type===t ? typeColor(t) + ' text-white shadow' : 'text-slate-500']">{{ typeName(t) }}</button></div><div class="grid grid-cols-2 gap-4 mb-4"><div><label class="text-xs font-bold text-slate-400 mb-1 block">日期</label><input type="date" v-model="editForm.date" class="w-full bg-slate-50 border rounded px-3 py-2"></div><div><label class="text-xs font-bold text-slate-400 mb-1 block">帳戶</label><select v-model="editForm.account_id" class="w-full bg-slate-50 border rounded px-3 py-2"><option v-for="acc in accounts" :value="acc.id">{{ acc.name }}</option></select></div></div><div class="mb-4"><label class="text-xs font-bold text-slate-400 mb-1 block">金額</label><input type="number" v-model="editForm.amount_twd" :readonly="isEditDetailMode" class="w-full bg-slate-50 border rounded px-4 py-3 text-2xl font-mono font-bold"><label class="flex items-center gap-2 mt-2 text-xs"><input type="checkbox" v-model="isEditDetailMode"> 明細模式</label></div><div v-if="isEditDetailMode" class="bg-slate-50 rounded border p-3 space-y-2 mb-4"><div v-for="(child, idx) in editForm.children" :key="idx" class="flex gap-2"><select v-model="child.category_id" class="w-1/3 border rounded text-sm"><option v-for="c in editFilteredCategories" :value="c.id">{{ c.name }}</option></select><input type="text" v-model="child.note" class="flex-1 border rounded text-sm px-2" lang="zh-TW" inputmode="text"><input type="number" v-model="child.amount_twd" class="w-20 border rounded text-sm px-1 text-right"><button @click="removeEditChild(idx)" class="text-rose-500"><i class="fa-solid fa-xmark"></i></button></div><button @click="addEditChild" class="text-xs text-blue-600 font-bold">+ 新增明細</button></div><div v-else class="grid grid-cols-2 gap-4 mb-4"><div><label class="text-xs font-bold text-slate-400 mb-1 block">分類</label><select v-model="editForm.category_id" class="w-full border rounded px-3 py-2"><option v-for="c in editFilteredCategories" :value="c.id">{{ c.name }}</option></select></div><div><label class="text-xs font-bold text-slate-400 mb-1 block">備註</label><input type="text" v-model="editForm.note" class="w-full border rounded px-3 py-2" lang="zh-TW" inputmode="text"></div></div></div><div class="p-4 border-t bg-slate-50 flex justify-end gap-3"><button @click="showEditModal=false" class="px-4 py-2 rounded text-slate-500 font-bold">取消</button><button @click="submitEdit" class="px-6 py-2 bg-emerald-600 text-white rounded font-bold shadow">儲存變更</button></div></div></div></transition>
                <transition name="modal"><div v-if="showCategoryModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><div class="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden"><div class="p-4 bg-slate-800 text-white font-bold flex justify-between items-center"><span>分類管理</span><button @click="showCategoryModal=false" class="text-slate-400 hover:text-white"><i class="fa-solid fa-xmark"></i></button></div><div class="p-4 flex gap-2 border-b"><input v-model="newCategoryName" type="text" placeholder="輸入新分類名稱" class="flex-1 border rounded px-3 py-2 text-sm" lang="zh-TW" inputmode="text"><select v-model="newCategoryType" class="border rounded px-2 py-2 text-sm"><option value="EXPENSE">支出</option><option value="INCOME">收入</option><option value="TRANSFER">轉帳</option></select><button @click="addCategory" class="bg-blue-600 text-white px-3 rounded text-sm font-bold">新增</button></div><div class="flex-1 overflow-y-auto p-2"><div v-for="c in categories" :key="c.id" class="flex justify-between items-center p-3 hover:bg-slate-50 border-b last:border-0"><div class="flex items-center gap-3"><span :class="['w-2 h-2 rounded-full', c.type==='EXPENSE'?'bg-rose-500':(c.type==='INCOME'?'bg-emerald-500':'bg-blue-500')]"></span><span class="font-bold text-slate-700">{{ c.name }}</span></div><button @click="deleteCategory(c.id)" class="text-slate-300 hover:text-rose-500"><i class="fa-solid fa-trash-can"></i></button></div></div></div></div></transition>

            </div>
        </main>
      </div>

      <script>
        const { createApp, ref, computed, onMounted, watch, nextTick } = Vue
        Chart.register(ChartDataLabels);

        let barChartInstance = null, pieChartInstance = null, keywordChartInstance = null
        
        const initialBalances = { 1: 170687, 2: 66892, 3: 0, 4: 84565, 5: 620623, 6: 35030, 7: 52917, 8: 0, 9: 887203 }

        createApp({
            setup() {
                const currentView = ref('dashboard')
                const isSubmitting = ref(false)
                const isDetailMode = ref(false)
                const dateRange = ref({ start: '', end: '' })
                const pieType = ref('EXPENSE')
                const showDataLabels = ref(true)
                const isMobile = ref(window.innerWidth < 768)
                const pieChartLegendData = ref([]) // 新增：儲存圓餅圖列表數據
                
                const showEditModal = ref(false)
                const showCategoryModal = ref(false)
                const editingId = ref(null)
                const selectedBanks = ref([]) 
                const newCategoryName = ref('')
                const newCategoryType = ref('EXPENSE')

                const categories = ref([]); const accounts = ref([])
                const recentTransactions = ref([]); const detailTransactions = ref([])
                const currentAccount = ref(null)
                const stats = ref({ income: 0, expense: 0, monthly: [], categories: [], keywords: [] })
                
                const notesList = ref([]); const currentNote = ref(null)
                const form = ref({ date: new Date().toISOString().split('T')[0], account_id: '', type: 'EXPENSE', category_id: '', amount_twd: '', note: '', children: [] })
                const editForm = ref({ date: '', account_id: '', type: 'EXPENSE', category_id: '', amount_twd: '', note: '', children: [] })
                const isEditDetailMode = ref(false)

                watch(() => form.value.children, (newVal) => { if (isDetailMode.value) form.value.amount_twd = newVal.reduce((acc, curr) => acc + (Number(curr.amount_twd) || 0), 0) || '' }, { deep: true })
                watch(isDetailMode, (val) => { if(val && !form.value.children.length) addChild(); if(!val) form.value.children=[] })
                watch(() => editForm.value.children, (newVal) => { if (isEditDetailMode.value) editForm.value.amount_twd = newVal.reduce((acc, curr) => acc + (Number(curr.amount_twd) || 0), 0) || '' }, { deep: true })
                watch(isEditDetailMode, (val) => { if(val && !editForm.value.children?.length) addEditChild(); if(!val) editForm.value.children=[] })
                watch([pieType, showDataLabels], () => renderCharts())
                watch(selectedBanks, (val) => { localStorage.setItem('selectedBanks', JSON.stringify(val)) }, { deep: true })
                window.addEventListener('resize', () => { isMobile.value = window.innerWidth < 768 })

                const currentCurrency = computed(() => accounts.value.find(a => a.id === form.value.account_id)?.currency || 'TWD')
                const selectedAccountName = computed(() => accounts.value.find(a => a.id === form.value.account_id)?.name)
                const filterCats = (type) => categories.value.filter(c => { if (type === 'TRANSFER_IN' || type === 'TRANSFER') return c.type === 'TRANSFER'; return c.type === type })
                const filteredCategories = computed(() => filterCats(form.value.type))
                const editFilteredCategories = computed(() => filterCats(editForm.value.type))
                const totalNetWorth = computed(() => accounts.value.reduce((sum, acc) => { if (selectedBanks.value.length > 0 && !selectedBanks.value.includes(acc.id)) return sum; let rate = 1; if(acc.currency==='JPY') rate=0.21; if(acc.currency==='USD') rate=32; return sum + (acc.balance_twd || 0) * (acc.currency==='TWD'?1:rate) }, 0))
                const hasPieData = computed(() => stats.value.categories.filter(c => c.type === pieType.value).length > 0)

                const formatCurrency = (val, cur='TWD') => new Intl.NumberFormat('zh-TW', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(val || 0)
                const formatAmount = (t) => formatCurrency(t.amount_twd, accounts.value.find(a=>a.id===t.account_id)?.currency)
                const typeName = (t) => ({'EXPENSE':'支出','INCOME':'收入','TRANSFER':'轉出','TRANSFER_IN':'轉入'}[t])
                const typeColor = (t) => ({'EXPENSE':'bg-rose-500','INCOME':'bg-emerald-500','TRANSFER':'bg-blue-500','TRANSFER_IN':'bg-emerald-600'}[t])
                const navClass = (v) => ['w-full text-left px-4 py-2.5 rounded-lg flex items-center gap-3 transition font-medium', currentView.value===v ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:bg-slate-800 hover:text-white']
                const mobileNavClass = (v) => ['px-4 py-2 rounded-md text-xl transition', currentView.value===v ? 'bg-white shadow text-emerald-600' : 'text-slate-400']
                const getAmountClass = (t) => { if (t.type === 'BALANCE') return ''; const isTransfer = t.category_name === '帳戶間移轉' || t.category_name === '借入/負債' || t.category_type === 'TRANSFER'; if (t.type === 'INCOME') return isTransfer ? 'text-emerald-400' : 'text-emerald-600'; return isTransfer ? 'text-rose-400' : 'text-rose-600' }

                const addChild = () => form.value.children.push({ category_id: '', amount_twd: '', note: '' })
                const removeChild = (idx) => form.value.children.splice(idx, 1)
                const addEditChild = () => editForm.value.children.push({ category_id: '', amount_twd: '', note: '' })
                const removeEditChild = (idx) => editForm.value.children.splice(idx, 1)

                const fetchData = async () => { const [c, a] = await Promise.all([fetch('/api/categories').then(r=>r.json()), fetch('/api/accounts').then(r=>r.json())]); categories.value = c; accounts.value = a; const saved = localStorage.getItem('selectedBanks'); if (saved) { selectedBanks.value = JSON.parse(saved) } else { selectedBanks.value = a.map(acc => acc.id) }; if(!form.value.account_id && a.length>0) form.value.account_id = a[0].id }
                const fetchRecent = async () => { if(!form.value.account_id) return; const res = await fetch(\`/api/transactions?account_id=\${form.value.account_id}&limit=20\`); recentTransactions.value = await res.json() }
                const fetchStats = async () => { const query = new URLSearchParams({ start: dateRange.value.start, end: dateRange.value.end, account_ids: selectedBanks.value.join(',') }).toString(); const res = await fetch(\`/api/stats?\${query}\`); const data = await res.json(); stats.value = data; if(currentView.value === 'dashboard') nextTick(renderCharts) }
                const fetchNotes = async () => { const res = await fetch('/api/notes'); notesList.value = await res.json() }
                
                const createNewNote = () => { currentNote.value = { date: new Date().toISOString().split('T')[0], title: '', content: '', tag: 'general', id: null } }
                const selectNote = (note) => { currentNote.value = { ...note } }
                const saveNote = async () => { if (!currentNote.value) return; const method = currentNote.value.id ? 'PUT' : 'POST'; const url = currentNote.value.id ? \`/api/notes/\${currentNote.value.id}\` : '/api/notes'; await fetch(url, { method, body: JSON.stringify(currentNote.value) }); await fetchNotes(); if (!currentNote.value.id) selectNote(notesList.value[0]); alert('儲存成功') }
                const deleteNote = async () => { if (!confirm('確定刪除此筆記？')) return; if (currentNote.value.id) { await fetch(\`/api/notes/\${currentNote.value.id}\`, { method: 'DELETE' }) }; currentNote.value = null; await fetchNotes() }
                
                const getDay = (d) => d.split('-')[2]; const getMonth = (d) => new Date(d).toLocaleString('en-US', { month: 'short' })
                const getTagColor = (tag) => ({'general':'bg-slate-400','diary':'bg-blue-500','todo':'bg-rose-500','idea':'bg-amber-500'}[tag] || 'bg-slate-400')
                const getTagActiveColor = (tag) => ({'general':'bg-slate-100 text-slate-600 border-slate-300','diary':'bg-blue-100 text-blue-600 border-blue-300','todo':'bg-rose-100 text-rose-600 border-rose-300','idea':'bg-amber-100 text-amber-600 border-amber-300'}[tag])
                const getTagName = (tag) => ({'general':'一般','diary':'日記','todo':'待辦','idea':'靈感'}[tag] || tag)

                const toggleBank = (id) => { if (id === 'all') selectedBanks.value = accounts.value.map(a => a.id); else { if (selectedBanks.value.includes(id)) selectedBanks.value = selectedBanks.value.filter(x => x !== id); else selectedBanks.value.push(id) }; fetchStats() }
                const resetDateRange = () => { dateRange.value = { start: '', end: '' }; fetchStats() }
                const changeView = (v, reset = true) => { currentView.value = v; if (reset) cancelEdit(); if(v==='dashboard') fetchStats(); if(v==='accounts') fetchData(); if(v==='notes') fetchNotes() }
                const openDetail = async (acc) => { currentAccount.value = acc; currentView.value = 'account_detail'; const res = await fetch(\`/api/transactions?account_id=\${acc.id}&limit=100\`); const data = await res.json(); let running = acc.balance_twd; const list = data.map((t) => { const currentBal = running; if (t.type === 'INCOME') running -= t.amount_twd; else running += t.amount_twd; return { ...t, running_balance: currentBal, expanded: false } }); const initBal = initialBalances[acc.id] || 0; list.push({ id: 'init', date: '2025-01-01', type: 'BALANCE', amount_twd: null, running_balance: initBal, note: '初始餘額', expanded: false }); detailTransactions.value = list }
                const deleteTransaction = async (id) => { if(!confirm('確定刪除？')) return; await fetch(\`/api/transactions/\${id}\`, { method: 'DELETE' }); fetchData(); fetchRecent(); if(currentView.value==='account_detail') openDetail(currentAccount.value) }
                const addCategory = async () => { if(!newCategoryName.value) return; await fetch('/api/categories', { method: 'POST', body: JSON.stringify({ name: newCategoryName.value, type: newCategoryType.value }) }); newCategoryName.value = ''; fetchData() }
                const deleteCategory = async (id) => { if(!confirm('刪除？')) return; await fetch(\`/api/categories/\${id}\`, { method: 'DELETE' }); fetchData() }
                const openEditModal = (t) => { editingId.value = t.id; isEditDetailMode.value = t.children && t.children.length > 0; let viewType = t.type; if (t.type === 'INCOME' && (t.category_name === '帳戶間移轉' || t.category_type === 'TRANSFER')) viewType = 'TRANSFER_IN'; editForm.value = { date: t.date, account_id: t.account_id, category_id: t.category_id, type: viewType, amount_twd: t.amount_twd, note: t.note, children: t.children ? JSON.parse(JSON.stringify(t.children)) : [] }; showEditModal.value = true }
                const cancelEdit = () => { editingId.value = null; form.value = { date: new Date().toISOString().split('T')[0], account_id: accounts.value[0]?.id, type: 'EXPENSE', category_id: '', amount_twd: '', note: '', children: [] }; isDetailMode.value = false }
                const submitEdit = async () => { if(!editForm.value.account_id || !editForm.value.amount_twd) return alert('金額未填'); try { const payloadType = editForm.value.type === 'TRANSFER_IN' ? 'INCOME' : editForm.value.type; const payload = { main: {...editForm.value, type: payloadType}, children: isEditDetailMode.value ? editForm.value.children : [] }; await fetch(\`/api/transactions/\${editingId.value}\`, { method: 'PUT', body: JSON.stringify(payload) }); alert('更新成功'); showEditModal.value = false; fetchData(); fetchRecent(); if(currentView.value==='account_detail') openDetail(currentAccount.value) } catch(e){ alert('錯誤') } }
                const submit = async () => { if(!form.value.account_id || !form.value.amount_twd) return alert('金額未填'); isSubmitting.value = true; try { const payloadType = form.value.type === 'TRANSFER_IN' ? 'INCOME' : form.value.type; const payload = { main: {...form.value, type: payloadType}, children: isDetailMode.value ? form.value.children : [] }; await fetch('/api/transactions', { method: 'POST', body: JSON.stringify(payload) }); alert('記帳成功'); form.value.amount_twd=''; form.value.children=[]; form.value.note=''; fetchRecent(); fetchData() } catch(e){ alert('錯誤') } finally { isSubmitting.value = false } }

                const renderCharts = () => {
                    const ctxBar = document.getElementById('barChart'); const ctxPie = document.getElementById('pieChart'); const ctxKeyword = document.getElementById('keywordChart')
                    if(!ctxBar || !ctxPie || !ctxKeyword) return
                    if(barChartInstance) barChartInstance.destroy(); if(pieChartInstance) pieChartInstance.destroy(); if(keywordChartInstance) keywordChartInstance.destroy()

                    const labels = Array.from({length:12}, (_,i) => \`\${i+1}月\`)
                    const incomeData = labels.map((_, i) => stats.value.monthly.find(m => m.month.endsWith(\`-\${String(i+1).padStart(2,'0')}\`) && m.type==='INCOME')?.total || 0)
                    const expenseData = labels.map((_, i) => stats.value.monthly.find(m => m.month.endsWith(\`-\${String(i+1).padStart(2,'0')}\`) && m.type==='EXPENSE')?.total || 0)

                    barChartInstance = new Chart(ctxBar, {
                        type: 'bar',
                        data: { labels, datasets: [{ label: '收入', data: incomeData, backgroundColor: '#10b981', borderRadius: 4 }, { label: '支出', data: expenseData, backgroundColor: '#f43f5e', borderRadius: 4 }] },
                        options: { 
                            responsive: true, maintainAspectRatio: false, 
                            scales: { y: { beginAtZero: true, grid: { display: false }, grace: '10%' }, x: { grid: { display: false } } },
                            plugins: { datalabels: { display: showDataLabels.value, anchor: 'end', align: 'end', offset: 0, font: { weight: 'bold', size: 11 }, formatter: (val) => val > 0 ? val.toLocaleString() : '' } }
                        }
                    })

                    // Pie Chart & Legend List
                    const pieData = stats.value.categories.filter(c => c.type === pieType.value)
                    const pieTotal = pieData.reduce((sum, c) => sum + c.total, 0)
                    
                    // Generate colors (Chart.js default style colors)
                    const bgColors = ['#3b82f6', '#f59e0b', '#10b981', '#f43f5e', '#8b5cf6', '#cbd5e1', '#64748b', '#06b6d4', '#ec4899', '#84cc16']
                    
                    // Populate List Data
                    pieChartLegendData.value = pieData.map((d, i) => ({
                        name: d.name,
                        amount: '$' + d.total.toLocaleString(),
                        percent: ((d.total / pieTotal) * 100).toFixed(1) + '%',
                        color: bgColors[i % bgColors.length]
                    }))

                    pieChartInstance = new Chart(ctxPie, {
                        type: 'doughnut',
                        data: { 
                            labels: pieData.map(d => d.name), 
                            datasets: [{ 
                                data: pieData.map(d => d.total), 
                                backgroundColor: bgColors, 
                                borderWidth: 0 
                            }] 
                        },
                        options: { 
                            responsive: true, maintainAspectRatio: false, cutout: '70%', 
                            plugins: { legend: { display: false }, datalabels: { display: false } } // Disable text on chart
                        }
                    })

                    const kwLabels = stats.value.keywords.map(k => k.name); const kwData = stats.value.keywords.map(k => k.total)
                    keywordChartInstance = new Chart(ctxKeyword, {
                        type: 'bar', data: { labels: kwLabels, datasets: [{ label: '金額', data: kwData, backgroundColor: '#6366f1', borderRadius: 4, barThickness: 15 }] },
                        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, scales: { x: { display: false }, y: { grid: { display: false } } }, plugins: { legend: { display: false }, datalabels: { anchor: 'end', align: 'end', color: '#6366f1', font: { weight: 'bold' }, formatter: (val) => '$' + val.toLocaleString() } } }
                    })
                }
                
                onMounted(() => { fetchData(); fetchStats(); fetchNotes() })
                
                return { 
                    currentView, isSubmitting, isDetailMode, dateRange, pieType, hasPieData, selectedBanks,
                    showEditModal, showCategoryModal, editingId, editForm, isEditDetailMode, newCategoryName, newCategoryType,
                    categories, accounts, recentTransactions, detailTransactions, currentAccount, stats, form, 
                    currentCurrency, selectedAccountName, filteredCategories, editFilteredCategories, totalNetWorth, 
                    navClass, mobileNavClass, typeName, typeColor, formatCurrency, formatAmount, getAmountClass,
                    addChild, removeChild, addEditChild, removeEditChild, showDataLabels, isMobile, pieChartLegendData,
                    changeView, openDetail, fetchRecent, submit, submitEdit, deleteTransaction, fetchStats, resetDateRange, toggleBank,
                    openEditModal, addCategory, deleteCategory,
                    notesList, currentNote, fetchNotes, createNewNote, selectNote, saveNote, deleteNote, getDay, getMonth, getTagColor, getTagActiveColor, getTagName
                }
            }
        }).mount('#app')
      </script>
    </body>
    </html>
  `)
})

export default app