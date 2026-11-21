// ════════════════════════════════════════════════════════════════
//  Twinklehub · MCP + AI Hub  v8.7
//  twinklehub.kftseng2oo1.workers.dev
//
//  v8.5 新增 (RAG 精度優化):
//    /rag/index  → Embedding 改為拼接 text+translation+concept_essence
//                  支援白話文提問精準命中文言典籍
//    /rag/query  → 回傳結果帶回 translation、concept_essence 欄位
//
//  v8.4 新增 (RAG Wisdom Library):
//    POST /rag/query       → 語意搜尋典籍（CF AI Embedding + Vectorize）
//    POST /rag/index       → 建檔單筆典籍段落（管理用，需 RAG_ADMIN_TOKEN）
//    DELETE /rag/:id       → 刪除單筆典籍（需 RAG_ADMIN_TOKEN）
//    GET  /rag/stats       → 查看典籍庫統計
//
//  v8.3 新增 (Memory Companion):
//    POST /memory/extract  → 對話後抽取長期記憶(Claude 判斷)
//    GET  /memory/:uid     → 讀取使用者記憶列表
//    POST /memory/:uid     → 寫入/更新單筆記憶
//    DELETE /memory/:uid/:mid → 刪除單筆記憶
//    GET  /memory/:uid/summary → 讀取每日情緒摘要
//    Scheduled Event       → 每日 00:00 UTC+8 生成反思摘要
//
//  v8.2 新增:
//    POST /claude          → Anthropic Claude API proxy
//    POST /v1/messages     → 同上(相容標準路徑)
//
//  v8.1 新增:
//    GET  /lvr             → 實價登錄查詢(清洗版,不經 AI,零 token 成本)
//    GET  /lvr/schema      → 探測 lvr-trades 真實欄位
//
//  v8.0 新增:
//    GET  /                → 自動分流(瀏覽器吐 chat HTML,API 吐 JSON)
//    GET  /health          → 健康檢查 JSON
//    GET  /tools           → 工具清單(本地 4 + 上游 58,合併)
//    POST /call            → 簡易工具呼叫(自動分流 local- / upstream-)
//    POST /gemini          → Gemini API proxy
//
//  v7.x 既有(保留):
//    GET  /mcp             → MCP Server Info
//    POST /mcp             → MCP JSON-RPC 2.0
//    GET  /mcp/tools       → 自製工具清單(除錯)
//    GET  /mcp/clear-cache → 清快取
//
//  Secrets(Wrangler / Dashboard):
//    GEMINI_API_KEY         (Gemini API)
//    ANTHROPIC_API_KEY      (Claude API)
//    TWINKLE_UPSTREAM_TOKEN  (官方 hub.twinkleai.tw 的 sk-... token)
//    RAG_ADMIN_TOKEN        (v8.4 新增，保護建檔/刪除路由，自訂任意字串)
//
//  Bindings:
//    KV:         TWINKLEHUB_KV  (既有)
//                BUDDHA_KV      (v8.3 新增，心靈導師記憶)
//    Vectorize:  WISDOM_INDEX   (v8.4 新增，典籍向量索引)
//    AI:         AI             (v8.4 新增，CF Workers AI，生成 Embedding)
// ════════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, x-api-key, anthropic-version',
};

const UPSTREAM_BASE = 'https://api.twinkleai.tw/mcp/';
const GOV_SEARCH_BASE  = 'https://data.gov.tw/api/3/action/package_search';
const GOV_DATASET_BASE = 'https://data.gov.tw/api/v2/rest/dataset';
const GOV_RESOURCE     = 'https://data.gov.tw/api/v2/rest/datastore';
const CACHE_TTL_SEARCH = 1800;
const CACHE_TTL_DETAIL = 7200;
const UPSTREAM_TOOLS_CACHE_KEY = 'v8:upstream:tools';
const UPSTREAM_TOOLS_TTL = 3600;

const TOPICS = {
  real_estate: {
    label: '房地產',
    keywords: ['實價登錄', '不動產', '房屋', '土地', '地價', '建物', '住宅', '容積', '建照'],
    tags: ['不動產', '實價登錄', '地政'],
  },
  traffic: {
    label: '交通',
    keywords: ['交通', '道路', '公路', '捷運', '公車', '鐵路', '停車', '號誌', '事故', '速限'],
    tags: ['交通', '運輸', '道路'],
  },
  environment: {
    label: '環境',
    keywords: ['空氣品質', '水質', '土壤', '噪音', '廢棄物', '污染', '氣象', '河川', '環境'],
    tags: ['環境', '空氣', '水資源'],
  },
};

// ════════════════════════════════════════════════════════════════
//  本地 MCP 工具定義(v7.2 原樣保留)
// ════════════════════════════════════════════════════════════════
const MCP_TOOLS = [
  {
    name: 'search_datasets',
    description: '在政府開放資料平臺搜尋特定主題的資料集。支援房地產、交通、環境三大主題。',
    inputSchema: {
      type: 'object',
      properties: {
        topic:   { type: 'string', enum: ['real_estate','traffic','environment'], description: '資料主題' },
        keyword: { type: 'string', description: '額外的搜尋關鍵字,例如「臺中市」' },
        limit:   { type: 'number', description: '回傳筆數,預設 10,最多 30', default: 10 },
      },
      required: ['topic'],
    },
  },
  {
    name: 'get_dataset_info',
    description: '取得特定資料集的詳細資訊,包含欄位說明、發布機關、更新頻率、下載連結。',
    inputSchema: {
      type: 'object',
      properties: { dataset_id: { type: 'string', description: '資料集 ID' } },
      required: ['dataset_id'],
    },
  },
  {
    name: 'fetch_dataset_records',
    description: '直接取得資料集的實際資料內容(前 N 筆),支援欄位過濾與條件查詢。',
    inputSchema: {
      type: 'object',
      properties: {
        resource_id: { type: 'string', description: '資源 ID' },
        limit:       { type: 'number', description: '取幾筆資料,預設 20,最多 100', default: 20 },
        filters:     { type: 'object', description: '欄位過濾,例如 {"縣市":"臺中市"}' },
        keyword:     { type: 'string', description: '全文搜尋關鍵字' },
      },
      required: ['resource_id'],
    },
  },
  {
    name: 'summarize_topic',
    description: '取得特定主題的資料集統計摘要:共有幾個資料集、哪些機關提供、最新更新時間。',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', enum: ['real_estate','traffic','environment'] } },
      required: ['topic'],
    },
  },
];

