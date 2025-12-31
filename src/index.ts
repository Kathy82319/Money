import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()
　
// ==========================================
// 1. 後端 API 區域
// ==========================================

// [GET] 取得分類列表
app.get('/api/categories', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM categories ORDER BY type, id').all()
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// [GET] 取得帳戶列表 (用於下拉選單)
app.get('/api/accounts', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM accounts ORDER BY id').all()
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// [GET] 取得特定帳戶的近期交易 (用於左側預覽)
app.get('/api/transactions', async (c) => {
  const accountId = c.req.query('account_id')
  if (!accountId) return c.json([])

  try {
    const { results } = await c.env.DB.prepare(`
      SELECT t.*, c.name as category_name 
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.account_id = ?
      ORDER BY t.date DESC, t.created_at DESC
      LIMIT 10
    `).bind(accountId).all()
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// [POST] 新增一筆交易
app.post('/api/transactions', async (c) => {
  try {
    const body = await c.req.json()
    // 簡單驗證
    if (!body.date || !body.account_id || !body.amount_twd) {
      return c.json({ error: '缺少必要欄位' }, 400)
    }

    // 1. 寫入交易紀錄
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

    // 2. (可選) 在這裡同時更新 Accounts 餘額，目前先略過，之後可以用 Trigger 或每次計算

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
        /* 隱藏數字輸入框的箭頭 */
        input[type=number]::-webkit-inner-spin-button, 
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
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
             <button @click="currentView = 'dashboard'" :class="navClass('dashboard')">
                <i class="fa-solid fa-chart-pie w-6 text-center"></i> 總覽
             </button>
             <button @click="currentView = 'add'" :class="navClass('add')">
                <i class="fa-solid fa-circle-plus w-6 text-center"></i> 新增記帳
             </button>
             <button @click="currentView = 'accounts'" :class="navClass('accounts')">
                <i class="fa-solid fa-building-columns w-6 text-center"></i> 各家銀行
             </button>
          </nav>
        </aside>

        <main class="flex-1 flex flex-col h-full overflow-hidden bg-slate-50">
            <header class="bg-white shadow-sm p-4 flex justify-between items-center md:hidden">
                <div class="font-bold text-slate-800">資產管家</div>
                <button @click="mobileMenuOpen = !mobileMenuOpen" class="text-slate-600">
                    <i class="fa-solid fa-bars text-xl"></i>
                </button>
            </header>

            <div class="flex-1 overflow-y-auto p-4 md:p-8">
                
                <div v-if="currentView === 'dashboard'" class="max-w-5xl mx-auto space-y-6">
                    <h2 class="text-2xl font-bold text-slate-800 mb-6">資產總覽</h2>
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div class="bg-white p-6 rounded-xl shadow-sm border-l-4 border-emerald-500">
                            <div class="text-slate-500 text-sm">淨資產</div>
                            <div class="text-3xl font-bold text-emerald-700">$5,388,940</div>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'add'" class="max-w-6xl mx-auto h-full flex flex-col">
                    <h2 class="text-2xl font-bold text-slate-800 mb-6 flex items-center">
                        <i class="fa-solid fa-pen-to-square mr-3 text-slate-400"></i>
                        新增交易
                    </h2>
                    
                    <div class="flex flex-col lg:flex-row gap-6 h-full">
                        
                        <div class="lg:w-1/3 bg-slate-200 rounded-xl p-4 overflow-hidden flex flex-col border border-slate-300">
                            <div class="font-bold text-slate-700 mb-4 flex items-center justify-between">
                                <span><i class="fa-solid fa-clock-rotate-left mr-2"></i> 近期明細</span>
                                <span v-if="selectedAccountName" class="text-xs bg-slate-600 text-white px-2 py-1 rounded">{{ selectedAccountName }}</span>
                            </div>
                            
                            <div class="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                                <div v-if="recentTransactions.length === 0" class="text-center text-slate-400 py-10 text-sm">
                                    <span v-if="!form.account_id">請先選擇右側銀行<br>以檢視歷史紀錄</span>
                                    <span v-else>此帳戶尚無近期紀錄</span>
                                </div>

                                <div v-for="t in recentTransactions" :key="t.id" class="bg-white p-3 rounded shadow-sm border-l-4"
                                    :class="t.type === 'INCOME' ? 'border-emerald-400' : 'border-rose-400'">
                                    <div class="flex justify-between items-start">
                                        <div class="text-xs text-slate-500">{{ t.date }}</div>
                                        <div class="font-bold font-mono" :class="t.type === 'INCOME' ? 'text-emerald-600' : 'text-rose-600'">
                                            {{ t.type === 'EXPENSE' ? '-' : '+' }}{{ t.amount_twd.toLocaleString() }}
                                        </div>
                                    </div>
                                    <div class="flex justify-between items-center mt-1">
                                        <div class="text-sm font-medium text-slate-700">{{ t.category_name || '無分類' }}</div>
                                        <div class="text-xs text-slate-400 truncate max-w-[100px]">{{ t.note }}</div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="lg:w-2/3 bg-white rounded-xl shadow-lg border border-slate-200 p-6 lg:p-8 flex flex-col">
                            
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                                <div>
                                    <label class="block text-sm font-bold text-slate-600 mb-2">日期</label>
                                    <input type="date" v-model="form.date" 
                                        class="w-full bg-slate-50 border border-slate-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-blue-500 outline-none">
                                </div>

                                <div>
                                    <label class="block text-sm font-bold text-slate-600 mb-2">銀行 / 帳戶</label>
                                    <select v-model="form.account_id" @change="fetchRecent"
                                        class="w-full bg-slate-50 border border-slate-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-blue-500 outline-none">
                                        <option value="" disabled>請選擇帳戶</option>
                                        <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                                            {{ acc.name }} ({{ acc.currency }})
                                        </option>
                                    </select>
                                </div>

                                <div class="md:col-span-2">
                                    <label class="block text-sm font-bold text-slate-600 mb-2">交易類型</label>
                                    <div class="grid grid-cols-3 gap-3">
                                        <button type="button" @click="form.type = 'EXPENSE'"
                                            :class="['py-3 rounded-lg font-bold transition', form.type === 'EXPENSE' ? 'bg-rose-500 text-white shadow-md' : 'bg-slate-100 text-slate-500 hover:bg-slate-200']">
                                            支出
                                        </button>
                                        <button type="button" @click="form.type = 'INCOME'"
                                            :class="['py-3 rounded-lg font-bold transition', form.type === 'INCOME' ? 'bg-emerald-500 text-white shadow-md' : 'bg-slate-100 text-slate-500 hover:bg-slate-200']">
                                            收入
                                        </button>
                                        <button type="button" @click="form.type = 'TRANSFER'"
                                            :class="['py-3 rounded-lg font-bold transition', form.type === 'TRANSFER' ? 'bg-blue-500 text-white shadow-md' : 'bg-slate-100 text-slate-500 hover:bg-slate-200']">
                                            轉帳
                                        </button>
                                    </div>
                                </div>

                                <div>
                                    <label class="block text-sm font-bold text-slate-600 mb-2">分類</label>
                                    <select v-model="form.category_id"
                                        class="w-full bg-slate-50 border border-slate-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-blue-500 outline-none">
                                        <option value="" disabled>選擇分類</option>
                                        <option v-for="c in filteredCategories" :key="c.id" :value="c.id">
                                            {{ c.name }}
                                        </option>
                                    </select>
                                </div>

                                <div>
                                    <label class="block text-sm font-bold text-slate-600 mb-2">金額 (TWD)</label>
                                    <input type="number" v-model="form.amount_twd" placeholder="0"
                                        class="w-full bg-slate-50 border border-slate-300 rounded-lg px-4 py-3 text-xl font-mono focus:ring-2 focus:ring-blue-500 outline-none">
                                </div>

                                <div class="md:col-span-2">
                                    <label class="block text-sm font-bold text-slate-600 mb-2">備註 / 說明</label>
                                    <input type="text" v-model="form.note" placeholder="例如：午餐、房貸第32期..."
                                        class="w-full bg-slate-50 border border-slate-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-blue-500 outline-none">
                                </div>
                            </div>

                            <div class="mt-auto pt-6 border-t border-slate-100 flex justify-end gap-4">
                                <button type="button" class="px-6 py-3 rounded-lg text-slate-500 hover:bg-slate-100 font-medium">清空</button>
                                <button type="button" @click="submitTransaction" :disabled="isSubmitting"
                                    class="px-8 py-3 rounded-lg bg-slate-900 text-white font-bold hover:bg-slate-800 shadow-lg transform active:scale-95 transition flex items-center">
                                    <span v-if="isSubmitting"><i class="fa-solid fa-spinner fa-spin mr-2"></i> 處理中</span>
                                    <span v-else>確認記帳</span>
                                </button>
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
                // 狀態變數
                const currentView = ref('dashboard')
                const mobileMenuOpen = ref(false)
                const isSubmitting = ref(false)
                
                // 資料庫資料
                const categories = ref([])
                const accounts = ref([])
                const recentTransactions = ref([])

                // 表單資料
                const form = ref({
                    date: new Date().toISOString().split('T')[0], // 預設今天
                    account_id: '',
                    type: 'EXPENSE',
                    category_id: '',
                    amount_twd: '',
                    note: ''
                })

                // 計算屬性
                const navClass = (view) => [
                    'w-full text-left px-4 py-3 rounded-lg transition-all duration-200 flex items-center gap-3',
                    currentView.value === view ? 'bg-emerald-600 text-white shadow-lg' : 'hover:bg-slate-800 hover:text-white'
                ]

                const selectedAccountName = computed(() => {
                    const acc = accounts.value.find(a => a.id === form.value.account_id)
                    return acc ? acc.name : ''
                })

                // 根據選到的 Type (收入/支出) 篩選顯示的分類
                const filteredCategories = computed(() => {
                    return categories.value.filter(c => c.type === form.value.type)
                })

                // 核心功能：讀取資料
                const fetchData = async () => {
                    const [catRes, accRes] = await Promise.all([
                        fetch('/api/categories'),
                        fetch('/api/accounts')
                    ])
                    categories.value = await catRes.json()
                    accounts.value = await accRes.json()
                }

                // 核心功能：讀取近期明細 (當銀行改變時觸發)
                const fetchRecent = async () => {
                    if (!form.value.account_id) return
                    const res = await fetch(\`/api/transactions?account_id=\${form.value.account_id}\`)
                    recentTransactions.value = await res.json()
                }

                // 核心功能：送出記帳
                const submitTransaction = async () => {
                    if (!form.value.account_id || !form.value.amount_twd) {
                        alert('請填寫完整資料')
                        return
                    }
                    
                    isSubmitting.value = true
                    try {
                        const res = await fetch('/api/transactions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(form.value)
                        })
                        
                        if (res.ok) {
                            // 成功後重整「左側預覽」
                            await fetchRecent()
                            // 清空金額，保留日期與銀行方便連續輸入
                            form.value.amount_twd = ''
                            form.value.note = ''
                            alert('記帳成功！')
                        } else {
                            alert('發生錯誤')
                        }
                    } catch (e) {
                        console.error(e)
                    } finally {
                        isSubmitting.value = false
                    }
                }

                onMounted(() => {
                    fetchData()
                })

                return { 
                    currentView, navClass, mobileMenuOpen,
                    categories, accounts, recentTransactions,
                    form, filteredCategories, selectedAccountName,
                    fetchRecent, submitTransaction, isSubmitting
                }
            }
        }).mount('#app')
      </script>
    </body>
    </html>
  `)
})

export default app