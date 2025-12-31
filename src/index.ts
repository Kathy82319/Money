import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// ==========================================
// [BACKEND] API 區域
// ==========================================

app.get('/api/categories', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM categories ORDER BY type, id').all()
  return c.json(results)
})

app.get('/api/accounts', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM accounts ORDER BY type, id').all()
  return c.json(results)
})

app.get('/api/transactions', async (c) => {
  const accountId = c.req.query('account_id')
  const limit = c.req.query('limit') || '50'
  
  let sql = `
      SELECT t.*, c.name as category_name 
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

app.get('/api/stats', async (c) => {
    const year = c.req.query('year') || '2025' // 預設 2025
    
    const { results: totals } = await c.env.DB.prepare(`
        SELECT type, SUM(amount_twd) as total 
        FROM transactions 
        WHERE strftime('%Y', date) = ? AND parent_id IS NULL
        GROUP BY type
    `).bind(year).all()

    const { results: monthly } = await c.env.DB.prepare(`
        SELECT strftime('%Y-%m', date) as month, type, SUM(amount_twd) as total 
        FROM transactions 
        WHERE strftime('%Y', date) = ? AND parent_id IS NULL
        GROUP BY month, type
        ORDER BY month
    `).bind(year).all()

    const { results: categories } = await c.env.DB.prepare(`
        SELECT c.name, t.type, SUM(t.amount_twd) as total
        FROM transactions t
        JOIN categories c ON t.category_id = c.id
        WHERE strftime('%Y', date) = ? 
        GROUP BY c.name, t.type
        ORDER BY total DESC
    `).bind(year).all()

    return c.json({ totals, monthly, categories })
})

app.delete('/api/transactions/:id', async (c) => {
    try {
        await c.env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(c.req.param('id')).run()
        return c.json({ success: true })
    } catch (e: any) { return c.json({ error: e.message }, 500) }
})

// [NEW] 編輯交易 API (PUT)
app.put('/api/transactions/:id', async (c) => {
    try {
        const id = c.req.param('id')
        const body = await c.req.json()
        const main = body.main || body
        const children = body.children || []

        if (!main.date || !main.account_id || main.amount_twd === undefined) return c.json({ error: '缺少欄位' }, 400)

        // 1. 更新主交易
        await c.env.DB.prepare(`
            UPDATE transactions 
            SET date=?, account_id=?, category_id=?, type=?, amount_twd=?, note=?
            WHERE id=?
        `).bind(main.date, main.account_id, main.category_id, main.type, main.amount_twd, main.note, id).run()

        // 2. 處理細項 (簡單做法：刪除舊細項，新增新細項)
        // 注意：這需要 D1 支援 Transaction，若不支援可能會有一瞬間資料不一致，但此場景可接受
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
// [FRONTEND] Vue + Tailwind + Chart.js
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
             
             <div class="pt-4 pb-2 text-xs font-bold text-slate-500 uppercase px-4">銀行帳戶</div>
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
                    <button @click="changeView('accounts')" :class="mobileNavClass('accounts')"><i class="fa-solid fa-building-columns"></i></button>
                </div>
            </header>

            <div class="flex-1 overflow-y-auto bg-slate-50 p-4 md:p-8 scroller">
                
                <div v-if="currentView === 'dashboard'" class="max-w-6xl mx-auto space-y-6">
                    <div class="flex justify-end">
                        <select v-model="selectedYear" @change="fetchStats" class="bg-white border border-slate-300 text-slate-700 py-1 px-3 rounded-lg text-sm font-bold shadow-sm outline-none">
                            <option v-for="y in [2024,2025,2026]" :value="y">{{ y }}年</option>
                        </select>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div class="bg-slate-800 text-white p-6 rounded-2xl shadow-lg relative overflow-hidden">
                            <div class="text-slate-400 text-sm mb-1">總淨資產 (TWD估算)</div>
                            <div class="text-3xl font-bold">{{ formatCurrency(totalNetWorth) }}</div>
                            <i class="fa-solid fa-shield-cat absolute -bottom-4 -right-4 text-8xl opacity-10"></i>
                        </div>
                        <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                            <div class="text-slate-500 text-sm mb-1">年度總收入</div>
                            <div class="text-3xl font-bold text-emerald-600">+{{ formatCurrency(stats.income) }}</div>
                        </div>
                        <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                            <div class="text-slate-500 text-sm mb-1">年度總支出</div>
                            <div class="text-3xl font-bold text-rose-600">-{{ formatCurrency(stats.expense) }}</div>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div class="lg:col-span-2 bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                            <h3 class="font-bold text-slate-700 mb-4">收支趨勢</h3>
                            <div class="h-64"><canvas id="barChart"></canvas></div>
                        </div>
                        <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col">
                            <div class="flex justify-between items-center mb-4">
                                <h3 class="font-bold text-slate-700">分類佔比</h3>
                                <div class="flex bg-slate-100 rounded p-0.5">
                                    <button @click="pieType='EXPENSE'" :class="['text-xs px-2 py-1 rounded transition', pieType==='EXPENSE'?'bg-white shadow text-rose-500':'text-slate-400']">支出</button>
                                    <button @click="pieType='INCOME'" :class="['text-xs px-2 py-1 rounded transition', pieType==='INCOME'?'bg-white shadow text-emerald-500':'text-slate-400']">收入</button>
                                </div>
                            </div>
                            <div class="flex-1 flex items-center justify-center relative">
                                <canvas id="pieChart"></canvas>
                                <div v-if="!hasPieData" class="absolute text-slate-300 text-sm">無數據</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'add'" class="max-w-4xl mx-auto flex flex-col gap-6">
                    <div class="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden relative">
                        <div v-if="editingId" class="bg-amber-100 text-amber-800 text-xs font-bold text-center py-1">
                            正在編輯交易 (ID: {{ editingId }})
                        </div>

                        <div class="bg-slate-50 p-4 border-b border-slate-100 flex justify-center">
                            <div class="flex bg-slate-200/50 p-1 rounded-xl w-full max-w-md">
                                <button v-for="t in ['EXPENSE','INCOME','TRANSFER']" :key="t" @click="form.type=t"
                                    :class="['flex-1 py-2 rounded-lg text-sm font-bold transition flex items-center justify-center gap-2', form.type===t ? typeColor(t) + ' text-white shadow-md' : 'text-slate-500 hover:text-slate-700']">
                                    {{ typeName(t) }}
                                </button>
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
                                    <input type="text" v-model="child.note" placeholder="備註" class="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-500">
                                    <input type="number" v-model="child.amount_twd" class="w-24 bg-white border border-slate-200 rounded-lg px-2 py-2 text-sm text-right font-mono focus:border-blue-500">
                                    <button @click="removeChild(idx)" class="text-slate-400 hover:text-rose-500"><i class="fa-solid fa-xmark"></i></button>
                                </div>
                                <button @click="addChild" class="text-xs text-blue-600 font-bold hover:underline">+ 新增一列</button>
                            </div>

                            <div v-else class="grid grid-cols-2 gap-4">
                                <div><label class="text-xs font-bold text-slate-400 uppercase mb-1 block">分類</label><select v-model="form.category_id" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500"><option v-for="c in filteredCategories" :value="c.id">{{ c.name }}</option></select></div>
                                <div><label class="text-xs font-bold text-slate-400 uppercase mb-1 block">備註</label><input type="text" v-model="form.note" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500"></div>
                            </div>
                        </div>
                        
                        <div class="p-4 bg-slate-50 border-t border-slate-100 flex justify-end gap-3">
                            <button v-if="editingId" @click="cancelEdit" class="px-6 py-3 rounded-xl font-bold text-slate-500 hover:bg-slate-200 transition">取消</button>
                            <button @click="submit" :disabled="isSubmitting" class="bg-slate-900 text-white px-8 py-3 rounded-xl font-bold shadow hover:bg-slate-800 transition disabled:opacity-50">
                                {{ editingId ? '更新交易' : '確認記帳' }}
                            </button>
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
                                        <td :class="['p-3 text-right font-mono font-bold', t.type==='INCOME'?'text-emerald-600':'text-rose-600']">{{ t.type==='EXPENSE'?'-':'+' }}{{ formatAmount(t) }}</td>
                                        <td class="p-3 text-center space-x-2">
                                            <button @click="editTransaction(t)" class="text-slate-300 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition"><i class="fa-solid fa-pen"></i></button>
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
                                    <tr><th class="p-4 w-10"></th><th class="p-4">日期</th><th class="p-4">說明</th><th class="p-4 text-right">金額</th><th class="p-4 text-right">結餘</th><th class="p-4 text-center w-24">操作</th></tr>
                                </thead>
                                <tbody class="divide-y divide-slate-50 text-sm">
                                    <template v-for="t in detailTransactions" :key="t.id">
                                        <tr class="hover:bg-slate-50 group cursor-pointer" @click="t.expanded = !t.expanded">
                                            <td class="p-4 text-center"><i v-if="t.children?.length" :class="['fa-solid text-xs text-slate-300', t.expanded?'fa-chevron-down':'fa-chevron-right']"></i></td>
                                            <td class="p-4 text-slate-500 font-mono">{{ t.date }}</td>
                                            <td class="p-4">
                                                <div class="font-bold text-slate-700">{{ t.children?.length ? t.note || '多筆交易' : t.category_name }}</div>
                                                <div class="text-xs text-slate-400" v-if="t.children?.length">{{ t.children.length }} 筆明細</div>
                                            </td>
                                            <td :class="['p-4 text-right font-mono font-bold', t.type==='INCOME'?'text-emerald-600':'text-rose-600']">{{ t.type==='EXPENSE'?'-':'+' }}{{ formatCurrency(t.amount_twd, currentAccount?.currency) }}</td>
                                            <td class="p-4 text-right font-mono text-slate-500">{{ formatCurrency(t.running_balance, currentAccount?.currency) }}</td>
                                            <td class="p-4 text-center space-x-2" @click.stop>
                                                <button @click="editTransaction(t)" class="text-slate-300 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition"><i class="fa-solid fa-pen"></i></button>
                                                <button @click="deleteTransaction(t.id)" class="text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition"><i class="fa-solid fa-trash-can"></i></button>
                                            </td>
                                        </tr>
                                        <tr v-if="t.expanded && t.children?.length" class="bg-slate-50/80 shadow-inner">
                                            <td colspan="6" class="p-2 pl-16 pr-4">
                                                <div v-for="child in t.children" :key="child.id" class="flex justify-between text-xs text-slate-500 py-1 border-b border-slate-200 last:border-0">
                                                    <span>{{ child.category_name }} <span class="text-slate-400 ml-1">{{ child.note }}</span></span>
                                                    <span class="font-mono">{{ formatCurrency(child.amount_twd, currentAccount?.currency) }}</span>
                                                </div>
                                            </td>
                                        </tr>
                                    </template>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

            </div>
        </main>
      </div>

      <script>
        const { createApp, ref, computed, onMounted, watch, nextTick } = Vue
        let barChartInstance = null, pieChartInstance = null

        createApp({
            setup() {
                const currentView = ref('dashboard')
                const isSubmitting = ref(false)
                const isDetailMode = ref(false)
                const selectedYear = ref(2025) // 預設 2025
                const pieType = ref('EXPENSE')
                const editingId = ref(null) // 編輯狀態
                
                const categories = ref([]); const accounts = ref([])
                const recentTransactions = ref([]); const detailTransactions = ref([])
                const currentAccount = ref(null)
                const stats = ref({ income: 0, expense: 0, monthly: [], categories: [] })

                const form = ref({ date: new Date().toISOString().split('T')[0], account_id: '', type: 'EXPENSE', category_id: '', amount_twd: '', note: '', children: [] })

                watch(() => form.value.children, (newVal) => {
                    if (isDetailMode.value) form.value.amount_twd = newVal.reduce((acc, curr) => acc + (Number(curr.amount_twd) || 0), 0) || ''
                }, { deep: true })
                
                watch(isDetailMode, (val) => { if(val && !form.value.children.length) addChild(); if(!val) form.value.children=[] })
                watch(pieType, () => renderCharts())

                const currentCurrency = computed(() => accounts.value.find(a => a.id === form.value.account_id)?.currency || 'TWD')
                const selectedAccountName = computed(() => accounts.value.find(a => a.id === form.value.account_id)?.name)
                const filteredCategories = computed(() => categories.value.filter(c => c.type === form.value.type))
                const totalNetWorth = computed(() => accounts.value.reduce((sum, acc) => {
                    let rate = 1; if(acc.currency==='JPY') rate=0.21; if(acc.currency==='USD') rate=32;
                    return sum + (acc.balance_twd || 0) * (acc.currency==='TWD'?1:rate)
                }, 0))
                const hasPieData = computed(() => stats.value.categories.filter(c => c.type === pieType.value).length > 0)

                const formatCurrency = (val, cur='TWD') => new Intl.NumberFormat('zh-TW', { style: 'currency', currency: cur, minimumFractionDigits:0 }).format(val || 0)
                const formatAmount = (t) => formatCurrency(t.amount_twd, accounts.value.find(a=>a.id===t.account_id)?.currency)
                const typeName = (t) => ({'EXPENSE':'支出','INCOME':'收入','TRANSFER':'轉帳'}[t])
                const typeColor = (t) => ({'EXPENSE':'bg-rose-500','INCOME':'bg-emerald-500','TRANSFER':'bg-blue-500'}[t])
                const navClass = (v) => ['w-full text-left px-4 py-2.5 rounded-lg flex items-center gap-3 transition font-medium', currentView.value===v ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:bg-slate-800 hover:text-white']
                const mobileNavClass = (v) => ['px-4 py-2 rounded-md text-xl transition', currentView.value===v ? 'bg-white shadow text-emerald-600' : 'text-slate-400']

                const addChild = () => form.value.children.push({ category_id: '', amount_twd: '', note: '' })
                const removeChild = (idx) => form.value.children.splice(idx, 1)

                const fetchData = async () => {
                    const [c, a] = await Promise.all([fetch('/api/categories').then(r=>r.json()), fetch('/api/accounts').then(r=>r.json())])
                    categories.value = c; accounts.value = a
                    if(!form.value.account_id && a.length>0 && !editingId.value) form.value.account_id = a[0].id
                }

                const fetchRecent = async () => {
                    if(!form.value.account_id) return
                    const res = await fetch(\`/api/transactions?account_id=\${form.value.account_id}&limit=20\`)
                    recentTransactions.value = await res.json()
                }

                const fetchStats = async () => {
                    const res = await fetch(\`/api/stats?year=\${selectedYear.value}\`)
                    const data = await res.json()
                    stats.value.income = data.totals.find(t=>t.type==='INCOME')?.total || 0
                    stats.value.expense = data.totals.find(t=>t.type==='EXPENSE')?.total || 0
                    stats.value.monthly = data.monthly; stats.value.categories = data.categories
                    if(currentView.value === 'dashboard') nextTick(renderCharts)
                }

                const changeView = (v) => { 
                    currentView.value = v
                    cancelEdit() // 切換頁面時取消編輯
                    if(v==='dashboard') fetchStats()
                    if(v==='accounts') fetchData() 
                }

                const openDetail = async (acc) => {
                    currentAccount.value = acc
                    currentView.value = 'account_detail'
                    const res = await fetch(\`/api/transactions?account_id=\${acc.id}&limit=50\`)
                    const data = await res.json()
                    let running = acc.balance_twd
                    detailTransactions.value = data.map((t) => {
                        const currentBal = running
                        if (t.type === 'INCOME') running -= t.amount_twd
                        else running += t.amount_twd
                        return { ...t, running_balance: currentBal, expanded: false }
                    })
                }

                const deleteTransaction = async (id) => {
                    if(!confirm('確定刪除？')) return
                    await fetch(\`/api/transactions/\${id}\`, { method: 'DELETE' })
                    fetchData(); fetchRecent(); if(currentView.value==='account_detail') openDetail(currentAccount.value)
                }

                // --- 編輯功能 ---
                const editTransaction = (t) => {
                    editingId.value = t.id
                    isDetailMode.value = t.children && t.children.length > 0
                    form.value = {
                        date: t.date,
                        account_id: t.account_id,
                        category_id: t.category_id,
                        type: t.type,
                        amount_twd: t.amount_twd,
                        note: t.note,
                        children: t.children ? JSON.parse(JSON.stringify(t.children)) : []
                    }
                    changeView('add')
                }

                const cancelEdit = () => {
                    editingId.value = null
                    form.value = { date: new Date().toISOString().split('T')[0], account_id: accounts.value[0]?.id, type: 'EXPENSE', category_id: '', amount_twd: '', note: '', children: [] }
                    isDetailMode.value = false
                }

                const submit = async () => {
                    if(!form.value.account_id || !form.value.amount_twd) return alert('金額未填')
                    isSubmitting.value = true
                    try {
                        const payload = { main: {...form.value}, children: isDetailMode.value ? form.value.children : [] }
                        let res
                        if (editingId.value) {
                            res = await fetch(\`/api/transactions/\${editingId.value}\`, { method: 'PUT', body: JSON.stringify(payload) })
                        } else {
                            res = await fetch('/api/transactions', { method: 'POST', body: JSON.stringify(payload) })
                        }
                        
                        if (res.ok) {
                            alert(editingId.value ? '更新成功' : '記帳成功')
                            cancelEdit()
                            fetchRecent(); fetchData()
                        } else {
                            alert('錯誤')
                        }
                    } catch(e){ console.error(e); alert('錯誤') } finally { isSubmitting.value = false }
                }

                const renderCharts = () => {
                    const ctxBar = document.getElementById('barChart'); const ctxPie = document.getElementById('pieChart')
                    if(!ctxBar || !ctxPie) return
                    if(barChartInstance) barChartInstance.destroy(); if(pieChartInstance) pieChartInstance.destroy()

                    const labels = Array.from({length:12}, (_,i) => \`\${i+1}月\`)
                    const incomeData = labels.map((_, i) => stats.value.monthly.find(m => m.month.endsWith(\`-\${String(i+1).padStart(2,'0')}\`) && m.type==='INCOME')?.total || 0)
                    const expenseData = labels.map((_, i) => stats.value.monthly.find(m => m.month.endsWith(\`-\${String(i+1).padStart(2,'0')}\`) && m.type==='EXPENSE')?.total || 0)

                    barChartInstance = new Chart(ctxBar, {
                        type: 'bar',
                        data: { labels, datasets: [{ label: '收入', data: incomeData, backgroundColor: '#10b981', borderRadius: 4 }, { label: '支出', data: expenseData, backgroundColor: '#f43f5e', borderRadius: 4 }] },
                        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, grid: { display: false } }, x: { grid: { display: false } } } }
                    })

                    const pieData = stats.value.categories.filter(c => c.type === pieType.value)
                    const otherTotal = pieData.slice(5).reduce((sum, c) => sum + c.total, 0)
                    const finalPieData = pieData.slice(0, 5)
                    if(otherTotal > 0) finalPieData.push({ name: '其他', total: otherTotal })

                    pieChartInstance = new Chart(ctxPie, {
                        type: 'doughnut',
                        data: {
                            labels: finalPieData.map(d => d.name),
                            datasets: [{ data: finalPieData.map(d => d.total), backgroundColor: ['#3b82f6', '#f59e0b', '#10b981', '#f43f5e', '#8b5cf6', '#cbd5e1'], borderWidth: 0 }]
                        },
                        options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'right' } } }
                    })
                }

                onMounted(() => { fetchData(); fetchStats() })

                return {
                    currentView, isSubmitting, isDetailMode, selectedYear, pieType, hasPieData, editingId,
                    categories, accounts, recentTransactions, detailTransactions, currentAccount, stats,
                    form, currentCurrency, selectedAccountName, filteredCategories, totalNetWorth,
                    navClass, mobileNavClass, typeName, typeColor, formatCurrency, formatAmount,
                    addChild, removeChild, changeView, openDetail, fetchRecent, submit, deleteTransaction, fetchStats, editTransaction, cancelEdit
                }
            }
        }).mount('#app')
      </script>
    </body>
    </html>
  `)
})

export default app