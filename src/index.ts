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

// [GET] 取得特定帳戶的交易明細 (支援月份篩選)
app.get('/api/transactions', async (c) => {
  const accountId = c.req.query('account_id')
  const limit = c.req.query('limit') || '50' // 預設抓 50 筆
  
  if (!accountId) return c.json([])

  try {
    // 這裡做了 JOIN 連線，把分類名稱一起抓出來
    const { results } = await c.env.DB.prepare(`
      SELECT t.*, c.name as category_name 
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.account_id = ?
      ORDER BY t.date DESC, t.created_at DESC
      LIMIT ?
    `).bind(accountId, limit).all()
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// [POST] 新增交易
app.post('/api/transactions', async (c) => {
  try {
    const body = await c.req.json()
    if (!body.date || !body.account_id || !body.amount_twd) {
      return c.json({ error: '缺少必要欄位' }, 400)
    }

    await c.env.DB.prepare(`
      INSERT INTO transactions (date, account_id, category_id, type, amount_twd, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      body.date,
      body.account_id,
      body.category_id,
      body.type,
      body.amount_twd,
      body.note
    ).run()

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
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>我的資產管理</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
      <style>
        input[type=number]::-webkit-inner-spin-button, 
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
      </style>
    </head>
    <body class="bg-slate-100 text-slate-800 font-sans h-screen overflow-hidden">
      
      <div id="app" class="flex h-full">
        
        <aside class="w-64 bg-slate-900 text-slate-300 flex flex-col shadow-xl z-20 hidden md:flex">
          <div class="p-6 text-xl font-bold text-white tracking-wider border-b border-slate-700 flex items-center gap-2">
            <i class="fa-solid fa-wallet text-emerald-400"></i>
            資產管家
          </div>
          <nav class="flex-1 p-4 space-y-2">
             <button @click="changeView('dashboard')" :class="navClass('dashboard')">
                <i class="fa-solid fa-chart-pie w-6 text-center"></i> 總覽
             </button>
             <button @click="changeView('add')" :class="navClass('add')">
                <i class="fa-solid fa-circle-plus w-6 text-center"></i> 新增記帳
             </button>
             <button @click="changeView('accounts')" :class="navClass('accounts')">
                <i class="fa-solid fa-building-columns w-6 text-center"></i> 各家銀行
             </button>
          </nav>
        </aside>

        <main class="flex-1 flex flex-col h-full overflow-hidden bg-slate-50">
            <header class="bg-white shadow-sm p-4 flex justify-between items-center md:hidden shrink-0">
                <div class="font-bold text-slate-800">資產管家</div>
                <div class="flex gap-4">
                    <button @click="changeView('add')" class="text-emerald-600"><i class="fa-solid fa-plus-circle text-xl"></i></button>
                    <button @click="changeView('accounts')" class="text-slate-600"><i class="fa-solid fa-building-columns text-xl"></i></button>
                </div>
            </header>

            <div class="flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar">
                
                <div v-if="currentView === 'dashboard'" class="max-w-5xl mx-auto space-y-6">
                    <h2 class="text-2xl font-bold text-slate-800 mb-6">資產總覽</h2>
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div class="bg-white p-6 rounded-xl shadow-sm border-l-4 border-emerald-500">
                            <div class="text-slate-500 text-sm">淨資產 (TWD)</div>
                            <div class="text-3xl font-bold text-emerald-700">{{ formatCurrency(totalNetWorth) }}</div>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'add'" class="max-w-6xl mx-auto h-full flex flex-col">
                    <h2 class="text-2xl font-bold text-slate-800 mb-6 flex items-center">
                        <i class="fa-solid fa-pen-to-square mr-3 text-slate-400"></i> 新增交易
                    </h2>
                    
                    <div class="flex flex-col lg:flex-row gap-6 min-h-[500px]">
                        <div class="lg:w-1/3 bg-slate-200 rounded-xl p-4 overflow-hidden flex flex-col border border-slate-300">
                            <div class="font-bold text-slate-700 mb-4 flex items-center justify-between">
                                <span><i class="fa-solid fa-clock-rotate-left mr-2"></i> 近期明細</span>
                                <span v-if="selectedAccountName" class="text-xs bg-slate-600 text-white px-2 py-1 rounded">{{ selectedAccountName }}</span>
                            </div>
                            <div class="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                                <div v-if="recentTransactions.length === 0" class="text-center text-slate-400 py-10 text-sm">
                                    <span v-if="!form.account_id">請先選擇銀行</span>
                                    <span v-else>無近期紀錄</span>
                                </div>
                                <div v-for="t in recentTransactions" :key="t.id" class="bg-white p-3 rounded shadow-sm border-l-4"
                                    :class="t.type === 'INCOME' ? 'border-emerald-400' : 'border-rose-400'">
                                    <div class="flex justify-between items-start">
                                        <div class="text-xs text-slate-500">{{ t.date }}</div>
                                        <div class="font-bold font-mono" :class="t.type === 'INCOME' ? 'text-emerald-600' : 'text-rose-600'">
                                            {{ t.type === 'EXPENSE' ? '-' : '+' }}{{ formatCurrency(t.amount_twd) }}
                                        </div>
                                    </div>
                                    <div class="flex justify-between items-center mt-1">
                                        <div class="text-sm font-medium text-slate-700">{{ t.category_name || '無分類' }}</div>
                                        <div class="text-xs text-slate-400 truncate max-w-[100px]">{{ t.note }}</div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="lg:w-2/3 bg-white rounded-xl shadow-lg border border-slate-200 p-6 flex flex-col">
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                                <div>
                                    <label class="block text-sm font-bold text-slate-600 mb-2">日期</label>
                                    <input type="date" v-model="form.date" class="input-field">
                                </div>
                                <div>
                                    <label class="block text-sm font-bold text-slate-600 mb-2">銀行 / 帳戶</label>
                                    <select v-model="form.account_id" @change="fetchRecent" class="input-field">
                                        <option value="" disabled>請選擇帳戶</option>
                                        <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                                            {{ acc.name }} ({{ acc.currency }})
                                        </option>
                                    </select>
                                </div>
                                <div class="md:col-span-2">
                                    <label class="block text-sm font-bold text-slate-600 mb-2">交易類型</label>
                                    <div class="grid grid-cols-3 gap-3">
                                        <button type="button" @click="form.type = 'EXPENSE'" :class="btnClass('EXPENSE')">支出</button>
                                        <button type="button" @click="form.type = 'INCOME'" :class="btnClass('INCOME')">收入</button>
                                        <button type="button" @click="form.type = 'TRANSFER'" :class="btnClass('TRANSFER')">轉帳</button>
                                    </div>
                                </div>
                                <div>
                                    <label class="block text-sm font-bold text-slate-600 mb-2">分類</label>
                                    <select v-model="form.category_id" class="input-field">
                                        <option value="" disabled>選擇分類</option>
                                        <option v-for="c in filteredCategories" :key="c.id" :value="c.id">{{ c.name }}</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-sm font-bold text-slate-600 mb-2">金額 (TWD)</label>
                                    <input type="number" v-model="form.amount_twd" placeholder="0" class="input-field font-mono text-xl">
                                </div>
                                <div class="md:col-span-2">
                                    <label class="block text-sm font-bold text-slate-600 mb-2">備註</label>
                                    <input type="text" v-model="form.note" placeholder="例如：午餐..." class="input-field">
                                </div>
                            </div>
                            <div class="mt-auto pt-6 border-t border-slate-100 flex justify-end gap-4">
                                <button type="button" @click="submitTransaction" :disabled="isSubmitting"
                                    class="px-8 py-3 rounded-lg bg-slate-900 text-white font-bold hover:bg-slate-800 shadow-lg transform active:scale-95 transition flex items-center">
                                    <span v-if="isSubmitting"><i class="fa-solid fa-spinner fa-spin mr-2"></i> 處理中</span>
                                    <span v-else>確認記帳</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'accounts'" class="max-w-6xl mx-auto">
                    <h2 class="text-2xl font-bold text-slate-800 mb-6 flex items-center">
                        <i class="fa-solid fa-wallet mr-3 text-slate-400"></i> 我的帳戶
                    </h2>
                    
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        <div v-for="acc in accounts" :key="acc.id" @click="openAccountDetail(acc)"
                            class="bg-white rounded-xl shadow-sm border border-slate-200 p-6 cursor-pointer hover:shadow-md hover:-translate-y-1 transition group relative overflow-hidden">
                            <div class="absolute right-[-20px] top-[-20px] text-9xl text-slate-50 opacity-10 group-hover:opacity-20 transition transform rotate-12">
                                <i class="fa-solid fa-building-columns"></i>
                            </div>
                            
                            <div class="flex justify-between items-start mb-4 relative z-10">
                                <div>
                                    <div class="text-slate-500 text-xs font-bold tracking-wider mb-1">{{ acc.currency }}</div>
                                    <div class="font-bold text-lg text-slate-800">{{ acc.name }}</div>
                                </div>
                                <div class="bg-slate-100 rounded-full p-2 text-slate-600">
                                    <i class="fa-solid fa-angle-right"></i>
                                </div>
                            </div>
                            
                            <div class="relative z-10">
                                <div class="text-sm text-slate-400 mb-1">當前餘額</div>
                                <div class="text-2xl font-mono font-bold" :class="acc.balance_twd < 0 ? 'text-rose-600' : 'text-slate-800'">
                                    {{ formatCurrency(acc.balance_twd) }}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'account_detail'" class="max-w-4xl mx-auto h-full flex flex-col">
                    <button @click="currentView = 'accounts'" class="text-slate-500 mb-4 flex items-center hover:text-slate-800 w-fit">
                        <i class="fa-solid fa-arrow-left mr-2"></i> 返回帳戶列表
                    </button>

                    <div class="bg-white rounded-xl shadow-sm border border-slate-200 flex-1 flex flex-col overflow-hidden">
                        <div class="p-6 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                            <div>
                                <h2 class="text-xl font-bold text-slate-800">{{ currentAccount?.name }}</h2>
                                <div class="text-slate-500 text-sm">交易明細</div>
                            </div>
                            <div class="text-right">
                                <div class="text-xs text-slate-400">結餘</div>
                                <div class="font-mono font-bold text-xl text-emerald-600">{{ formatCurrency(currentAccount?.balance_twd) }}</div>
                            </div>
                        </div>

                        <div class="flex-1 overflow-y-auto p-0">
                            <div v-if="detailTransactions.length === 0" class="text-center py-20 text-slate-400">
                                此帳戶尚無交易紀錄
                            </div>
                            
                            <table v-else class="w-full text-left border-collapse">
                                <thead class="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0">
                                    <tr>
                                        <th class="p-4 font-medium">日期</th>
                                        <th class="p-4 font-medium">類別</th>
                                        <th class="p-4 font-medium">備註</th>
                                        <th class="p-4 font-medium text-right">金額</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-slate-100">
                                    <tr v-for="t in detailTransactions" :key="t.id" class="hover:bg-slate-50">
                                        <td class="p-4 text-slate-600 text-sm whitespace-nowrap">{{ t.date }}</td>
                                        <td class="p-4">
                                            <span class="px-2 py-1 rounded text-xs font-bold" 
                                                :class="t.type === 'INCOME' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'">
                                                {{ t.category_name }}
                                            </span>
                                        </td>
                                        <td class="p-4 text-slate-700 text-sm">{{ t.note }}</td>
                                        <td class="p-4 text-right font-mono font-bold" 
                                            :class="t.type === 'INCOME' ? 'text-emerald-600' : 'text-rose-600'">
                                            {{ t.type === 'EXPENSE' ? '-' : '+' }}{{ formatCurrency(t.amount_twd) }}
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

            </div>
        </main>
      </div>

      <style>
        .input-field {
            width: 100%;
            background-color: #f8fafc;
            border: 1px solid #cbd5e1;
            border-radius: 0.5rem;
            padding: 0.75rem 1rem;
            outline: none;
        }
        .input-field:focus { box-shadow: 0 0 0 2px #3b82f6; }
      </style>

      <script>
        const { createApp, ref, computed, onMounted } = Vue

        createApp({
            setup() {
                const currentView = ref('accounts') 
                const isSubmitting = ref(false)
                
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
                    note: ''
                })

                const navClass = (view) => [
                    'w-full text-left px-4 py-3 rounded-lg transition-all duration-200 flex items-center gap-3',
                    (currentView.value === view || (view === 'accounts' && currentView.value === 'account_detail')) 
                        ? 'bg-emerald-600 text-white shadow-lg' : 'hover:bg-slate-800 hover:text-white'
                ]

                const btnClass = (type) => {
                    const activeBase = 'text-white shadow-md'
                    const inactive = 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    if (form.value.type !== type) return 'py-3 rounded-lg font-bold transition ' + inactive
                    
                    if (type === 'EXPENSE') return 'py-3 rounded-lg font-bold transition bg-rose-500 ' + activeBase
                    if (type === 'INCOME') return 'py-3 rounded-lg font-bold transition bg-emerald-500 ' + activeBase
                    return 'py-3 rounded-lg font-bold transition bg-blue-500 ' + activeBase
                }

                const selectedAccountName = computed(() => accounts.value.find(a => a.id === form.value.account_id)?.name || '')
                const filteredCategories = computed(() => categories.value.filter(c => c.type === form.value.type))
                const totalNetWorth = computed(() => accounts.value.reduce((sum, acc) => sum + (acc.balance_twd || 0), 0))

                const formatCurrency = (val) => {
                    if (val === undefined || val === null) return '-'
                    return new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', minimumFractionDigits: 0 }).format(val)
                }

                const fetchData = async () => {
                    const [catRes, accRes] = await Promise.all([fetch('/api/categories'), fetch('/api/accounts')])
                    categories.value = await catRes.json()
                    accounts.value = await accRes.json()
                }

                const fetchRecent = async () => {
                    if (!form.value.account_id) return
                    const res = await fetch(\`/api/transactions?account_id=\${form.value.account_id}&limit=10\`)
                    recentTransactions.value = await res.json()
                }

                // 切換頁面
                const changeView = (view) => {
                    currentView.value = view
                    if (view === 'accounts') fetchData() // 重新抓取餘額
                }

                // 進入帳戶明細
                const openAccountDetail = async (acc) => {
                    currentAccount.value = acc
                    currentView.value = 'account_detail'
                    const res = await fetch(\`/api/transactions?account_id=\${acc.id}&limit=100\`)
                    detailTransactions.value = await res.json()
                }

                const submitTransaction = async () => {
                    if (!form.value.account_id || !form.value.amount_twd) return alert('資料不全')
                    isSubmitting.value = true
                    try {
                        const res = await fetch('/api/transactions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(form.value)
                        })
                        if (res.ok) {
                            await fetchRecent()
                            await fetchData() // 更新餘額
                            form.value.amount_twd = ''
                            form.value.note = ''
                            alert('記帳成功')
                        }
                    } catch (e) { console.error(e) } 
                    finally { isSubmitting.value = false }
                }

                onMounted(() => fetchData())

                return { 
                    currentView, isSubmitting, categories, accounts, recentTransactions, detailTransactions, currentAccount,
                    form, selectedAccountName, filteredCategories, totalNetWorth,
                    navClass, btnClass, formatCurrency, fetchRecent, submitTransaction, changeView, openAccountDetail
                }
            }
        }).mount('#app')
      </script>
    </body>
    </html>
  `)
})

export default app