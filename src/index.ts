import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// ==========================================
// 1. 後端 API 區域 (負責跟資料庫講話)
// ==========================================

// 取得分類列表
app.get('/api/categories', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM categories ORDER BY type, id').all()
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// (預留) 之後會在這裡加更多 API，例如取得交易紀錄、新增記帳...


// ==========================================
// 2. 前端介面區域 (單頁應用程式 SPA)
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
        /* 自定義捲軸樣式 */
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #f1f1f1; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
      </style>
    </head>
    <body class="bg-slate-100 text-slate-800 font-sans h-screen overflow-hidden">
      
      <div id="app" class="flex h-full">
        
        <aside class="w-64 bg-slate-900 text-slate-300 flex flex-col shadow-xl z-20">
          <div class="p-6 text-xl font-bold text-white tracking-wider border-b border-slate-700 flex items-center gap-2">
            <i class="fa-solid fa-wallet text-emerald-400"></i>
            資產管家
          </div>
          
          <nav class="flex-1 p-4 space-y-2">
             <button @click="currentView = 'dashboard'" 
                :class="['w-full text-left px-4 py-3 rounded-lg transition-all duration-200 flex items-center gap-3', currentView === 'dashboard' ? 'bg-emerald-600 text-white shadow-lg' : 'hover:bg-slate-800 hover:text-white']">
                <i class="fa-solid fa-chart-pie w-6 text-center"></i> 總覽 (Dashboard)
             </button>
             
             <button @click="currentView = 'accounts'" 
                :class="['w-full text-left px-4 py-3 rounded-lg transition-all duration-200 flex items-center gap-3', currentView === 'accounts' ? 'bg-emerald-600 text-white shadow-lg' : 'hover:bg-slate-800 hover:text-white']">
                <i class="fa-solid fa-building-columns w-6 text-center"></i> 各家銀行
             </button>
             
             <button @click="currentView = 'add'" 
                :class="['w-full text-left px-4 py-3 rounded-lg transition-all duration-200 flex items-center gap-3', currentView === 'add' ? 'bg-emerald-600 text-white shadow-lg' : 'hover:bg-slate-800 hover:text-white']">
                <i class="fa-solid fa-circle-plus w-6 text-center"></i> 新增記帳
             </button>
          </nav>
          
          <div class="p-4 text-xs text-slate-500 border-t border-slate-800 text-center">
            v1.0.0 Cloudflare Edition
          </div>
        </aside>

        <main class="flex-1 overflow-y-auto bg-slate-50 relative">
            <header class="bg-white shadow-sm sticky top-0 z-10 px-8 py-4 flex justify-between items-center">
                <h2 class="text-2xl font-bold text-slate-800">{{ viewTitle }}</h2>
                <div class="text-sm text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
                    <i class="fa-regular fa-calendar mr-2"></i> 2025/01/01 - 2025/12/31
                </div>
            </header>

            <div class="p-8 max-w-7xl mx-auto">
                
                <div v-if="currentView === 'dashboard'" class="space-y-8">
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div class="bg-white p-6 rounded-xl shadow-sm border border-slate-200 relative overflow-hidden group hover:shadow-md transition">
                            <div class="absolute right-0 top-0 p-4 opacity-10 group-hover:opacity-20 transition">
                                <i class="fa-solid fa-arrow-trend-up text-6xl text-emerald-600"></i>
                            </div>
                            <div class="text-slate-500 text-sm font-medium mb-1">年度總收入 (含借款)</div>
                            <div class="text-3xl font-bold text-emerald-600">+ $858,570</div>
                            <div class="text-xs text-emerald-500 mt-2 flex items-center">
                                <i class="fa-solid fa-caret-up mr-1"></i> 9.52% 較去年
                            </div>
                        </div>
                        
                        <div class="bg-white p-6 rounded-xl shadow-sm border border-slate-200 relative overflow-hidden group hover:shadow-md transition">
                            <div class="absolute right-0 top-0 p-4 opacity-10 group-hover:opacity-20 transition">
                                <i class="fa-solid fa-fire text-6xl text-rose-600"></i>
                            </div>
                            <div class="text-slate-500 text-sm font-medium mb-1">年度總支出</div>
                            <div class="text-3xl font-bold text-rose-600">- $609,037</div>
                            <div class="text-xs text-rose-500 mt-2 flex items-center">
                                <i class="fa-solid fa-caret-up mr-1"></i> 12.95% 較去年
                            </div>
                        </div>
                        
                        <div class="bg-white p-6 rounded-xl shadow-sm border border-slate-200 relative overflow-hidden group hover:shadow-md transition">
                            <div class="absolute right-0 top-0 p-4 opacity-10 group-hover:opacity-20 transition">
                                <i class="fa-solid fa-piggy-bank text-6xl text-blue-600"></i>
                            </div>
                            <div class="text-slate-500 text-sm font-medium mb-1">當前淨資產</div>
                            <div class="text-3xl font-bold text-blue-600">$5,388,940</div>
                            <div class="text-xs text-blue-500 mt-2 flex items-center">
                                <i class="fa-solid fa-caret-up mr-1"></i> 4.86% 穩定成長中
                            </div>
                        </div>
                    </div>

                    <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                        <div class="flex justify-between items-center mb-4">
                            <h3 class="font-bold text-lg text-slate-700">
                                <i class="fa-solid fa-database mr-2 text-slate-400"></i>
                                資料庫連線檢查 (你的分類設定)
                            </h3>
                            <span v-if="loading" class="text-sm text-slate-400"><i class="fa-solid fa-spinner fa-spin"></i> 讀取中...</span>
                        </div>
                        
                        <div v-if="categories.length === 0 && !loading" class="text-slate-400 italic">
                            尚無分類資料，請檢查資料庫。
                        </div>

                        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div v-for="c in categories" :key="c.id" 
                                class="p-3 rounded border border-slate-100 bg-slate-50 flex items-center justify-between">
                                <span class="font-medium">{{ c.name }}</span>
                                <span class="text-xs px-2 py-1 rounded" 
                                    :class="{
                                        'bg-emerald-100 text-emerald-700': c.type === 'INCOME',
                                        'bg-rose-100 text-rose-700': c.type === 'EXPENSE',
                                        'bg-blue-100 text-blue-700': c.type === 'TRANSFER'
                                    }">
                                    {{ c.type }}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="currentView === 'accounts'" class="text-center py-20 text-slate-400">
                    <i class="fa-solid fa-building-columns text-6xl mb-4 text-slate-200"></i>
                    <p class="text-xl">這裡將顯示各家銀行明細與信用卡摺疊帳單</p>
                </div>

                <div v-if="currentView === 'add'" class="text-center py-20 text-slate-400">
                    <i class="fa-solid fa-pen-to-square text-6xl mb-4 text-slate-200"></i>
                    <p class="text-xl">這裡將實作「左側預覽、右側輸入」的分割視窗</p>
                </div>

            </div>
        </main>
      </div>

      <script>
        const { createApp, ref, computed, onMounted } = Vue
        
        createApp({
            setup() {
                const currentView = ref('dashboard') // 預設顯示總覽
                const categories = ref([])
                const loading = ref(true)

                // 根據目前的 View 計算標題
                const viewTitle = computed(() => {
                    const map = { 
                        dashboard: '資產總覽', 
                        accounts: '銀行帳戶明細', 
                        add: '新增交易' 
                    }
                    return map[currentView.value]
                })

                // 頁面載入時，去後端抓資料
                onMounted(async () => {
                    try {
                        const res = await fetch('/api/categories')
                        if (res.ok) {
                            categories.value = await res.json()
                        }
                    } catch (e) {
                        console.error('Fetch error:', e)
                    } finally {
                        loading.value = false
                    }
                })

                return { currentView, viewTitle, categories, loading }
            }
        }).mount('#app')
      </script>
    </body>
    </html>
  `)
})

export default app