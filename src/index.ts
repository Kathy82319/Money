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
  if (!accountId) return c.json([])

  // 只抓主交易 (Parent)
  const { results: parents } = await c.env.DB.prepare(`
      SELECT t.*, c.name as category_name 
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.account_id = ? AND t.parent_id IS NULL
      ORDER BY t.date DESC, t.created_at DESC
      LIMIT ?
    `).bind(accountId, limit).all()

  // 平行抓取子交易 (Children)
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

// 刪除交易 API
app.delete('/api/transactions/:id', async (c) => {
    const id = c.req.param('id')
    try {
        await c.env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(id).run()
        return c.json({ success: true })
    } catch (e: any) {
        return c.json({ error: e.message }, 500)
    }
})

app.post('/api/transactions', async (c) => {
  try {
    const body = await c.req.json()
    const main = body.main || body
    const children = body.children || []

    if (!main.date || !main.account_id || main.amount_twd === undefined) {
      return c.json({ error: '缺少必要欄位' }, 400)
    }

    // 1. 寫入主交易
    const result = await c.env.DB.prepare(`
      INSERT INTO transactions (date, account_id, category_id, type, amount_twd, amount_foreign, exchange_rate, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).bind(
      main.date, main.account_id, main.category_id, main.type, main.amount_twd,
      main.amount_foreign || null, main.exchange_rate || 1, main.note
    ).first()

    const parentId = result.id

    // 2. 寫入子交易
    if (children.length > 0 && parentId) {
        const stmt = c.env.DB.prepare(`
            INSERT INTO transactions (date, account_id, category_id, type, amount_twd, note, parent_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        const batch = children.map((child: any) => stmt.bind(
            main.date, main.account_id, child.category_id, main.type, child.amount_twd, child.note, parentId
        ))
        await c.env.DB.batch(batch)
    }
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ==========================================
// [FRONTEND] Vue + Tailwind
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
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap');
        body { font-family: 'Noto Sans TC', sans-serif; }
        input, select { outline: none; }
        /* 美化滾動條 */
        .scroller::-webkit-scrollbar { width: 6px; }
        .scroller::-webkit-scrollbar-track { background: transparent; }
        .scroller::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
        /* 隱藏數字輸入框箭頭 */
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        
        .fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
        .fade-enter-from, .fade-leave-to { opacity: 0; }
      </style>
    </head>
    <body class="bg-slate-50 text-slate-800 h-screen overflow-hidden flex">
      
      <div id="app" class="w-full flex h-full">
        
        <aside class="w-64 bg-slate-900 text-slate-300 flex-col hidden md:flex shrink-0">
          <div class="p-6 text-xl font-bold text-white flex items-center gap-3 border-b border-slate-800">
            <div class="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center text-white text-sm"><i class="fa-solid fa-wallet"></i></div>
            資產管家
          </div>
          <nav class="p-4 space-y-2 flex-1">
             <button @click="changeView('dashboard')" :class="navClass('dashboard')"><i class="fa-solid fa-chart-pie w-5"></i> 總覽</button>
             <button @click="changeView('add')" :class="navClass('add')"><i class="fa-solid fa-circle-plus w-5"></i> 新增記帳</button>
             <button @click="changeView('accounts')" :class="navClass('accounts')"><i class="fa-solid fa-building-columns w-5"></i> 各家銀行</button>
          </nav>
        </aside>

        <main class="flex-1 flex flex-col h-full overflow-hidden relative">
            
            <header class="bg-white p-4 flex justify-between items-center md:hidden border-b border-slate-200 z-20">
                <div class="font-bold text-slate-800 flex items-center gap-2">
                    <div class="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center text-white text-sm"><i class="fa-solid fa-wallet"></i></div>
                    資產管家
                </div>
                <div class="flex bg-slate-100 rounded-lg p-1">
                    <button @click="changeView('dashboard')" :class="mobileNavClass('dashboard')"><i class="fa-solid fa-chart-pie"></i></button>
                    <button @click="changeView('add')" :class="mobileNavClass('add')"><i class="fa-solid fa-plus"></i></button>
                    <button @click="changeView('accounts')" :class="mobileNavClass('accounts')"><i class="fa-solid fa-building-columns"></i></button>
                </div>
            </header>

            <div class="flex-1 overflow-y-auto bg-slate-50 p-4 md:p-8 scroller">
                
                <div v-if="currentView === 'dashboard'" class="max-w-5xl mx-auto">
                    <div class="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl p-8 text-white shadow-xl relative overflow-hidden mb-8">
                        <div class="relative z-10">
                            <div class="text-slate-400 font-medium mb-1">淨資產總額 (TWD估算)</div>
                            <div class="text-4xl font-bold tracking-tight">{{ formatCurrency(totalNetWorth) }}</div>
                        </div>
                        <i class="fa-solid fa-sack-dollar absolute -bottom-6 -right-6 text-9xl text-white opacity-5 rotate-12"></i>
                    </div>
                </div>

                <div v-if="currentView === 'add'" class="max-w-6xl mx-auto h-full flex flex-col lg:flex-row gap-6">
                    
                    <div class="lg:w-1/3 bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col overflow-hidden h-[600px] hidden lg:flex">
                        <div class="p-4 border-b border-slate-100 bg-slate-50 font-bold text-slate-600 text-sm">
                            <i class="fa-solid fa-clock-rotate-left mr-2"></i> {{ selectedAccountName || '近期紀錄' }}
                        </div>
                        <div class="flex-1 overflow-y-auto p-4 space-y-3 scroller">
                            <div v-if="recentTransactions.length===0" class="text-center text-slate-400 py-10 text-sm">無紀錄</div>
                            <div v-for="t in recentTransactions" :key="t.id" class="group relative bg-white border border-slate-100 p-3 rounded-xl hover:shadow-md transition">
                                <div class="flex justify-between items-start">
                                    <span class="text-xs text-slate-400 font-mono">{{ t.date }}</span>
                                    <button @click="deleteTransaction(t.id)" class="text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition px-2">
                                        <i class="fa-solid fa-trash-can"></i>
                                    </button>
                                </div>
                                <div class="flex justify-between items-center mt-1">
                                    <span class="font-bold text-slate-700 text-sm">{{ t.category_name }}</span>
                                    <span :class="['font-mono font-bold', t.type==='INCOME'?'text-emerald-600':'text-rose-600']">
                                        {{ t.type==='EXPENSE'?'-':'+' }}{{ formatAmount(t) }}
                                    </span>
                                </div>
                                <div class="text-xs text-slate-400 mt-1 truncate">{{ t.note }}</div>
                            </div>
                        </div>
                    </div>

                    <div class="lg:w-2/3 bg-white rounded-2xl shadow-lg border border-slate-200 flex flex-col overflow-hidden">
                        <div class="p-6 pb-0">
                            <div class="flex bg-slate-100 p-1.5 rounded-xl">
                                <button v-for="t in ['EXPENSE','INCOME','TRANSFER']" :key="t" @click="form.type=t"
                                    :class="['flex-1 py-2.5 rounded-lg text-sm font-bold transition flex items-center justify-center gap-2', form.type===t ? typeColor(t) + ' text-white shadow-sm' : 'text-slate-500 hover:text-slate-700']">
                                    <i :class="typeIcon(t)"></i> {{ typeName(t) }}
                                </button>
                            </div>
                        </div>

                        <div class="p-6 grid gap-6 overflow-y-auto flex-1 scroller">
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="text-xs font-bold text-slate-400 uppercase mb-1 block">日期</label>
                                    <input type="date" v-model="form.date" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500 transition">
                                </div>
                                <div>
                                    <label class="text-xs font-bold text-slate-400 uppercase mb-1 block">帳戶</label>
                                    <select v-model="form.account_id" @change="fetchRecent" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500 transition">
                                        <option v-for="acc in accounts" :key="acc.id" :value="acc.id">{{ acc.name }} ({{ acc.currency }})</option>
                                    </select>
                                </div>
                            </div>

                            <div>
                                <div class="flex justify-between items-end mb-1">
                                    <label class="text-xs font-bold text-slate-400 uppercase">金額 ({{ currentCurrency }})</label>
                                    <label class="flex items-center gap-2 cursor-pointer">
                                        <input type="checkbox" v-model="isDetailMode" class="w-4 h-4 rounded text-blue-600 focus:ring-blue-500">
                                        <span class="text-xs font-bold text-slate-600">輸入明細模式</span>
                                    </label>
                                </div>
                                <div class="relative">
                                    <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-mono text-xl">$</span>
                                    <input type="number" v-model="form.amount_twd" :readonly="isDetailMode" 
                                        :class="['w-full rounded-xl px-4 py-4 pl-10 text-3xl font-mono font-bold outline-none transition', isDetailMode ? 'bg-slate-100 text-slate-500 cursor-not-allowed' : 'bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-blue-500 text-slate-800']" placeholder="0">
                                </div>
                                <div v-if="isDetailMode" class="text-right text-xs text-blue-500 mt-1 font-medium">
                                    <i class="fa-solid fa-circle-info"></i> 金額將依據下方明細自動加總
                                </div>
                            </div>

                            <transition name="fade">
                                <div v-if="isDetailMode" class="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-3">
                                    <div class="flex justify-between items-center text-xs font-bold text-slate-500 uppercase">
                                        <span>明細項目 ({{ form.children.length }})</span>
                                        <button @click="addChild" class="text-blue-600 hover:bg-blue-50 px-2 py-1 rounded transition"><i class="fa-solid fa-plus"></i> 新增一列</button>
                                    </div>
                                    
                                    <div v-for="(child, idx) in form.children" :key="idx" class="flex gap-2 items-center">
                                        <select v-model="child.category_id" class="w-1/3 bg-white border border-slate-200 rounded-lg px-2 py-2 text-sm focus:border-blue-500">
                                            <option value="" disabled>分類</option>
                                            <option v-for="c in filteredCategories" :key="c.id" :value="c.id">{{ c.name }}</option>
                                        </select>
                                        <input type="text" v-model="child.note" placeholder="備註..." class="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-500">
                                        <input type="number" v-model="child.amount_twd" placeholder="0" class="w-24 bg-white border border-slate-200 rounded-lg px-2 py-2 text-sm text-right font-mono focus:border-blue-500">
                                        <button @click="removeChild(idx)" class="text-slate-400 hover:text-rose-500 w-6"><i class="fa-solid fa-xmark"></i></button>
                                    </div>
                                    <div v-if="form.children.length === 0" class="text-center text-slate-400 text-sm py-4">請點擊右上方新增明細</div>
                                </div>
                            </transition>

                            <div v-if="!isDetailMode" class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="text-xs font-bold text-slate-400 uppercase mb-1 block">分類</label>
                                    <select v-model="form.category_id" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500">
                                        <option value="" disabled>選擇分類</option>
                                        <option v-for="c in filteredCategories" :key="c.id" :value="c.id">{{ c.name }}</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="text-xs font-bold text-slate-400 uppercase mb-1 block">備註</label>
                                    <input type="text" v-model="form.note" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500">
                                </div>
                            </div>
                        </div>

                        <div class="p-4 border-t border-slate-100 bg-slate-50 flex justify-end">
                            <button @click="submit" :disabled="isSubmitting" class="w-full md:w-auto bg-slate-900 text-white px-8 py-3.5 rounded-xl font-bold shadow-lg active:scale-95 transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                                <span v-if="isSubmitting"><i class="fa-solid fa-spinner fa-spin"></i> 處理中...</span>
                                <span v-else>確認記帳 <i class="fa-solid fa-check ml-1"></i></span>
                            </button>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'accounts'" class="max-w-6xl mx-auto">
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div v-for="acc in accounts" :key="acc.id" @click="openDetail(acc)"
                            class="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm cursor-pointer hover:border-blue-400 hover:shadow-md transition relative overflow-hidden group">
                            <div class="flex justify-between items-center mb-4 relative z-10">
                                <div class="font-bold text-slate-700 text-lg">{{ acc.name }}</div>
                                <span class="bg-slate-100 text-slate-500 text-xs font-bold px-2 py-1 rounded">{{ acc.currency }}</span>
                            </div>
                            <div class="relative z-10">
                                <div class="text-3xl font-mono font-bold" :class="acc.balance_twd < 0 ? 'text-rose-600' : 'text-slate-800'">
                                    {{ formatCurrency(acc.balance_twd, acc.currency) }}
                                </div>
                                <div class="text-xs text-slate-400 mt-1">目前餘額</div>
                            </div>
                            <i class="fa-solid fa-building-columns absolute -bottom-4 -right-4 text-8xl text-slate-50 group-hover:text-blue-50 transition"></i>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'account_detail'" class="max-w-4xl mx-auto h-full flex flex-col">
                    <div class="bg-white rounded-2xl shadow-lg border border-slate-200 flex-1 flex flex-col overflow-hidden">
                        <div class="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                            <button @click="currentView='accounts'" class="text-slate-500 hover:text-slate-800 font-bold text-sm"><i class="fa-solid fa-arrow-left mr-1"></i> 返回列表</button>
                            <span class="font-bold text-slate-800">{{ currentAccount?.name }}</span>
                        </div>
                        <div class="flex-1 overflow-y-auto scroller">
                            <table class="w-full text-left">
                                <thead class="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0 z-10">
                                    <tr>
                                        <th class="p-4 w-10"></th>
                                        <th class="p-4">日期</th>
                                        <th class="p-4">說明</th>
                                        <th class="p-4 text-right">金額</th>
                                        <th class="p-4 w-10"></th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-slate-50">
                                    <template v-for="t in detailTransactions" :key="t.id">
                                        <tr class="hover:bg-slate-50 group cursor-pointer" @click="t.expanded = !t.expanded">
                                            <td class="p-4 text-center"><i v-if="t.children?.length" :class="['fa-solid text-xs text-slate-300 transition', t.expanded?'fa-chevron-down':'fa-chevron-right']"></i></td>
                                            <td class="p-4 text-sm text-slate-500">{{ t.date }}</td>
                                            <td class="p-4">
                                                <div class="font-bold text-slate-700 text-sm">{{ t.children?.length ? t.note || '多筆交易' : t.category_name }}</div>
                                                <div class="text-xs text-slate-400" v-if="t.children?.length">{{ t.children.length }} 筆明細</div>
                                            </td>
                                            <td :class="['p-4 text-right font-mono font-bold', t.type==='INCOME'?'text-emerald-600':'text-rose-600']">
                                                {{ t.type==='EXPENSE'?'-':'+' }}{{ formatCurrency(t.amount_twd, currentAccount?.currency) }}
                                            </td>
                                            <td class="p-4 text-center">
                                                <button @click.stop="deleteTransaction(t.id)" class="text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition"><i class="fa-solid fa-trash-can"></i></button>
                                            </td>
                                        </tr>
                                        <tr v-if="t.expanded && t.children?.length" class="bg-slate-50/50">
                                            <td colspan="5" class="p-2 pl-16 pr-4">
                                                <div class="space-y-1">
                                                    <div v-for="child in t.children" :key="child.id" class="flex justify-between text-xs text-slate-500 py-1 border-b border-slate-100 last:border-0">
                                                        <span>{{ child.category_name }} <span class="text-slate-400 ml-1">{{ child.note }}</span></span>
                                                        <span class="font-mono">{{ formatCurrency(child.amount_twd, currentAccount?.currency) }}</span>
                                                    </div>
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
        const { createApp, ref, computed, onMounted, watch } = Vue

        createApp({
            setup() {
                const currentView = ref('accounts')
                const isSubmitting = ref(false)
                const isDetailMode = ref(false) // 明細模式開關
                
                const categories = ref([])
                const accounts = ref([])
                const recentTransactions = ref([])
                const detailTransactions = ref([])
                const currentAccount = ref(null)

                const form = ref({
                    date: new Date().toISOString().split('T')[0],
                    account_id: '',
                    type: 'EXPENSE',
                    category_id: '',
                    amount_twd: '',
                    note: '',
                    children: [] 
                })

                // 自動加總邏輯 (重要)
                watch(() => form.value.children, (newVal) => {
                    if (isDetailMode.value) {
                        const sum = newVal.reduce((acc, curr) => acc + (Number(curr.amount_twd) || 0), 0)
                        form.value.amount_twd = sum > 0 ? sum : ''
                    }
                }, { deep: true })

                watch(isDetailMode, (val) => {
                    if (val && form.value.children.length === 0) addChild()
                    if (!val) form.value.children = []
                })

                const typeName = (t) => ({'EXPENSE':'支出','INCOME':'收入','TRANSFER':'轉帳'}[t])
                const typeColor = (t) => ({'EXPENSE':'bg-rose-500','INCOME':'bg-emerald-500','TRANSFER':'bg-blue-500'}[t])
                const typeIcon = (t) => ({'EXPENSE':'fa-solid fa-arrow-trend-down','INCOME':'fa-solid fa-arrow-trend-up','TRANSFER':'fa-solid fa-arrow-right-arrow-left'}[t])
                
                const navClass = (v) => ['w-full text-left px-4 py-3 rounded-xl flex items-center gap-3 transition font-medium', (currentView.value===v || (v==='accounts'&&currentView.value==='account_detail')) ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/20' : 'text-slate-400 hover:bg-slate-800 hover:text-white']
                const mobileNavClass = (v) => ['px-4 py-2 rounded-md text-xl transition', (currentView.value===v || (v==='accounts'&&currentView.value==='account_detail')) ? 'bg-white shadow-sm text-emerald-600' : 'text-slate-400']

                const currentCurrency = computed(() => accounts.value.find(a => a.id === form.value.account_id)?.currency || 'TWD')
                const selectedAccountName = computed(() => accounts.value.find(a => a.id === form.value.account_id)?.name)
                const filteredCategories = computed(() => categories.value.filter(c => c.type === form.value.type))
                
                const formatCurrency = (val, cur='TWD') => {
                    if(val===undefined||val===null) return '-'
                    return new Intl.NumberFormat('zh-TW', { style: 'currency', currency: cur, minimumFractionDigits: 0 }).format(val)
                }
                const formatAmount = (t) => formatCurrency(t.amount_twd, accounts.value.find(a=>a.id===t.account_id)?.currency)
                
                const totalNetWorth = computed(() => accounts.value.reduce((sum, acc) => {
                    let rate = 1
                    if(acc.currency === 'JPY') rate = 0.21
                    if(acc.currency === 'USD') rate = 32
                    return sum + (acc.balance_twd || 0) * (acc.currency === 'TWD' ? 1 : rate) 
                }, 0))

                const addChild = () => form.value.children.push({ category_id: '', amount_twd: '', note: '' })
                const removeChild = (idx) => form.value.children.splice(idx, 1)

                const fetchData = async () => {
                    const [c, a] = await Promise.all([fetch('/api/categories').then(r=>r.json()), fetch('/api/accounts').then(r=>r.json())])
                    categories.value = c
                    accounts.value = a
                    if(!form.value.account_id && a.length > 0) form.value.account_id = a[0].id
                }

                const fetchRecent = async () => {
                    if(!form.value.account_id) return
                    const res = await fetch(\`/api/transactions?account_id=\${form.value.account_id}&limit=20\`)
                    recentTransactions.value = await res.json()
                }

                const changeView = (v) => {
                    currentView.value = v
                    if(v==='accounts') fetchData()
                    if(v==='add' && !form.value.account_id && accounts.value.length>0) form.value.account_id = accounts.value[0].id
                }

                const openDetail = async (acc) => {
                    currentAccount.value = acc
                    currentView.value = 'account_detail'
                    const res = await fetch(\`/api/transactions?account_id=\${acc.id}&limit=100\`)
                    const data = await res.json()
                    detailTransactions.value = data.map(t => ({...t, expanded: false}))
                }

                const deleteTransaction = async (id) => {
                    if(!confirm('確定要刪除這筆交易嗎？金額將自動復原。')) return
                    try {
                        const res = await fetch(\`/api/transactions/\${id}\`, { method: 'DELETE' })
                        if(res.ok) {
                            fetchRecent()
                            fetchData()
                            if(currentView.value === 'account_detail' && currentAccount.value) openDetail(currentAccount.value)
                        } else {
                            alert('刪除失敗')
                        }
                    } catch(e) { alert('連線錯誤') }
                }

                const submit = async () => {
                    if(!form.value.account_id || !form.value.amount_twd) return alert('請輸入完整金額')
                    
                    isSubmitting.value = true
                    try {
                        const payload = {
                            main: { ...form.value }, 
                            children: isDetailMode.value ? form.value.children.filter(c => c.amount_twd) : []
                        }
                        const res = await fetch('/api/transactions', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify(payload)
                        })
                        if(res.ok) {
                            form.value.amount_twd = ''
                            form.value.children = []
                            form.value.note = ''
                            if(isDetailMode.value) addChild()
                            fetchRecent()
                            fetchData() 
                            alert('記帳成功')
                        } else {
                            const err = await res.json()
                            alert('錯誤: ' + err.error)
                        }
                    } catch(e) { console.error(e); alert('連線錯誤') } 
                    finally { isSubmitting.value = false }
                }

                onMounted(() => { fetchData(); if(window.innerWidth < 768) currentView.value = 'dashboard' })

                return {
                    currentView, isSubmitting, isDetailMode,
                    categories, accounts, recentTransactions, detailTransactions, currentAccount,
                    form, currentCurrency, filteredCategories, totalNetWorth, selectedAccountName,
                    navClass, mobileNavClass, typeName, typeColor, typeIcon, formatCurrency, formatAmount,
                    addChild, removeChild, changeView, openDetail, fetchRecent, submit, deleteTransaction
                }
            }
        }).mount('#app')
      </script>
    </body>
    </html>
  `)
})

export default app