// ════════════════════════════════════════════════════════════════
//  主 fetch handler
// ════════════════════════════════════════════════════════════════
export default {
  // v7.2 既有:Cron Trigger 預熱熱門主題快取
  async scheduled(event, env, ctx) {
    console.log('[Cron] Starting daily cache warmup...');
    const topics = ['real_estate','traffic','environment'];
    for (const topic of topics) {
      try {
        if (env.TWINKLEHUB_KV) {
          await env.TWINKLEHUB_KV.delete('v6:summary:' + topic).catch(() => {});
        }
        const topicDef = TOPICS[topic];
        const mainKw = topicDef.keywords[0];
        const cacheKey = 'v5:search:' + topic + ':' + mainKw + ':10';
        if (env.TWINKLEHUB_KV) {
          await env.TWINKLEHUB_KV.delete(cacheKey).catch(() => {});
        }
        const result = await toolSearchDatasets({ topic, keyword: mainKw, limit: 10 }, env);
        console.log('[Cron]', topic, '預熱完成,筆數:', result.total_found);
      } catch(e) {
        console.error('[Cron] warmup failed for', topic, e.message);
      }
    }
    console.log('[Cron] Daily warmup done');
    // v8.3 新增:每日反思摘要（v8.6：Cron 每 2 小時觸發，僅在台北 00:00 / UTC 16 點那一輪執行）
    const hourUTC = new Date(event && event.scheduledTime ? event.scheduledTime : Date.now()).getUTCHours();
    if (hourUTC === 16) ctx.waitUntil(handleDailyReflection(env));
  },

  async fetch(request, env, ctx) {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }

      const url = new URL(request.url);
      const path = url.pathname;

      // ── 根路徑:瀏覽器吐 HTML,API 吐 JSON ──
      if (path === '/' || path === '') {
        const accept = request.headers.get('accept') || '';
        if (accept.indexOf('text/html') !== -1) {
          return new Response(CHAT_HTML, {
            status: 200,
            headers: Object.assign({}, CORS, { 'Content-Type': 'text/html; charset=utf-8' }),
          });
        }
        return jsonRes({
          status: 'ok',
          name: 'Twinklehub MCP + AI Hub',
          version: '8.7',
          chat_ui: url.origin + '/',
          endpoints: {
            'GET  /':                    'Chat HTML(瀏覽器)or 健康檢查 JSON(API)',
            'GET  /health':              '健康檢查',
            'GET  /tools':               '工具清單(本地 + 上游合併)',
            'POST /call':                '呼叫工具',
            'POST /gemini':              'Gemini API proxy',
            'POST /claude':              'Claude API proxy(需 ANTHROPIC_API_KEY)',
            'POST /v1/messages':         'Claude API proxy(相容路徑)',
            'POST /memory/extract':      '抽取長期記憶(需 ANTHROPIC_API_KEY + BUDDHA_KV)',
            'GET  /memory/:uid':         '讀取使用者記憶列表',
            'POST /memory/:uid':         '寫入單筆記憶',
            'DELETE /memory/:uid/:mid':  '刪除單筆記憶',
            'GET  /memory/:uid/summary': '讀取每日反思摘要',
            'POST /rag/query':           '語意搜尋典籍(需 WISDOM_INDEX + AI binding)',
            'POST /rag/index':           '建檔典籍段落(需 RAG_ADMIN_TOKEN)',
            'DELETE /rag/:id':           '刪除典籍段落(需 RAG_ADMIN_TOKEN)',
            'GET  /rag/stats':           '典籍庫統計',
            'GET  /lvr':                 '實價登錄查詢(清洗版,不經 AI)?city=&district=&limit=',
            'GET  /lvr/schema':          '探測 lvr-trades 真實欄位',
            'GET/POST /mcp':             'MCP JSON-RPC 2.0',
          },
        });
      }

      if (path === '/health') {
        return jsonRes({ status: 'ok', version: '8.7' });
      }

      // ── v8 新增:統一工具清單 ──
      if (path === '/tools' && request.method === 'GET') {
        const includeUpstream = url.searchParams.get('upstream') !== 'false';
        const tools = await listAllTools(env, includeUpstream);
        return jsonRes({ result: { tools } });
      }

      // ── v8 新增:統一呼叫端點 ──
      if (path === '/call' && request.method === 'POST') {
        let body;
        try { body = await request.json(); }
        catch(e) { return jsonRes({ error: 'Invalid JSON' }, 400); }
        const { name, arguments: args } = body || {};
        if (!name) return jsonRes({ error: 'Missing field: name' }, 400);
        try {
          const result = await dispatchCall(name, args || {}, env);
          return jsonRes({ result });
        } catch(e) {
          return jsonRes({
            result: { content: [{ type: 'text', text: '工具失敗:' + e.message }], isError: true }
          });
        }
      }

      // ── v8 新增:Gemini API proxy ──
      if (path === '/gemini' && request.method === 'POST') {
        return handleGeminiProxy(request, env);
      }

      // ── v8.2 新增:Claude API proxy ──
      if ((path === '/claude' || path === '/v1/messages') && request.method === 'POST') {
        return handleClaudeProxy(request, env);
      }

      // ── v8.3 新增:Memory Companion 路由群 ──
      if (path === '/memory/extract' && request.method === 'POST') {
        return handleMemoryExtract(request, env);
      }
      // GET /memory/:uid/summary
      const summaryMatch = path.match(/^\/memory\/([^/]+)\/summary$/);
      if (summaryMatch && request.method === 'GET') {
        return handleMemorySummaryGet(summaryMatch[1], env);
      }
      // GET|POST /memory/:uid
      const memUidMatch = path.match(/^\/memory\/([^/]+)$/);
      if (memUidMatch) {
        if (request.method === 'GET')  return handleMemoryList(memUidMatch[1], env);
        if (request.method === 'POST') return handleMemoryWrite(memUidMatch[1], request, env);
      }
      // DELETE /memory/:uid/:mid
      const memDelMatch = path.match(/^\/memory\/([^/]+)\/([^/]+)$/);
      if (memDelMatch && request.method === 'DELETE') {
        return handleMemoryDelete(memDelMatch[1], memDelMatch[2], env);
      }

      // ── v8.4 新增:RAG Wisdom Library 路由群 ──
      if (path === '/rag/query' && request.method === 'POST') {
        return handleRagQuery(request, env);
      }
      if (path === '/rag/stats' && request.method === 'GET') {
        return handleRagStats(request, env);
      }
      if (path === '/rag/index' && request.method === 'POST') {
        return handleRagIndex(request, env);
      }
      const ragDelMatch = path.match(/^\/rag\/(.+)$/);
      if (ragDelMatch && request.method === 'DELETE') {
        return handleRagDelete(ragDelMatch[1], request, env);
      }

      // ── v8.1 新增:實價登錄 schema 探測 ──
      if (path === '/lvr/schema' && request.method === 'GET') {
        try {
          const probe = await callUpstream('query_rows', { dataset_id: 'lvr-trades', limit: 1 }, env);
          let sampleText = '';
          if (probe && probe.content) {
            probe.content.forEach(c => { if (c.type === 'text') sampleText += c.text; });
          }
          let columns = [];
          let firstRowSample = null;
          try {
            const parsed = JSON.parse(sampleText);
            // 上游格式:{ columns: [...], rows: [[...]] }
            if (Array.isArray(parsed.columns)) {
              columns = parsed.columns;
              if (parsed.rows && parsed.rows[0]) firstRowSample = parsed.rows[0];
            }
          } catch (e) {}
          return jsonRes({
            hint: '這是 lvr-trades 的真實欄位(columns + rows 格式)。',
            columns,
            column_count: columns.length,
            first_row: firstRowSample,
          });
        } catch (e) {
          return jsonRes({ error: 'schema 探測失敗:' + e.message }, 500);
        }
      }

      // ── v8.1 新增:實價登錄查詢(清洗版,不經 AI)──
      if (path === '/lvr' && request.method === 'GET') {
        const city     = url.searchParams.get('city') || '';
        const district = url.searchParams.get('district') || '';
        const limit    = Math.min(parseInt(url.searchParams.get('limit')) || 20, 50);
        const minPrice = url.searchParams.get('min_price');
        const maxPrice = url.searchParams.get('max_price');

        if (!city) {
          return jsonRes({ error: '請提供 city 參數,例如 ?city=臺中市&district=北屯區' }, 400);
        }

        const cacheKey = 'v8:lvr:' + city + ':' + district + ':' + limit + ':' + (minPrice||'') + ':' + (maxPrice||'');
        if (env.TWINKLEHUB_KV) {
          try {
            const hit = await env.TWINKLEHUB_KV.get(cacheKey);
            if (hit) { const d = JSON.parse(hit); d._cached = true; return jsonRes(d); }
          } catch (e) {}
        }

        const whereParts = [];
        if (city)     whereParts.push("city='" + city.replace(/'/g, "''") + "'");
        if (district) whereParts.push('"鄉鎮市區"=\'' + district.replace(/'/g, "''") + "'");
        const where = whereParts.join(' AND ');

        let upstreamResult;
        try {
          upstreamResult = await callUpstream('query_rows', {
            dataset_id: 'lvr-trades',
            where: where,
            order_by: 'iso_trade_date DESC',
            limit: limit,
          }, env);
        } catch (e) {
          return jsonRes({ success: false, message: '暫時無法取得實價登錄資料,請稍後再試。', error: e.message }, 502);
        }

        let rawText = '';
        if (upstreamResult && upstreamResult.content) {
          upstreamResult.content.forEach(c => { if (c.type === 'text') rawText += c.text; });
        }

        let columns = [], rows = [];
        try {
          const parsed = JSON.parse(rawText);
          columns = parsed.columns || [];
          rows = parsed.rows || [];
        } catch (e) {
          return jsonRes({ success: false, message: '上游回傳格式無法解析', raw_preview: rawText.slice(0, 500) }, 502);
        }

        const cleaned = cleanLvrRows(columns, rows);

        const result = {
          success: true,
          source: 'Twinkle Hub lvr-trades(已清洗)',
          query: { city, district, limit },
          count: cleaned.length,
          results: cleaned,
          _cached: false,
        };

        if (env.TWINKLEHUB_KV && cleaned.length > 0) {
          await env.TWINKLEHUB_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 21600 }).catch(() => {});
        }
        return jsonRes(result);
      }

      // ── v7.2 既有路由 ──
      if (path === '/mcp/tools') {
        return jsonRes({ tools: MCP_TOOLS });
      }

      if (path === '/mcp/clear-cache') {
        if (!env.TWINKLEHUB_KV) return jsonRes({ error: 'KV not bound' }, 500);
        const all = url.searchParams.get('all');
        const key = url.searchParams.get('key');
        if (all) {
          const list = await env.TWINKLEHUB_KV.list().catch(() => ({ keys: [] }));
          await Promise.all(list.keys.map(k => env.TWINKLEHUB_KV.delete(k.name).catch(() => {})));
          return jsonRes({ cleared: list.keys.map(k => k.name), total: list.keys.length });
        }
        if (key) {
          await env.TWINKLEHUB_KV.delete(key).catch(() => {});
          return jsonRes({ cleared: key });
        }
        const list = await env.TWINKLEHUB_KV.list().catch(() => ({ keys: [] }));
        return jsonRes({ cached_keys: list.keys.map(k => k.name) });
      }

      if (path === '/mcp') {
        if (request.method === 'GET') return handleMcpInfo(request, env);
        if (request.method === 'POST') return handleMcpRequest(request, env);
      }

      return jsonRes({ error: 'Not Found: ' + path }, 404);
    } catch (e) {
      console.error('[Worker Error]', e.message, e.stack);
      return jsonRes({ error: 'Internal error: ' + e.message }, 500);
    }
  },
};

// ════════════════════════════════════════════════════════════════
//  v8 新增:統一工具層
// ════════════════════════════════════════════════════════════════

// 列出所有工具(本地 + 上游)
async function listAllTools(env, includeUpstream) {
  const localTools = MCP_TOOLS.map(t => ({
    name: 'local-' + t.name,
    description: '[本地]' + t.description,
    inputSchema: t.inputSchema,
    source: 'local',
  }));

  if (!includeUpstream) return localTools;

  let upstreamTools = [];
  try {
    upstreamTools = await fetchUpstreamTools(env);
  } catch(e) {
    console.warn('[upstream tools] fetch failed:', e.message);
    // 上游失敗仍回本地工具
  }

  const taggedUpstream = upstreamTools.map(t => ({
    name: 'upstream-' + t.name,
    description: t.description || '',
    inputSchema: t.inputSchema || { type: 'object', properties: {} },
    source: 'upstream',
  }));

  return localTools.concat(taggedUpstream);
}

