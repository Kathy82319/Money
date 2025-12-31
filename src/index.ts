import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// ==========================================
// 1. 後端 API 區域
// ==========================================

// [GET] 取得分類
app.get('/api/categories', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM categories ORDER BY type, id').all()
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// [GET] 取得帳戶列表 (含餘額)
app.get('/api/accounts', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM accounts ORDER BY type, id').all()
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// [GET] 取得交易明細 (支援分頁、抓取子交易)
app.get('/api/transactions', async (c) => {
  const accountId = c.req.query('account_id')
  const limit = c.req.query('limit') || '50'
  
  if (!accountId) return c.json([])

  try {
    // 1. 先抓出主交易 (parent_id IS NULL)
    const { results: parents } = await c.env.DB.prepare(`
      SELECT t.*, c.name as category_name 
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.account_id = ? AND t.parent_id IS NULL
      ORDER BY t.date DESC, t.created_at DESC
      LIMIT ?
    `).bind(accountId, limit).all()

    // 2. 為了簡單，我們再對這些主交易去抓它們的子交易 (若有效能問題未來可優化)
    // 這裡用 Promise.all 平行處理
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
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// [POST] 新增交易 (支援批次寫入子交易)
app.post('/api/transactions', async (c) => {
  try {
    const body = await c.req.json() // 預期格式: { main: {...}, children: [...] }
    
    // 相容性處理：如果傳來的是舊格式(直接物件)，轉成新格式
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
      main.date,
      main.account_id,
      main.category_id,
      main.type,
      main.amount_twd,
      main.amount_foreign || null,
      main.exchange_rate || 1,
      main.note
    ).first()

    const parentId = result.id

    // 2. 如果有子交易，寫入子交易
    if (children.length > 0 && parentId) {
        const stmt = c.env.DB.prepare(`
            INSERT INTO transactions (date, account_id, category_id, type, amount_twd, note, parent_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        const batch = children.map((child: any) => stmt.bind(
            main.date, // 子交易沿用主交易日期
            main.account_id,
            child.category_id,
            main.type, // 沿用類型(支出)
            child.amount_twd,
            child.note,
            parentId
        ))
        await c.env.DB.batch(batch)
    }

    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ==========================================
// 2. 前端介面區域 (Vue + Tailwind)
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
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }
        /* 避免 iOS 輸入框放大 */
        input, select, textarea { font-size: 16px !important; }
      </style>
    </head>
    <body class="bg-slate-100 text-slate-800 font-sans h-screen overflow-hidden select-none">
      
      <div id="app" class="flex h-full">
        
        <aside class="w-64 bg-slate-900 text-slate-300 flex flex-col shadow-xl z-20 hidden md:flex">
          <div class="p-6 text-xl font-bold text-white tracking-wider border-b border-slate-700 flex items-center gap-2">
            <i class="fa-solid fa-wallet text-emerald-400"></i> 資產管家
          </div>
          <nav class="flex-1 p-4 space-y-2">
             <button @click="changeView('dashboard')" :class="navClass('dashboard')"><i class="fa-solid fa-chart-pie w-6 text-center"></i> 總覽</button>
             <button @click="changeView('add')" :class="navClass('add')"><i class="fa-solid fa-circle-plus w-6 text-center"></i> 新增記帳</button>
             <button @click="changeView('accounts')" :class="navClass('accounts')"><i class="fa-solid fa-building-columns w-6 text-center"></i> 各家銀行</button>
          </nav>
        </aside>

        <main class="flex-1 flex flex-col h-full overflow-hidden bg-slate-50 relative">
            <header class="bg-white shadow-sm p-3 flex justify-between items-center md:hidden shrink-0 z-10">
                <div class="font-bold text-slate-800 flex items-center gap-2">
                    <i class="fa-solid fa-wallet text-emerald-600"></i> 資產管家
                </div>
                <div class="flex gap-2 bg-slate-100 p-1 rounded-lg">
                    <button @click="changeView('dashboard')" :class="['px-3 py-1 rounded', currentView==='dashboard'?'bg-white shadow text-emerald-600':'text-slate-400']"><i class="fa-solid fa-chart-pie"></i></button>
                    <button @click="changeView('add')" :class="['px-3 py-1 rounded', currentView==='add'?'bg-white shadow text-emerald-600':'text-slate-400']"><i class="fa-solid fa-plus"></i></button>
                    <button @click="changeView('accounts')" :class="['px-3 py-1 rounded', currentView==='accounts' || currentView==='account_detail'?'bg-white shadow text-emerald-600':'text-slate-400']"><i class="fa-solid fa-building-columns"></i></button>
                </div>
            </header>

            <div class="flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar">
                
                <div v-if="currentView === 'dashboard'" class="max-w-5xl mx-auto space-y-6">
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div class="bg-gradient-to-br from-slate-800 to-slate-900 p-6 rounded-2xl shadow-lg text-white relative overflow-hidden">
                            <div class="text-slate-400 text-sm mb-1">淨資產總額 (TWD估算)</div>
                            <div class="text-3xl font-bold tracking-tight">{{ formatCurrency(totalNetWorth, 'TWD') }}</div>
                            <i class="fa-solid fa-shield-cat absolute -bottom-4 -right-4 text-8xl text-white opacity-5"></i>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'add'" class="max-w-6xl mx-auto h-full flex flex-col">
                    <div class="flex flex-col lg:flex-row gap-6 h-full">
                        <div class="lg:w-1/3 bg-slate-200/50 rounded-xl p-4 overflow-hidden flex flex-col border border-slate-200 hidden lg:flex">
                            <div class="font-bold text-slate-700 mb-4 text-sm uppercase tracking-wider">
                                <i class="fa-solid fa-history mr-2"></i> {{ selectedAccountName || '近期明細' }}
                            </div>
                            <div class="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                                <div v-for="t in recentTransactions" :key="t.id" class="bg-white p-3 rounded-lg shadow-sm border-l-4 text-sm"
                                    :class="t.type === 'INCOME' ? 'border-emerald-400' : 'border-rose-400'">
                                    <div class="flex justify-between font-bold">
                                        <span>{{ t.category_name }}</span>
                                        <span :class="t.type==='INCOME'?'text-emerald-600':'text-rose-600'">{{ formatAmount(t) }}</span>
                                    </div>
                                    <div class="flex justify-between text-slate-400 text-xs mt-1">
                                        <span>{{ t.date }}</span>
                                        <span class="truncate max-w-[120px]">{{ t.note }}</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="lg:w-2/3 bg-white rounded-xl shadow-lg border border-slate-200 flex flex-col overflow-hidden">
                            <div class="p-4 md:p-6 grid grid-cols-1 gap-4 overflow-y-auto custom-scrollbar flex-1">
                                <div class="grid grid-cols-2 gap-4">
                                    <div>
                                        <label class="text-xs font-bold text-slate-500 uppercase">日期</label>
                                        <input type="date" v-model="form.date" class="input-field mt-1">
                                    </div>
                                    <div>
                                        <label class="text-xs font-bold text-slate-500 uppercase">帳戶</label>
                                        <select v-model="form.account_id" @change="fetchRecent" class="input-field mt-1">
                                            <option v-for="acc in accounts" :key="acc.id" :value="acc.id">{{ acc.name }} ({{ acc.currency }})</option>
                                        </select>
                                    </div>
                                </div>

                                <div class="flex bg-slate-100 p-1 rounded-lg">
                                    <button v-for="t in ['EXPENSE','INCOME','TRANSFER']" :key="t" @click="form.type=t" 
                                        :class="['flex-1 py-2 rounded-md text-sm font-bold transition', form.type===t ? typeColor(t) + ' text-white shadow' : 'text-slate-500 hover:text-slate-700']">
                                        {{ typeName(t) }}
                                    </button>
                                </div>

                                <div>
                                    <label class="text-xs font-bold text-slate-500 uppercase">總金額 ({{ currentCurrency }})</label>
                                    <input type="number" v-model="form.amount_twd" placeholder="0" class="input-field mt-1 text-3xl font-mono font-bold text-slate-700">
                                </div>

                                <div class="bg-slate-50 rounded-lg p-3 border border-slate-200 space-y-3">
                                    <div class="flex justify-between items-center">
                                        <label class="text-xs font-bold text-slate-500 uppercase flex items-center">
                                            <i class="fa-solid fa-list-ul mr-1"></i> 明細項目 (選填)
                                            <span class="ml-2 bg-slate-200 text-slate-600 px-2 py-0.5 rounded text-[10px]" v-if="childrenTotal > 0">
                                                細項總計: {{ formatCurrency(childrenTotal, currentCurrency) }}
                                            </span>
                                        </label>
                                        <button @click="addChild" class="text-xs bg-white border border-slate-300 px-2 py-1 rounded hover:bg-slate-50">
                                            <i class="fa-solid fa-plus"></i> 新增一列
                                        </button>
                                    </div>

                                    <div v-for="(child, idx) in form.children" :key="idx" class="flex gap-2 items-center animate-fade-in">
                                        <select v-model="child.category_id" class="input-field text-sm w-1/3">
                                            <option value="" disabled>分類</option>
                                            <option v-for="c in filteredCategories" :key="c.id" :value="c.id">{{ c.name }}</option>
                                        </select>
                                        <input type="text" v-model="child.note" placeholder="備註" class="input-field text-sm flex-1">
                                        <input type="number" v-model="child.amount_twd" placeholder="$" class="input-field text-sm w-20 font-mono">
                                        <button @click="removeChild(idx)" class="text-slate-400 hover:text-rose-500 px-1"><i class="fa-solid fa-xmark"></i></button>
                                    </div>
                                    
                                    <div v-if="form.children.length === 0" class="text-center text-slate-300 text-xs py-2 italic">
                                        無細項 (將直接記錄為主交易分類)
                                    </div>
                                </div>

                                <div v-if="form.children.length === 0" class="grid grid-cols-2 gap-4">
                                    <div>
                                        <label class="text-xs font-bold text-slate-500 uppercase">主分類</label>
                                        <select v-model="form.category_id" class="input-field mt-1">
                                            <option v-for="c in filteredCategories" :key="c.id" :value="c.id">{{ c.name }}</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label class="text-xs font-bold text-slate-500 uppercase">主備註</label>
                                        <input type="text" v-model="form.note" class="input-field mt-1">
                                    </div>
                                </div>
                            </div>

                            <div class="p-4 border-t border-slate-100 bg-slate-50 flex justify-between items-center">
                                <div class="text-xs text-rose-500 font-bold" v-if="childSumError">
                                    ⚠️ 細項總和不等於總金額
                                </div>
                                <div v-else></div>
                                <button @click="submit" :disabled="isSubmitting" class="bg-slate-900 text-white px-6 py-3 rounded-xl font-bold shadow-lg active:scale-95 transition flex items-center gap-2">
                                    <span v-if="isSubmitting"><i class="fa-solid fa-spinner fa-spin"></i></span>
                                    <span v-else>確認記帳 <i class="fa-solid fa-check"></i></span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'accounts'" class="max-w-6xl mx-auto">
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        <div v-for="acc in accounts" :key="acc.id" @click="openDetail(acc)"
                            class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden cursor-pointer hover:border-blue-400 transition group">
                            <div class="flex justify-between items-start relative z-10">
                                <div class="font-bold text-slate-700 text-lg">{{ acc.name }}</div>
                                <div class="text-xs font-bold bg-slate-100 px-2 py-1 rounded text-slate-500">{{ acc.currency }}</div>
                            </div>
                            <div class="mt-4 relative z-10">
                                <div class="text-2xl font-mono font-bold" :class="acc.balance_twd < 0 ? 'text-rose-600' : 'text-slate-800'">
                                    {{ formatCurrency(acc.balance_twd, acc.currency) }}
                                </div>
                                <div class="text-xs text-slate-400 mt-1">當前餘額</div>
                            </div>
                            <i class="fa-solid fa-building-columns absolute -bottom-2 -right-2 text-6xl text-slate-50 group-hover:text-blue-50 transition"></i>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'account_detail'" class="max-w-4xl mx-auto h-full flex flex-col">
                    <div class="bg-white rounded-xl shadow-sm border border-slate-200 flex-1 flex flex-col overflow-hidden">
                        <div class="p-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center shrink-0">
                            <button @click="currentView='accounts'" class="text-slate-500 hover:text-slate-800"><i class="fa-solid fa-arrow-left mr-1"></i> 返回</button>
                            <div class="font-bold text-slate-800">{{ currentAccount?.name }}</div>
                        </div>
                        <div class="flex-1 overflow-y-auto p-0 custom-scrollbar">
                            <div v-for="t in detailTransactions" :key="t.id" class="border-b border-slate-50 last:border-0">
                                <div class="p-4 hover:bg-slate-50 flex items-center justify-between cursor-pointer" @click="t.expanded = !t.expanded">
                                    <div class="flex items-center gap-3">
                                        <div class="w-8 text-center text-slate-300">
                                            <i v-if="t.children && t.children.length > 0" :class="['fa-solid transition', t.expanded ? 'fa-angle-down text-slate-600' : 'fa-angle-right']"></i>
                                        </div>
                                        <div>
                                            <div class="text-xs text-slate-400">{{ t.date }}</div>
                                            <div class="font-bold text-slate-700 text-sm">{{ t.children?.length > 0 ? t.note || '多筆交易' : t.category_name }}</div>
                                            <div class="text-xs text-slate-400" v-if="t.children?.length > 0">{{ t.children.length }} 筆細項</div>
                                        </div>
                                    </div>
                                    <div :class="['font-mono font-bold', t.type==='INCOME'?'text-emerald-600':'text-rose-600']">
                                        {{ t.type==='EXPENSE'?'-':'+' }}{{ formatCurrency(t.amount_twd, currentAccount?.currency) }}
                                    </div>
                                </div>
                                <div v-if="t.expanded && t.children?.length > 0" class="bg-slate-50 border-y border-slate-100 pl-14 pr-4 py-2 space-y-2">
                                    <div v-for="child in t.children" :key="child.id" class="flex justify-between text-sm items-center">
                                        <div class="flex items-center gap-2">
                                            <span class="text-xs bg-white border px-1 rounded text-slate-500">{{ child.category_name }}</span>
                                            <span class="text-slate-600">{{ child.note }}</span>
                                        </div>
                                        <div class="font-mono text-slate-500">{{ formatCurrency(child.amount_twd, currentAccount?.currency) }}</div>
                                    </div>
                                </div>
                            </div>
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
                
                const categories = ref([])
                const accounts = ref([])
                const recentTransactions = ref([])
                const detailTransactions = ref([])
                const currentAccount = ref(null)

                // Form Data
                const form = ref({
                    date: new Date().toISOString().split('T')[0],
                    account_id: '',
                    type: 'EXPENSE',
                    category_id: '',
                    amount_twd: '',
                    note: '',
                    children: [] // { category_id, amount_twd, note }
                })

                // Helpers
                const typeName = (t) => ({'EXPENSE':'支出','INCOME':'收入','TRANSFER':'轉帳'}[t])
                const typeColor = (t) => ({'EXPENSE':'bg-rose-500','INCOME':'bg-emerald-500','TRANSFER':'bg-blue-500'}[t])
                const navClass = (view) => ['w-full text-left px-4 py-3 rounded-lg flex items-center gap-3 transition', (currentView.value===view || (view==='accounts' && currentView.value==='account_detail')) ? 'bg-emerald-600 text-white shadow-lg' : 'hover:bg-slate-800 hover:text-white']
                
                const currentCurrency = computed(() => accounts.value.find(a => a.id === form.value.account_id)?.currency || 'TWD')
                const selectedAccountName = computed(() => accounts.value.find(a => a.id === form.value.account_id)?.name)
                const filteredCategories = computed(() => categories.value.filter(c => c.type === form.value.type))
                
                // Currency Formatter
                const formatCurrency = (val, currency = 'TWD') => {
                    if(val === undefined || val === null) return '-'
                    return new Intl.NumberFormat('zh-TW', { style: 'currency', currency: currency, minimumFractionDigits: 0 }).format(val)
                }
                const formatAmount = (t) => formatCurrency(t.amount_twd, accounts.value.find(a=>a.id===t.account_id)?.currency)
                
                // Child transactions logic
                const childrenTotal = computed(() => form.value.children.reduce((sum, c) => sum + (Number(c.amount_twd)||0), 0))
                const childSumError = computed(() => form.value.children.length > 0 && Math.abs(childrenTotal.value - form.value.amount_twd) > 1)
                
                const addChild = () => form.value.children.push({ category_id: '', amount_twd: '', note: '' })
                const removeChild = (idx) => form.value.children.splice(idx, 1)

                // Total Net Worth (Simple estimate)
                const totalNetWorth = computed(() => accounts.value.reduce((sum, acc) => {
                    // 這裡簡化處理：假設日幣匯率 0.21，美金 30 (實際專案應從DB抓匯率)
                    let rate = 1
                    if(acc.currency === 'JPY') rate = 0.21
                    if(acc.currency === 'USD') rate = 31
                    return sum + (acc.balance_twd || 0) * (acc.currency === 'TWD' ? 1 : 1) // 目前 DB balance_twd 已經存了台幣等值，若您有外幣邏輯需調整
                }, 0))

                // API Calls
                const fetchData = async () => {
                    const [c, a] = await Promise.all([fetch('/api/categories').then(r=>r.json()), fetch('/api/accounts').then(r=>r.json())])
                    categories.value = c
                    accounts.value = a
                    // Default select first account
                    if(!form.value.account_id && a.length > 0) form.value.account_id = a[0].id
                }

                const fetchRecent = async () => {
                    if(!form.value.account_id) return
                    const res = await fetch(\`/api/transactions?account_id=\${form.value.account_id}&limit=10\`)
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
                    const res = await fetch(\`/api/transactions?account_id=\${acc.id}&limit=50\`)
                    const data = await res.json()
                    // Add expanded state
                    detailTransactions.value = data.map(t => ({...t, expanded: false}))
                }

                const submit = async () => {
                    if(!form.value.account_id || !form.value.amount_twd) return alert('金額或帳戶未填')
                    if(childSumError.value) return alert('細項總和與總金額不符')
                    
                    isSubmitting.value = true
                    try {
                        const payload = {
                            main: { ...form.value }, // 包含 type, date, account_id, amount_twd
                            children: form.value.children.filter(c => c.amount_twd) // 過濾空行
                        }
                        
                        const res = await fetch('/api/transactions', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify(payload)
                        })
                        if(res.ok) {
                            alert('記帳成功')
                            form.value.amount_twd = ''
                            form.value.children = []
                            form.value.note = ''
                            fetchRecent()
                            fetchData() // Update balance
                        } else {
                            const err = await res.json()
                            alert('錯誤: ' + err.error)
                        }
                    } catch(e) { console.error(e); alert('連線錯誤') } 
                    finally { isSubmitting.value = false }
                }

                onMounted(fetchData)

                return {
                    currentView, isSubmitting, categories, accounts, recentTransactions, detailTransactions, currentAccount,
                    form, currentCurrency, filteredCategories, totalNetWorth, selectedAccountName,
                    childrenTotal, childSumError, addChild, removeChild,
                    navClass, typeName, typeColor, formatCurrency, formatAmount,
                    changeView, openDetail, fetchRecent, submit
                }
            }
        }).mount('#app')
      </script>
    </body>
    </html>
  `)
})

export default app