// 抓上游工具清單(有 KV 快取)
async function fetchUpstreamTools(env) {
  if (env.TWINKLEHUB_KV) {
    try {
      const cached = await env.TWINKLEHUB_KV.get(UPSTREAM_TOOLS_CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch(e) {}
  }

  if (!env.TWINKLE_UPSTREAM_TOKEN) {
    throw new Error('TWINKLE_UPSTREAM_TOKEN not configured');
  }

  const res = await fetch(UPSTREAM_BASE, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.TWINKLE_UPSTREAM_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {} }),
  });

  const text = await res.text();
  const parsed = parseUpstreamResponse(text);
  const tools = (parsed && parsed.result && parsed.result.tools) || [];

  if (env.TWINKLEHUB_KV && tools.length > 0) {
    await env.TWINKLEHUB_KV.put(UPSTREAM_TOOLS_CACHE_KEY, JSON.stringify(tools), {
      expirationTtl: UPSTREAM_TOOLS_TTL,
    }).catch(() => {});
  }

  return tools;
}

// 上游回應可能是 SSE 格式,解析最後一筆 data:
function parseUpstreamResponse(text) {
  if (text.indexOf('data: ') !== -1) {
    const lines = text.split('\n').filter(l => l.indexOf('data: ') === 0);
    if (lines.length > 0) {
      try { return JSON.parse(lines[lines.length - 1].slice(6)); } catch(e) {}
    }
  }
  try { return JSON.parse(text); } catch(e) { return { raw: text }; }
}

// 統一呼叫分流
async function dispatchCall(name, args, env) {
  // local- 前綴 → 走本地 callTool
  if (name.indexOf('local-') === 0) {
    const localName = name.slice('local-'.length);
    const result = await callTool(localName, args, env);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: false,
    };
  }

  // upstream- 前綴 → 轉發到官方 Twinkle Hub
  if (name.indexOf('upstream-') === 0) {
    const upName = name.slice('upstream-'.length);
    return await callUpstream(upName, args, env);
  }

  // 沒前綴 → 先試本地,失敗再試上游
  try {
    const result = await callTool(name, args, env);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: false,
    };
  } catch(e) {
    return await callUpstream(name, args, env);
  }
}

async function callUpstream(name, args, env) {
  if (!env.TWINKLE_UPSTREAM_TOKEN) {
    throw new Error('TWINKLE_UPSTREAM_TOKEN not configured');
  }
  const res = await fetch(UPSTREAM_BASE, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.TWINKLE_UPSTREAM_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const parsed = parseUpstreamResponse(text);
  return (parsed && parsed.result) || { content: [{ type: 'text', text: text }], isError: false };
}

// ════════════════════════════════════════════════════════════════
//  v8 新增:Gemini API proxy
// ════════════════════════════════════════════════════════════════
async function handleGeminiProxy(request, env) {
  if (!env.GEMINI_API_KEY) {
    return jsonRes({ error: 'GEMINI_API_KEY not configured' }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch(e) { return jsonRes({ error: 'Invalid JSON' }, 400); }

  const model = body.model || 'gemini-2.5-flash';
  delete body.model;

  const upstream = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                   encodeURIComponent(model) + ':generateContent';

  const res = await fetch(upstream, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
  });
}

// ════════════════════════════════════════════════════════════════
//  v8.2 新增:Claude API proxy
//  Secret: ANTHROPIC_API_KEY（Cloudflare Dashboard → Settings → Variables）
// ════════════════════════════════════════════════════════════════
async function handleClaudeProxy(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonRes({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch(e) { return jsonRes({ error: 'Invalid JSON' }, 400); }

  // model 名稱自動修正：處理常見筆誤（帶小數點的版本號）
  if (body.model && typeof body.model === 'string') {
    body.model = body.model.replace(/claude-([a-z]+)-(\d+)\.(\d+)/, 'claude-$1-$2-$3');
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
  });
}

// ════════════════════════════════════════════════════════════════
//  v8.4/v8.5 RAG Wisdom Library
//
//  架構：
//    CF Workers AI (bge-m3)  → 生成 Embedding（支援中文）
//    Cloudflare Vectorize    → 向量索引（WISDOM_INDEX binding）
//    BUDDHA_KV               → 典籍 metadata 快取（加速讀取）
//
//  WisdomChunk schema (存在 Vectorize metadata):
//    { id, text, translation, concept_essence,
//      source, chapter, tags[], tradition, lang }
//
//  Embedding 拼接策略 (v8.5):
//    [原文] + [白話譯文] + [核心觀念] → 一起 Embedding
//    → 白話文提問也能精準命中文言典籍
//
//  KV 統計 key: buddha:rag:stats
// ════════════════════════════════════════════════════════════════

const RAG_STATS_KEY   = 'buddha:rag:stats';
const RAG_TOP_K       = 3;    // 每次查詢回傳最相近段落數
const RAG_SCORE_MIN   = 0.5;  // 相似度門檻（低於此分數不採用）
const EMBED_MODEL     = '@cf/baai/bge-m3';  // 支援中文的多語言模型

// ── 生成 Embedding（CF Workers AI）──
async function getEmbedding(text, env) {
  if (!env.AI) throw new Error('AI binding not configured');
  const res = await env.AI.run(EMBED_MODEL, {
    text: [text.slice(0, 512)],  // bge-m3 最大 512 token
  });
  // CF AI 回傳格式: { data: [[...floats]] }
  return res.data?.[0] || res[0] || null;
}

// ── 管理路由鑑權 ──
function checkAdminToken(request, env) {
  const token = request.headers.get('X-Admin-Token') || '';
  const expected = env.RAG_ADMIN_TOKEN || '';
  if (!expected) return { ok: false, err: 'RAG_ADMIN_TOKEN not configured' };
  if (token !== expected) return { ok: false, err: 'Invalid admin token' };
  return { ok: true };
}

// ── POST /rag/query → 語意搜尋 ──
// Body: { query, master?, top_k?, tradition? }
async function handleRagQuery(request, env) {
  if (!env.WISDOM_INDEX) return jsonRes({ error: 'WISDOM_INDEX binding not configured' }, 500);
  if (!env.AI)           return jsonRes({ error: 'AI binding not configured' }, 500);

  let body;
  try { body = await request.json(); }
  catch(e) { return jsonRes({ error: 'Invalid JSON' }, 400); }

  const { query, tradition, top_k = RAG_TOP_K } = body;
  if (!query) return jsonRes({ error: 'Missing: query' }, 400);

  // 1. 生成查詢向量
  let vector;
  try { vector = await getEmbedding(query, env); }
  catch(e) { return jsonRes({ error: 'Embedding failed: ' + e.message }, 500); }

  if (!vector) return jsonRes({ error: 'Embedding returned empty' }, 500);

  // 2. Vectorize 查詢
  const queryOpts = {
    topK: Math.min(Number(top_k) || RAG_TOP_K, 10),
    returnMetadata: 'all',
  };
  // 若指定傳承，加入 namespace filter
  if (tradition) queryOpts.namespace = tradition;

  const result = await env.WISDOM_INDEX.query(vector, queryOpts);
  const matches = (result.matches || [])
    .filter(m => m.score >= RAG_SCORE_MIN)
    .map(m => ({
      id:              m.id,
      score:           Math.round(m.score * 1000) / 1000,
      text:            m.metadata?.text            || '',
      translation:     m.metadata?.translation     || '',
      concept_essence: m.metadata?.concept_essence || '',
      source:          m.metadata?.source          || '',
      chapter:         m.metadata?.chapter         || '',
      tags:            m.metadata?.tags            || [],
      tradition:       m.metadata?.tradition       || '',
    }));

  return jsonRes({ query, count: matches.length, matches });
}

// ── POST /rag/index → 建檔單筆典籍段落（管理用）──
// Body: { text, translation?, concept_essence?, source, chapter, tags, tradition, lang? }
// Header: X-Admin-Token
async function handleRagIndex(request, env) {
  if (!env.WISDOM_INDEX) return jsonRes({ error: 'WISDOM_INDEX binding not configured' }, 500);
  if (!env.AI)           return jsonRes({ error: 'AI binding not configured' }, 500);

  const auth = checkAdminToken(request, env);
  if (!auth.ok) return jsonRes({ error: auth.err }, 401);

  let body;
  try { body = await request.json(); }
  catch(e) { return jsonRes({ error: 'Invalid JSON' }, 400); }

  const {
    text, source,
    translation    = '',
    concept_essence = '',
    chapter  = '',
    tags     = [],
    tradition = 'general',
    lang     = 'zh',
  } = body;
  if (!text)   return jsonRes({ error: 'Missing: text' }, 400);
  if (!source) return jsonRes({ error: 'Missing: source' }, 400);

  // v8.5：拼接原文 + 白話譯文 + 核心觀念，提升白話文命中率
  const embedText = [
    text,
    translation     ? '白話：' + translation     : '',
    concept_essence ? '核心：' + concept_essence : '',
  ].filter(Boolean).join('\n').slice(0, 512);

  let vector;
  try { vector = await getEmbedding(embedText, env); }
  catch(e) { return jsonRes({ error: 'Embedding failed: ' + e.message }, 500); }

  // v8.7：固定 ID（傳承＋來源＋章節＋原文的雜湊），重複建檔會覆蓋同一筆而非新增重複向量
  const idBytes = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode([tradition, source, chapter, text].join('\u0001')));
  const id = 'wisdom_' + [...new Uint8Array(idBytes)].slice(0, 12)
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const metadata = {
    text:            text.slice(0, 800),
    translation:     translation.slice(0, 300),
    concept_essence: concept_essence.slice(0, 150),
    source,
    chapter,
    tags:      Array.isArray(tags) ? tags.join(',') : tags,
    tradition,
    lang,
    indexed_at: new Date().toISOString(),
  };

  await env.WISDOM_INDEX.upsert([{
    id,
    values:    vector,
    metadata,
    namespace: tradition,
  }]);

  // 更新 KV 統計
  const kv = env.BUDDHA_KV;
  if (kv) {
    const stats = (await kvGet(kv, RAG_STATS_KEY)) || { total: 0, by_tradition: {} };
    stats.total = (stats.total || 0) + 1;
    stats.by_tradition[tradition] = (stats.by_tradition[tradition] || 0) + 1;
    stats.last_indexed = new Date().toISOString();
    await kvSet(kv, RAG_STATS_KEY, stats);
  }

  return jsonRes({ ok: true, id, source, chapter, tradition });
}

// ── DELETE /rag/:id → 刪除單筆（管理用）──
async function handleRagDelete(id, request, env) {
  if (!env.WISDOM_INDEX) return jsonRes({ error: 'WISDOM_INDEX binding not configured' }, 500);

  const auth = checkAdminToken(request, env);
  if (!auth.ok) return jsonRes({ error: auth.err }, 401);

  await env.WISDOM_INDEX.deleteByIds([id]);
  return jsonRes({ ok: true, deleted: id });
}

// ── GET /rag/stats ──
async function handleRagStats(request, env) {
  const kv = env.BUDDHA_KV;
  let stats = { total: 0, by_tradition: {} };
  if (kv) stats = (await kvGet(kv, RAG_STATS_KEY)) || stats;
  // v8.6：以 Vectorize 實際向量數為準（KV 統計有並行寫入競態，且 BUDDHA_KV 可能未綁定）
  let vectorCount = null;
  if (env.WISDOM_INDEX) {
    try {
      const info = await env.WISDOM_INDEX.describe();
      vectorCount = info.vectorCount ?? info.vectorsCount ?? null;
    } catch (e) { /* ignore */ }
  }
  if (vectorCount !== null) stats.total = Math.max(vectorCount, 0);
  return jsonRes({
    stats,
    vector_count:       vectorCount,
    kv_bound:           !!kv,
    wisdom_index_bound: !!env.WISDOM_INDEX,
    ai_bound:           !!env.AI,
    embed_model:        EMBED_MODEL,
  });
}

// ════════════════════════════════════════════════════════════════
//  v8.3 新增:Memory Companion 系統
//
//  KV key 設計:
//    buddha:mem:{uid}          → JSON array of MemoryItem
//    buddha:summary:{uid}      → JSON  DailySummary (最新一筆)
//    buddha:conv:{uid}         → JSON array (最近 30 則對話,供每日摘要用)
//
//  MemoryItem schema:
//    { id, summary, emotional_tag, importance, master, created_at, updated_at }
//
//  DailySummary schema:
//    { date, emotional_trend, recurring_themes, insight, master, generated_at }
// ════════════════════════════════════════════════════════════════

const MEM_KEY   = uid => `buddha:mem:${uid}`;
const CONV_KEY  = uid => `buddha:conv:${uid}`;
const SUM_KEY   = uid => `buddha:summary:${uid}`;
const MAX_MEM   = 30;   // 每位使用者最多保留幾筆長期記憶
const MAX_CONV  = 30;   // 每日摘要用的對話快取筆數

// ── KV 輔助 ──
async function kvGet(kv, key) {
  if (!kv) return null;
  try { const v = await kv.get(key); return v ? JSON.parse(v) : null; }
  catch(e) { return null; }
}
async function kvSet(kv, key, value, ttl) {
  if (!kv) return;
  const opts = ttl ? { expirationTtl: ttl } : {};
  await kv.put(key, JSON.stringify(value), opts);
}

// ── GET /memory/:uid → 記憶列表 ──
async function handleMemoryList(uid, env) {
  const kv = env.BUDDHA_KV;
  if (!kv) return jsonRes({ error: 'BUDDHA_KV not bound' }, 500);
  const mems = (await kvGet(kv, MEM_KEY(uid))) || [];
  return jsonRes({ uid, count: mems.length, memories: mems });
}

// ── POST /memory/:uid → 寫入單筆記憶 ──
async function handleMemoryWrite(uid, request, env) {
  const kv = env.BUDDHA_KV;
  if (!kv) return jsonRes({ error: 'BUDDHA_KV not bound' }, 500);
  let body;
  try { body = await request.json(); }
  catch(e) { return jsonRes({ error: 'Invalid JSON' }, 400); }

  const mems = (await kvGet(kv, MEM_KEY(uid))) || [];
  const now  = new Date().toISOString();
  const mid  = 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
  const item = {
    id:            mid,
    summary:       body.summary       || '',
    emotional_tag: body.emotional_tag || 'neutral',
    importance:    Math.min(Math.max(Number(body.importance) || 5, 1), 10),
    master:        body.master        || 'general',
    created_at:    now,
    updated_at:    now,
  };
  mems.unshift(item);
  // 按重要度排序，截斷最舊低重要度的
  mems.sort((a,b) => b.importance - a.importance);
  const trimmed = mems.slice(0, MAX_MEM);
  await kvSet(kv, MEM_KEY(uid), trimmed);
  return jsonRes({ ok: true, id: mid, item });
}

// ── DELETE /memory/:uid/:mid ──
async function handleMemoryDelete(uid, mid, env) {
  const kv = env.BUDDHA_KV;
  if (!kv) return jsonRes({ error: 'BUDDHA_KV not bound' }, 500);
  const mems = (await kvGet(kv, MEM_KEY(uid))) || [];
  const filtered = mems.filter(m => m.id !== mid);
  await kvSet(kv, MEM_KEY(uid), filtered);
  return jsonRes({ ok: true, deleted: mems.length - filtered.length });
}

// ── GET /memory/:uid/summary ──
async function handleMemorySummaryGet(uid, env) {
  const kv = env.BUDDHA_KV;
  if (!kv) return jsonRes({ error: 'BUDDHA_KV not bound' }, 500);
  const summary = await kvGet(kv, SUM_KEY(uid));
  return jsonRes({ uid, summary: summary || null });
}

// ── POST /memory/extract → 核心：抽取長期記憶 ──
// Body: { uid, master, messages: [{role,content},...] }
async function handleMemoryExtract(request, env) {
  const kv = env.BUDDHA_KV;
  if (!kv)                    return jsonRes({ error: 'BUDDHA_KV not bound' }, 500);
  if (!env.ANTHROPIC_API_KEY) return jsonRes({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

  let body;
  try { body = await request.json(); }
  catch(e) { return jsonRes({ error: 'Invalid JSON' }, 400); }

  const { uid, master = 'general', messages = [] } = body;
  if (!uid)              return jsonRes({ error: 'Missing: uid' }, 400);
  if (!messages.length)  return jsonRes({ ok: true, extracted: 0, reason: 'no messages' });

  // 只取最近 6 則（3輪）做分析，省 token
  const recentMsgs = messages.slice(-6);
  const convText = recentMsgs
    .map(m => `【${m.role === 'user' ? '修行者' : '導師'}】${m.content}`)
    .join('\n');

  // 同步把對話存進快取（供每日摘要用）
  const convCache = (await kvGet(kv, CONV_KEY(uid))) || [];
  recentMsgs.forEach(m => convCache.push({
    role: m.role, content: m.content.slice(0, 300),
    ts: new Date().toISOString(), master
  }));
  await kvSet(kv, CONV_KEY(uid), convCache.slice(-MAX_CONV));

  // Memory Extractor Prompt
  const extractPrompt = `你是一位佛法修行記錄員。請分析以下對話，判斷是否含有值得長期記憶的內容。

【判斷標準】只記錄以下類型（否則回傳 null）：
- 重複出現的情緒困擾（焦慮、悲傷、憤怒、恐懼）
- 重大人生處境（失業、失戀、家人生病、重大決定）
- 穩定的個人特質或偏好（對哪種法門特別有共鳴）
- 有意義的個人洞見或轉化時刻

【對話內容】
${convText}

【回應格式】嚴格只回傳 JSON，不加任何說明文字：
若值得記憶：
{"should_save": true, "summary": "簡短摘要（30字內）", "emotional_tag": "情緒標籤（如：焦慮/悲傷/迷惘/平靜/感恩）", "importance": 重要度數字1-10}

若不值得記憶：
{"should_save": false}`;

  let extracted = 0;
  let savedItem = null;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',  // 省 token，用 Haiku
        max_tokens: 200,
        messages: [{ role: 'user', content: extractPrompt }],
      }),
    });

    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text || '';
    const clean   = rawText.replace(/```json|```/g, '').trim();
    const result  = JSON.parse(clean);

    if (result.should_save) {
      // 寫入 KV
      const mems = (await kvGet(kv, MEM_KEY(uid))) || [];
      const now  = new Date().toISOString();
      const mid  = 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
      savedItem  = {
        id:            mid,
        summary:       result.summary       || '',
        emotional_tag: result.emotional_tag || 'neutral',
        importance:    Math.min(Math.max(Number(result.importance) || 5, 1), 10),
        master,
        created_at:    now,
        updated_at:    now,
      };
      mems.unshift(savedItem);
      mems.sort((a,b) => b.importance - a.importance);
      await kvSet(kv, MEM_KEY(uid), mems.slice(0, MAX_MEM));
      extracted = 1;
    }
  } catch(e) {
    // 抽取失敗不中斷主流程，靜默記錄
    return jsonRes({ ok: true, extracted: 0, error: e.message });
  }

  return jsonRes({ ok: true, extracted, saved: savedItem });
}

// ── Scheduled Event:每日反思摘要(UTC 16:00 = 台灣 00:00)──
async function handleDailyReflection(env) {
  const kv = env.BUDDHA_KV;
  if (!kv || !env.ANTHROPIC_API_KEY) return;

  // 列出所有有對話快取的 uid
  // 用 list prefix 取得所有 buddha:conv: key
  let cursor;
  const uids = [];
  do {
    const listed = await kv.list({ prefix: 'buddha:conv:', cursor });
    listed.keys.forEach(k => uids.push(k.name.replace('buddha:conv:', '')));
    cursor = listed.cursor;
  } while (cursor);

  for (const uid of uids) {
    try {
      const convCache = (await kvGet(kv, CONV_KEY(uid))) || [];
      if (convCache.length < 4) continue; // 對話太少不摘要

      const convText = convCache
        .map(m => `【${m.role === 'user' ? '修行者' : '導師'}】${m.content}`)
        .join('\n');

      const master = convCache[convCache.length-1]?.master || 'general';

      const prompt = `你是一位佛法修行觀察員。請分析以下一天內的修行對話，生成簡短的反思摘要。

【對話記錄】
${convText.slice(0, 3000)}

嚴格只回傳 JSON：
{
  "emotional_trend": "今日整體情緒傾向（10字內）",
  "recurring_themes": ["主題1", "主題2"],
  "insight": "導師觀察到的洞見（30字內）",
  "encouragement": "給修行者的一句鼓勵（20字內）"
}`;

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-5-5',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const aiData = await aiRes.json();
      const rawText = aiData.content?.[0]?.text || '';
      const clean   = rawText.replace(/```json|```/g, '').trim();
      const result  = JSON.parse(clean);

      const summary = {
        date:            new Date().toISOString().slice(0,10),
        emotional_trend: result.emotional_trend || '',
        recurring_themes: result.recurring_themes || [],
        insight:         result.insight          || '',
        encouragement:   result.encouragement    || '',
        master,
        generated_at:    new Date().toISOString(),
      };

      // 摘要保留 7 天
      await kvSet(kv, SUM_KEY(uid), summary, 7 * 24 * 3600);
      // 清空當天對話快取
      await kvSet(kv, CONV_KEY(uid), []);
    } catch(e) {
      // 單一 uid 失敗不中斷其他人
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  v7.2 既有:MCP Server Info / JSON-RPC handler
// ════════════════════════════════════════════════════════════════
function handleMcpInfo(request, env) {
  const url = new URL(request.url);
  return jsonRes({
    protocol: 'mcp',
    version: '2024-11-05',
    name: 'twinklehub',
    displayName: 'Twinklehub · 政府開放資料 AI Hub',
    description: '整合 data.gov.tw 49,343 筆資料集,支援房地產、交通、環境主題。',
    vendor: 'Twinklehub',
    capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
    endpoint: url.origin + '/mcp',
  });
}

async function handleMcpRequest(request, env) {
  let body;
  try { body = await request.json(); }
  catch (e) { return mcpErr(null, -32700, 'Parse error'); }

  const { id, method, params } = body;
  console.log('[MCP]', method, JSON.stringify(params || {}).substring(0, 200));

  switch (method) {
    case 'initialize':
      return mcpOk(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false } },
        serverInfo: { name: 'twinklehub', version: '8.7' },
      });
    case 'tools/list':
      return mcpOk(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const toolName = params && params.name;
      const toolArgs = (params && params.arguments) || {};
      try {
        const result = await callTool(toolName, toolArgs, env);
        return mcpOk(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        });
      } catch (e) {
        return mcpOk(id, {
          content: [{ type: 'text', text: '工具執行失敗:' + e.message }],
          isError: true,
        });
      }
    }
    case 'resources/list': return mcpOk(id, { resources: [] });
    case 'prompts/list':   return mcpOk(id, { prompts: [] });
    case 'ping':           return mcpOk(id, {});
    default: return mcpErr(id, -32601, 'Method not found: ' + method);
  }
}

// ════════════════════════════════════════════════════════════════
//  v7.2 既有:本地工具實作
// ════════════════════════════════════════════════════════════════
async function callTool(name, args, env) {
  switch (name) {
    case 'search_datasets':       return toolSearchDatasets(args, env);
    case 'get_dataset_info':      return toolGetDatasetInfo(args, env);
    case 'fetch_dataset_records': return toolFetchRecords(args, env);
    case 'summarize_topic':       return toolSummarizeTopic(args, env);
    default: throw new Error('Unknown tool: ' + name);
  }
}

async function proxyFetch(targetUrl, timeoutMs) {
  console.log('[DirectFetch]', targetUrl);
  const res = await fetch(targetUrl, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://data.gov.tw/',
      'Origin': 'https://data.gov.tw',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
    signal: AbortSignal.timeout(timeoutMs || 15000),
    cf: { cacheTtl: 60 },
  });
  console.log('[DirectFetch Status]', res.status, res.headers.get('content-type'));
  return res;
}

const FIELD_MAP = {
  '縣市': 'city', '鄉鎮市區': 'district', '土地位置建物門牌': 'address',
  '總價元': 'total_price', '單價元平方公尺': 'unit_price_m2',
  '建物移轉總面積平方公尺': 'build_area_m2', '交易年月日': 'trade_date',
  '建物型態': 'building_type', '移轉層次': 'floor', '建築完成年月': 'build_date',
  '車位總價元': 'parking_price',
  '測站名稱': 'station', '縣市名稱': 'city_name', 'AQI': 'aqi',
  '空氣品質指標': 'aqi', 'PM2.5': 'pm25', 'PM10': 'pm10',
  '狀態': 'status', '發布時間': 'publish_time', '監測時間': 'monitor_time',
  '道路名稱': 'road_name', '事故類別': 'accident_type', '死亡人數': 'death_count',
  '受傷人數': 'injury_count', '發生時間': 'occur_time', '發生地點': 'location',
  '機關名稱': 'org_name', '更新時間': 'update_time', '資料年度': 'data_year',
  '備註': 'note', '編號': 'id_num',
};

function normalizeFields(records) {
  return records.map(row => {
    const normalized = {};
    Object.entries(row).forEach(([k, v]) => {
      const enKey = FIELD_MAP[k.trim()];
      normalized[k] = v;
      if (enKey) normalized[enKey] = v;
    });
    return normalized;
  });
}

async function fetchCsvAsRecords(csvUrl, limit, env) {
  console.log('[CSV Fetch]', csvUrl);
  const res = await proxyFetch(csvUrl, 20000);
  if (!res.ok) throw new Error('CSV 下載失敗:HTTP ' + res.status);
  const text = await res.text();
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV 內容為空');
  const headers = parseCsvLine(lines[0]);
  const records = [];
  for (let i = 1; i < Math.min(lines.length, limit + 1); i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length === 0) continue;
    const row = {};
    headers.forEach((h, idx) => {
      const key = h.trim().replace(/^"/, '').replace(/"$/, '');
      row[key] = (cols[idx] || '').trim().replace(/^"/, '').replace(/"$/, '');
    });
    records.push(row);
  }
  return {
    source: 'csv',
    total: lines.length - 1,
    returned: records.length,
    fields: headers.map(h => ({ id: h.trim(), type: 'text' })),
    records,
  };
}

function parseCsvLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      result.push(cur); cur = '';
    } else { cur += ch; }
  }
  result.push(cur);
  return result;
}

async function toolSearchDatasets(args, env) {
  const topic   = args.topic || 'real_estate';
  const keyword = args.keyword || '';
  const limit   = Math.min(parseInt(args.limit) || 10, 30);
  const topicDef = TOPICS[topic];
  if (!topicDef) throw new Error('未知主題:' + topic);

  const searchKw = keyword || topicDef.keywords[0];
  const cacheKey = 'v5:search:' + topic + ':' + searchKw + ':' + limit;

  if (env.TWINKLEHUB_KV) {
    try {
      const hit = await env.TWINKLEHUB_KV.get(cacheKey);
      if (hit) { const d = JSON.parse(hit); d._cached = true; return d; }
    } catch(e) {}
  }

  let raw = null;
  let usedEndpoint = '';

  try {
    const u = new URL(GOV_SEARCH_BASE);
    u.searchParams.set('q', searchKw);
    u.searchParams.set('rows', String(limit));
    const res = await proxyFetch(u.toString(), 12000);
    if (res.ok) {
      const text = await res.text();
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        raw = JSON.parse(text);
        usedEndpoint = 'CKAN-action';
      }
    }
  } catch(e) { console.warn('[Search CKAN]', e.message); }

  if (!raw) {
    try {
      const u = new URL(GOV_DATASET_BASE);
      u.searchParams.set('keyword', searchKw);
      u.searchParams.set('size', String(limit));
      u.searchParams.set('page', '1');
      const res = await proxyFetch(u.toString(), 12000);
      if (res.ok) {
        const text = await res.text();
        if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
          raw = JSON.parse(text);
          usedEndpoint = 'v2-dataset';
        }
      }
    } catch(e) { console.warn('[Search v2]', e.message); }
  }

  if (!raw) throw new Error('政府 API 無法連線,請稍後再試');

  let items = [], total = 0;
  if (raw.result && raw.result.results) { items = raw.result.results; total = raw.result.count || items.length; }
  else if (raw.success && raw.result && raw.result.results) { items = raw.result.results; total = raw.result.count || items.length; }
  else if (Array.isArray(raw.result)) { items = raw.result; total = items.length; }
  else if (Array.isArray(raw))         { items = raw; total = items.length; }
  else if (raw.data && Array.isArray(raw.data)) { items = raw.data; total = raw.total || items.length; }

  const result = {
    topic: topicDef.label,
    keyword_used: searchKw,
    endpoint_used: usedEndpoint,
    total_found: total,
    datasets: items.slice(0, limit).map(d => ({
      id:           d.id || d.identifier || d.name || '',
      title:        d.title || d.name || '',
      description:  (d.description || d.notes || d.memo || '').substring(0, 150),
      organization: d.organization
        ? (typeof d.organization === 'object'
            ? (d.organization.title || d.organization.name || '')
            : d.organization)
        : (d.author || d.maintainer || d.publisher || ''),
      category: d.groups ? ((d.groups[0] && d.groups[0].title) || '') : (d.category || d.type || ''),
      tags: (() => {
        const t = d.tags || d.keyword || [];
        if (typeof t === 'string') return t;
        if (!Array.isArray(t)) return '';
        return t.map(x => typeof x === 'string' ? x : (x.display_name || x.name || '')).join(', ');
      })(),
      format: (d.resources || d.distribution || []).map(r => r.format || r.mediaType || '').filter(Boolean).join(', '),
      updated: d.metadata_modified || d.modified || d.revision_timestamp || '',
      resource_count: (d.resources || d.distribution || []).length || d.num_resources || 0,
      url: d.url || ('https://data.gov.tw/dataset/' + (d.name || d.id || '')),
    })),
    _cached: false,
  };

  if (env.TWINKLEHUB_KV && result.datasets.length > 0) {
    await env.TWINKLEHUB_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SEARCH }).catch(() => {});
  }
  return result;
}

async function toolGetDatasetInfo(args, env) {
  const id = args.dataset_id;
  if (!id) throw new Error('缺少 dataset_id');
  const cacheKey = 'dataset:' + id;
  if (env.TWINKLEHUB_KV) {
    try {
      const cached = await env.TWINKLEHUB_KV.get(cacheKey);
      if (cached) return { ...JSON.parse(cached), _cached: true };
    } catch(e) {}
  }

  let res = null;
  let fetchUrl = GOV_DATASET_BASE + '/' + encodeURIComponent(id);
  res = await proxyFetch(fetchUrl, 10000);
  if (!res.ok) {
    const fallback = 'https://data.gov.tw/api/3/action/package_show?id=' + encodeURIComponent(id);
    res = await proxyFetch(fallback, 10000);
  }
  if (!res.ok) throw new Error('找不到資料集:' + id + '(HTTP ' + res.status + ')');

  const rawText = await res.text();
  let raw = {};
  try { raw = JSON.parse(rawText); } catch(e) { throw new Error('回傳格式錯誤:' + rawText.substring(0, 100)); }
  const d = (raw.success && raw.result) ? raw.result : (raw.result || raw);

  const result = {
    id:           d.id || id,
    title:        d.title || d.name || '',
    description:  d.description || d.notes || '',
    organization: d.organization ? (d.organization.title || d.organization) : '',
    license:      d.license_title || d.license || '',
    updated:      d.modified || d.metadata_modified || '',
    frequency:    d.accrual_periodicity || d.frequency || '不定期',
    tags:         (d.tags || []).map(t => typeof t === 'string' ? t : t.name),
    resources: (d.resources || []).map(r => ({
      resource_id: r.id || '',
      name:        r.name || r.description || '',
      format:      r.format || '',
      url:         r.url || '',
      created:     r.created || '',
      modified:    r.last_modified || r.modified || '',
    })),
    gov_url: 'https://data.gov.tw/dataset/' + (d.id || id),
    _cached: false,
  };

  if (env.TWINKLEHUB_KV) {
    await env.TWINKLEHUB_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 }).catch(() => {});
  }
  return result;
}

async function toolFetchRecords(args, env) {
  const resourceId = args.resource_id;
  if (!resourceId) throw new Error('缺少 resource_id');
  const limit   = Math.min(parseInt(args.limit) || 20, 100);
  const filters = args.filters || {};
  const keyword = args.keyword || '';

  const u1 = new URL('https://data.gov.tw/api/3/action/datastore_search');
  u1.searchParams.set('resource_id', resourceId);
  u1.searchParams.set('limit', String(limit));
  u1.searchParams.set('offset', '0');
  if (keyword) u1.searchParams.set('q', keyword);
  if (Object.keys(filters).length > 0) u1.searchParams.set('filters', JSON.stringify(filters));

  const res = await proxyFetch(u1.toString(), 15000);

  if (!res.ok || res.status === 404) {
    try {
      const infoRes = await proxyFetch(
        'https://data.gov.tw/api/3/action/resource_show?id=' + encodeURIComponent(resourceId),
        10000
      );
      if (infoRes.ok) {
        const infoRaw = await infoRes.json();
        const rInfo = (infoRaw.success && infoRaw.result) ? infoRaw.result : infoRaw;
        const csvUrl = rInfo.url || '';
        if (csvUrl && (csvUrl.endsWith('.csv') || csvUrl.includes('csv'))) {
          const csvResult = await fetchCsvAsRecords(csvUrl, limit, env);
          csvResult.records = normalizeFields(csvResult.records);
          return { resource_id: resourceId, ...csvResult, source: 'csv_fallback' };
        }
      }
    } catch(csvErr) { console.warn('[CSV fallback]', csvErr.message); }
    const errText = await res.text().catch(() => '');
    throw new Error('資料取得失敗:HTTP ' + res.status + ' | ' + errText.substring(0, 100));
  }

  const raw = await res.json();
  let result_data = raw;
  if (raw.success && raw.result) result_data = raw.result;
  else if (raw.result)           result_data = raw.result;
  const records = result_data.records || [];
  const fields  = result_data.fields  || [];

  return {
    resource_id: resourceId,
    source: 'datastore',
    total: result_data.total || records.length,
    returned: records.length,
    fields: fields.map(f => ({ id: f.id, type: f.type })),
    records: normalizeFields(records.slice(0, limit)),
    filters_applied: filters,
    keyword_used: keyword,
  };
}

async function toolSummarizeTopic(args, env) {
  const topic = args.topic || 'real_estate';
  const topicDef = TOPICS[topic];
  if (!topicDef) throw new Error('未知主題:' + topic);

  const cacheKey = 'v6:summary:' + topic;
  if (env.TWINKLEHUB_KV) {
    try {
      const cached = await env.TWINKLEHUB_KV.get(cacheKey);
      if (cached) return { ...JSON.parse(cached), _cached: true };
    } catch(e) {}
  }

  const dsMap = new Map();
  const orgCount = {};
  for (const kw of topicDef.keywords.slice(0, 3)) {
    try {
      const res = await toolSearchDatasets({ topic, keyword: kw, limit: 30 }, env);
      (res.datasets || []).forEach(d => {
        if (!d.id) return;
        dsMap.set(d.id, d);
        const org = d.organization || '未知機關';
        orgCount[org] = (orgCount[org] || 0) + 1;
      });
    } catch(e) { console.warn('[Summarize]', kw, e.message); }
  }

  const topOrgs = Object.entries(orgCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([org, count]) => ({ org, count }));

  const result = {
    topic: topicDef.label,
    dataset_count: dsMap.size,
    keywords_used: topicDef.keywords.slice(0, 3),
    top_organizations: topOrgs,
    sample_datasets: [...dsMap.values()].slice(0, 5).map(d => ({
      id: d.id || '', title: d.title || '', org: d.organization || '', url: d.url || '',
    })),
    note: '統計數據為抽樣估算',
    _cached: false,
  };

  if (env.TWINKLEHUB_KV) {
    await env.TWINKLEHUB_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 }).catch(() => {});
  }
  return result;
}

// ════════════════════════════════════════════════════════════════
//  回應工具函式
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
//  v8.1 新增:實價登錄資料清洗
//  上游格式:{ columns: [欄位名...], rows: [[值...], ...] }
// ════════════════════════════════════════════════════════════════
function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

// 把 columns + rows 二維陣列轉成物件陣列
function rowsToObjects(columns, rows) {
  if (!Array.isArray(columns) || !Array.isArray(rows)) return [];
  return rows.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

function cleanLvrRows(columns, rows) {
  const PING_PER_M2 = 3.305785; // 官方換算:1 坪 = 3.305785 平方公尺
  const objs = rowsToObjects(columns, rows);

  function pick(row, keys) {
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
    }
    return null;
  }

  return objs.map(row => {
    const r = {
      id:         pick(row, ['編號']),
      address:    pick(row, ['土地位置建物門牌_半形', '土地位置建物門牌']),
      city:       pick(row, ['city']),
      district:   pick(row, ['鄉鎮市區']),
      target:     pick(row, ['交易標的']),
      type:       pick(row, ['建物型態']),
      usage:      pick(row, ['主要用途']),
      material:   pick(row, ['主要建材']),
      floor:      pick(row, ['移轉層次']),
      totalFloor: pick(row, ['總樓層數']),
      buildDate:  pick(row, ['建築完成年月']),
      rooms:      pick(row, ['建物現況格局-房']),
      halls:      pick(row, ['建物現況格局-廳']),
      baths:      pick(row, ['建物現況格局-衛']),
      totalPrice: toNum(pick(row, ['總價元'])),
      unitPriceM2: toNum(pick(row, ['單價元平方公尺'])),
      areaM2:     toNum(pick(row, ['建物移轉總面積平方公尺'])),
      mainArea:   toNum(pick(row, ['主建物面積'])),
      subArea:    toNum(pick(row, ['附屬建物面積'])),
      balconyArea: toNum(pick(row, ['陽台面積'])),
      landArea:   toNum(pick(row, ['土地移轉總面積平方公尺'])),
      // 車位
      parkType:   pick(row, ['車位類別']),
      parkAreaM2: toNum(pick(row, ['車位移轉總面積(平方公尺)', '車位移轉總面積平方公尺'])),
      parkPrice:  toNum(pick(row, ['車位總價元'])),
      tradeDate:  pick(row, ['iso_trade_date', '交易年月日']),
      season:     pick(row, ['season']),
      note:       pick(row, ['備註']),
      hasManagement: pick(row, ['有無管理組織']),
      hasElevator:   pick(row, ['電梯']),
      layoutOpen:    pick(row, ['建物現況格局-隔間']),
    };

    if (r.areaM2) r.areaPing = Math.round(r.areaM2 / PING_PER_M2 * 100) / 100;
    if (r.unitPriceM2) r.pricePerPing = Math.round(r.unitPriceM2 * PING_PER_M2);
    if (!r.pricePerPing && r.totalPrice && r.areaPing) {
      r.pricePerPing = Math.round(r.totalPrice / r.areaPing);
    }
    // 室內坪數(主建物 + 附屬建物,不含公設與車位)
    var indoorM2 = (r.mainArea || 0) + (r.subArea || 0);
    if (indoorM2 > 0) r.indoorPing = Math.round(indoorM2 / PING_PER_M2 * 100) / 100;
    // 主建物坪數
    if (r.mainArea) r.mainPing = Math.round(r.mainArea / PING_PER_M2 * 100) / 100;
    // 車位坪數
    if (r.parkAreaM2) r.parkPing = Math.round(r.parkAreaM2 / PING_PER_M2 * 100) / 100;
    // 扣除車位後的「房屋實際均價」(更能反映真實行情)
    if (r.totalPrice && r.areaPing) {
      var housePrice = r.totalPrice - (r.parkPrice || 0);
      var housePing  = r.areaPing - (r.parkPing || 0);
      if (housePing > 0) r.pricePerPingNoPark = Math.round(housePrice / housePing);
    }
    // 公設比(權狀總坪 - 室內坪)/ 權狀總坪
    if (r.areaPing && r.indoorPing && r.areaPing > r.indoorPing) {
      r.publicRatio = Math.round((1 - r.indoorPing / r.areaPing) * 1000) / 10; // %
    }
    if (r.rooms || r.halls || r.baths) {
      r.layout = (r.rooms || 0) + '房' + (r.halls || 0) + '廳' + (r.baths || 0) + '衛';
    }
    r.isSpecial = !!(r.note && String(r.note).trim());
    return r;
  });
}

function jsonRes(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: Object.assign({}, CORS, { 'Content-Type': 'application/json; charset=utf-8' }),
  });
}

function mcpOk(id, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
  });
}

function mcpErr(id, code, message) {
  return new Response(JSON.stringify({
    jsonrpc: '2.0', id, error: { code, message },
  }), {
    status: 200,
    headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
  });
}

// ════════════════════════════════════════════════════════════════
//  Chat HTML(內嵌,GET / 從瀏覽器訪問時回傳)
// ════════════════════════════════════════════════════════════════
const CHAT_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>🌟 Twinklehub 小幫手</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang TC", sans-serif;
    background: #0a0e27; color: #e4e6f0; font-size: 15px;
    display: flex; flex-direction: column;
  }
  header {
    padding: 12px 16px; background: #1a1f3a; border-bottom: 1px solid #2a3050;
    flex-shrink: 0; display: flex; justify-content: space-between; align-items: center;
  }
  header h1 { margin: 0; font-size: 17px; color: #4fc3f7; }
  header .sub { font-size: 11px; color: #8892b0; margin-top: 2px; }
  .settings-btn {
    background: transparent; color: #8892b0; border: 1px solid #3a4070;
    width: 36px; height: 36px; border-radius: 50%; font-size: 16px;
    cursor: pointer; -webkit-appearance: none;
  }
  #chat { flex: 1; overflow-y: auto; padding: 16px 12px; -webkit-overflow-scrolling: touch; }
  .msg { margin-bottom: 14px; display: flex; flex-direction: column; }
  .msg.user { align-items: flex-end; }
  .msg.assistant { align-items: flex-start; }
  .bubble {
    max-width: 88%; padding: 10px 14px; border-radius: 16px;
    line-height: 1.55; white-space: pre-wrap; word-break: break-word; font-size: 15px;
  }
  .user .bubble { background: #4fc3f7; color: #0a0e27; border-bottom-right-radius: 4px; }
  .assistant .bubble { background: #1a1f3a; color: #e4e6f0; border: 1px solid #2a3050; border-bottom-left-radius: 4px; }
  .tool-call {
    background: #050816; border: 1px solid #2a3050; border-radius: 8px;
    padding: 8px 10px; margin-top: 6px; font-size: 12px; color: #64ffda;
    font-family: ui-monospace, monospace; max-width: 88%;
    overflow-x: auto; -webkit-overflow-scrolling: touch;
  }
  .tool-call .label { color: #8892b0; margin-bottom: 2px; }
  .tool-call .label .badge {
    background: #2a3050; color: #4fc3f7; padding: 1px 6px;
    border-radius: 4px; font-size: 10px; margin-left: 6px;
  }
  .tool-call .badge.upstream { color: #ffd700; }
  .tool-call pre { margin: 0; white-space: pre-wrap; word-break: break-all; }
  .tool-call.error { border-color: #ff6b9d; }
  .tool-call.error .label { color: #ff6b9d; }
  .thinking { color: #8892b0; font-style: italic; font-size: 13px; padding: 4px 14px; }
  footer {
    padding: 10px 12px; background: #1a1f3a; border-top: 1px solid #2a3050;
    flex-shrink: 0; padding-bottom: calc(10px + env(safe-area-inset-bottom));
  }
  .input-row { display: flex; gap: 8px; align-items: flex-end; }
  textarea {
    flex: 1; background: #0a0e27; color: #e4e6f0;
    border: 1px solid #3a4070; padding: 10px 12px; border-radius: 20px;
    font-size: 16px; -webkit-appearance: none; resize: none;
    min-height: 40px; max-height: 120px; font-family: inherit; line-height: 1.4;
  }
  button.send {
    background: #4fc3f7; color: #0a0e27; border: none;
    width: 44px; height: 44px; border-radius: 50%; font-size: 20px;
    cursor: pointer; flex-shrink: 0; -webkit-appearance: none; font-weight: 600;
  }
  button.send:disabled { background: #3a4070; color: #8892b0; }
  .examples { display: flex; gap: 6px; overflow-x: auto; padding: 0 0 8px; -webkit-overflow-scrolling: touch; }
  .examples::-webkit-scrollbar { display: none; }
  .example-chip {
    background: #2a3050; color: #4fc3f7; border: 1px solid #3a4070;
    padding: 6px 12px; border-radius: 16px; font-size: 13px;
    white-space: nowrap; cursor: pointer; flex-shrink: 0;
  }
  .example-chip:active { background: #3a4070; }
  .modal-bg {
    display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7); z-index: 100; padding: 16px;
    overflow-y: auto; -webkit-overflow-scrolling: touch;
  }
  .modal-bg.show { display: block; }
  .modal {
    background: #1a1f3a; border-radius: 12px; padding: 16px;
    max-width: 600px; margin: 40px auto; border: 1px solid #3a4070;
  }
  .modal h2 { margin: 0 0 12px; font-size: 16px; color: #4fc3f7; }
  .modal label { display: block; font-size: 12px; color: #8892b0; margin: 12px 0 4px; }
  .toggle-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; }
  .toggle-row .title { font-size: 14px; color: #e4e6f0; }
  .toggle-row .desc { font-size: 12px; color: #8892b0; margin-top: 2px; }
  .switch { position: relative; width: 48px; height: 26px; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
    background: #3a4070; border-radius: 26px; transition: 0.3s;
  }
  .slider::before {
    position: absolute; content: ""; height: 20px; width: 20px;
    left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: 0.3s;
  }
  input:checked + .slider { background: #4fc3f7; }
  input:checked + .slider::before { transform: translateX(22px); }
  .modal input[type=text] {
    width: 100%; background: #0a0e27; color: #e4e6f0;
    border: 1px solid #3a4070; padding: 10px; border-radius: 8px;
    font-size: 16px; -webkit-appearance: none;
  }
  .modal-btn {
    background: #4fc3f7; color: #0a0e27; border: none;
    padding: 10px 14px; border-radius: 8px; font-size: 14px;
    width: 100%; margin-top: 16px; cursor: pointer;
    -webkit-appearance: none; font-weight: 600;
  }
  .stats { font-size: 11px; color: #8892b0; margin-top: 8px; text-align: center; }
</style>
</head>
<body>

<header>
  <div>
    <h1>🌟 Twinklehub 小幫手</h1>
    <div class="sub">Gemini × 政府開放資料</div>
  </div>
  <button class="settings-btn" id="settingsBtn">⚙️</button>
</header>

<div id="chat">
  <div class="msg assistant">
    <div class="bubble">嗨!我可以幫你查台灣政府開放資料(房地產/交通/環境)、立法院議案、政府採購、實價登錄、判決書、地理資訊等。

直接用中文問我即可。</div>
  </div>
</div>

<footer>
  <div class="examples" id="examples">
    <div class="example-chip">台中市實價登錄</div>
    <div class="example-chip">高雄空氣品質</div>
    <div class="example-chip">立法院本屆民法相關議案</div>
    <div class="example-chip">國防部去年最大決標</div>
    <div class="example-chip">列出所有可用工具</div>
  </div>
  <div class="input-row">
    <textarea id="input" placeholder="輸入問題..." rows="1"></textarea>
    <button class="send" id="send">➤</button>
  </div>
</footer>

<div class="modal-bg" id="settingsModal">
  <div class="modal">
    <h2>⚙️ 設定</h2>

    <div class="toggle-row">
      <div>
        <div class="title">啟用上游 Twinkle Hub 工具</div>
        <div class="desc">關閉只用本地 4 工具,開啟加上官方 ~58 個工具</div>
      </div>
      <label class="switch">
        <input type="checkbox" id="upstreamToggle">
        <span class="slider"></span>
      </label>
    </div>

    <label>Gemini Model</label>
    <input type="text" id="modelName" value="gemini-2.5-flash">

    <button class="modal-btn" id="saveSettings">儲存並關閉</button>

    <div class="stats" id="statsDiv">尚未載入工具</div>
  </div>
</div>

<script>
// ════════════════════════════════════════════════════════════════
//  設定
// ════════════════════════════════════════════════════════════════
var ORIGIN = location.origin;
var settings = { useUpstream: false, modelName: 'gemini-2.5-flash' };

try {
  var saved = localStorage.getItem('twinklehub_settings');
  if (saved) {
    var parsed = JSON.parse(saved);
    for (var k in parsed) settings[k] = parsed[k];
  }
} catch (e) {}

function saveSettings() {
  settings.useUpstream = document.getElementById('upstreamToggle').checked;
  settings.modelName = document.getElementById('modelName').value.trim() || 'gemini-2.5-flash';
  try { localStorage.setItem('twinklehub_settings', JSON.stringify(settings)); } catch (e) {}
  toolsCache = null; // 重抓
  document.getElementById('settingsModal').classList.remove('show');
}

function loadSettingsUI() {
  document.getElementById('upstreamToggle').checked = settings.useUpstream;
  document.getElementById('modelName').value = settings.modelName;
}

document.getElementById('settingsBtn').addEventListener('click', function() {
  loadSettingsUI();
  document.getElementById('settingsModal').classList.add('show');
});
document.getElementById('saveSettings').addEventListener('click', saveSettings);
document.getElementById('settingsModal').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('show');
});

// ════════════════════════════════════════════════════════════════
//  狀態
// ════════════════════════════════════════════════════════════════
var MAX_ITERATIONS = 8;
var conversationContents = [];
var toolsCache = null;

var chatEl = document.getElementById('chat');
var inputEl = document.getElementById('input');
var sendBtn = document.getElementById('send');

inputEl.addEventListener('input', function() {
  this.style.height = '40px';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

document.querySelectorAll('.example-chip').forEach(function(chip) {
  chip.addEventListener('click', function() {
    inputEl.value = this.textContent;
    inputEl.dispatchEvent(new Event('input'));
    inputEl.focus();
  });
});

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function addMessage(role, text) {
  var div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = '<div class="bubble">' + escapeHtml(text) + '</div>';
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function addThinking(text) {
  var div = document.createElement('div');
  div.className = 'thinking';
  div.textContent = '⚡ ' + text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function addToolCall(name, args, result, isError) {
  var div = document.createElement('div');
  div.className = 'msg assistant';
  var cls = isError ? 'tool-call error' : 'tool-call';
  var source = 'local';
  if (name.indexOf('upstream_') === 0 || name.indexOf('upstream-') === 0) source = 'upstream';
  var badgeCls = source === 'upstream' ? 'badge upstream' : 'badge';
  var html = '<div class="' + cls + '">';
  html += '<div class="label">🔧 ' + escapeHtml(name) +
          ' <span class="' + badgeCls + '">' + source + '</span></div>';
  html += '<pre>' + escapeHtml(JSON.stringify(args || {}, null, 2)) + '</pre>';
  if (result !== undefined) {
    html += '<div class="label" style="margin-top:6px;">📦 結果</div>';
    var resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (resultStr.length > 800) resultStr = resultStr.slice(0, 800) + '\\n...(已截斷)';
    html += '<pre>' + escapeHtml(resultStr) + '</pre>';
  }
  html += '</div>';
  div.innerHTML = html;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// ════════════════════════════════════════════════════════════════
//  Schema sanitizer(Twinkle inputSchema → Gemini parameters)
// ════════════════════════════════════════════════════════════════
function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} };
  var clean = {};
  if (schema.type) {
    if (Array.isArray(schema.type)) {
      var nonNull = schema.type.filter(function(t) { return t !== 'null'; });
      clean.type = (nonNull[0] || 'string').toUpperCase();
    } else if (schema.type !== 'null') {
      clean.type = schema.type.toUpperCase();
    } else {
      clean.type = 'STRING';
    }
  }
  if (schema.description) clean.description = String(schema.description).slice(0, 500);
  if (Array.isArray(schema.enum)) clean.enum = schema.enum.map(String);
  if (schema.minimum !== undefined) clean.minimum = schema.minimum;
  if (schema.maximum !== undefined) clean.maximum = schema.maximum;
  if (schema.properties && typeof schema.properties === 'object') {
    clean.properties = {};
    Object.keys(schema.properties).forEach(function(k) {
      clean.properties[k] = sanitizeSchema(schema.properties[k]);
    });
  }
  if (schema.items) clean.items = sanitizeSchema(schema.items);
  if (Array.isArray(schema.required)) clean.required = schema.required;
  if (clean.type === 'OBJECT' && !clean.properties) clean.properties = {};
  return clean;
}

// Twinkle tool name 含 hyphen,Gemini function name 只接受 [a-zA-Z0-9_]
// 用 dash→雙底線 編碼,呼叫時還原
function encodeName(name) { return name.replace(/-/g, '__'); }
function decodeName(name) { return name.replace(/__/g, '-'); }

function twinkleToGeminiFunctions(twinkleTools) {
  return twinkleTools.map(function(t) {
    return {
      name: encodeName(t.name),
      description: (t.description || '').replace(/\\*\\*/g, '').slice(0, 1024),
      parameters: sanitizeSchema(t.inputSchema || { type: 'object', properties: {} })
    };
  });
}

// ════════════════════════════════════════════════════════════════
//  API 呼叫(全部走自己的 worker,單一網域)
// ════════════════════════════════════════════════════════════════
function loadTools() {
  if (toolsCache) return Promise.resolve(toolsCache);
  var url = ORIGIN + '/tools?upstream=' + (settings.useUpstream ? 'true' : 'false');
  return fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.result && data.result.tools) {
        toolsCache = data.result.tools;
        return toolsCache;
      }
      throw new Error('無法取得工具清單');
    });
}

function callTwinkleTool(geminiName, args) {
  var realName = decodeName(geminiName);
  return fetch(ORIGIN + '/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: realName, arguments: args || {} })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data && data.result && data.result.content) {
      var text = '';
      data.result.content.forEach(function(c) { if (c.type === 'text') text += c.text + '\\n'; });
      return text.trim() || JSON.stringify(data);
    }
    if (data && data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return JSON.stringify(data);
  });
}

function callGemini(contents, functions) {
  var body = {
    model: settings.modelName,
    contents: contents,
    tools: [{ functionDeclarations: functions }],
    systemInstruction: {
      parts: [{
        text: '你是台灣資料查詢小幫手。可用工具有兩類:' +
              '(1) local-* 前綴的本地工具(房地產/交通/環境主題),' +
              '(2) upstream-* 前綴的官方 Twinkle Hub 工具(立法院、政府採購、判決書、地理 fast-path 等)。' +
              '請用繁體中文簡潔回答。挑工具時優先讀工具描述,選最精準的 fast-path。' +
              '查詢結果太長時請摘要重點。若問題需要座標或縣市但使用者沒給,請問清楚再呼叫工具。'
      }]
    },
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
  };
  return fetch(ORIGIN + '/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r) { return r.json(); });
}

// ════════════════════════════════════════════════════════════════
//  對話循環
// ════════════════════════════════════════════════════════════════
function chat(userText) {
  inputEl.disabled = true;
  sendBtn.disabled = true;

  addMessage('user', userText);
  conversationContents.push({ role: 'user', parts: [{ text: userText }] });

  var thinking = addThinking('載入工具中...');

  loadTools()
    .then(function(tools) {
      var fns = twinkleToGeminiFunctions(tools);
      var stats = '已載入 ' + fns.length + ' 個工具' +
                  (settings.useUpstream ? '(本地 + 上游)' : '(僅本地)');
      var statsEl = document.getElementById('statsDiv');
      if (statsEl) statsEl.textContent = stats;
      thinking.textContent = '⚡ Gemini 思考中(' + fns.length + ' 工具可用)...';
      return iterate(fns, 0, thinking);
    })
    .catch(function(err) {
      if (thinking.parentNode) thinking.remove();
      addMessage('assistant', '❌ 錯誤:' + err.message);
    })
    .then(function() {
      if (thinking.parentNode) thinking.remove();
      inputEl.disabled = false;
      sendBtn.disabled = false;
      inputEl.focus();
    });
}

function iterate(functions, depth, thinking) {
  if (depth >= MAX_ITERATIONS) {
    addMessage('assistant', '⚠️ 達到最大查詢次數,請重新提問或縮小範圍');
    return Promise.resolve();
  }
  if (thinking) thinking.textContent = '⚡ Gemini 思考中(第 ' + (depth + 1) + ' 輪)...';

  return callGemini(conversationContents, functions)
    .then(function(response) {
      if (response.error) {
        throw new Error(response.error.message || JSON.stringify(response.error));
      }
      var candidate = response.candidates && response.candidates[0];
      if (!candidate) {
        throw new Error('Gemini 沒有回應:' + JSON.stringify(response).slice(0, 300));
      }
      var parts = (candidate.content && candidate.content.parts) || [];
      var textParts = [];
      var functionCalls = [];
      parts.forEach(function(p) {
        if (p.text) textParts.push(p.text);
        if (p.functionCall) functionCalls.push(p.functionCall);
      });
      if (textParts.length > 0) addMessage('assistant', textParts.join('\\n'));
      conversationContents.push({ role: 'model', parts: parts });

      if (functionCalls.length === 0) return;

      var responseParts = [];
      var promise = Promise.resolve();
      functionCalls.forEach(function(fc) {
        promise = promise.then(function() {
          return callTwinkleTool(fc.name, fc.args || {})
            .then(function(result) {
              addToolCall(fc.name, fc.args || {}, result, false);
              responseParts.push({
                functionResponse: {
                  name: fc.name,
                  response: { content: typeof result === 'string' ? result : JSON.stringify(result) }
                }
              });
            })
            .catch(function(err) {
              addToolCall(fc.name, fc.args || {}, '錯誤:' + err.message, true);
              responseParts.push({
                functionResponse: { name: fc.name, response: { error: err.message } }
              });
            });
        });
      });
      return promise.then(function() {
        conversationContents.push({ role: 'user', parts: responseParts });
        return iterate(functions, depth + 1, thinking);
      });
    });
}

sendBtn.addEventListener('click', function() {
  var text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  inputEl.style.height = '40px';
  chat(text);
});

inputEl.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});
</script>

</body>
</html>`;
