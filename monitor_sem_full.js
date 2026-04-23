require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

const CONFIG = {
  clientId:       process.env.ML_CLIENT_ID,
  clientSecret:   process.env.ML_CLIENT_SECRET,
  sellerId:       process.env.ML_SELLER_ID,
  telegramToken:  process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  googleSheetUrl: process.env.GOOGLE_SHEET_URL,
};

const BASE = 'https://api.mercadolibre.com';
const sleep = ms => new Promise(res => setTimeout(res, ms));

async function fetchComRetry(url, options, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, options);
      return r;
    } catch (e) {
      console.log(`Erro de conexao, tentativa ${i+1}/${tentativas}...`);
      await sleep(2000 * (i + 1));
    }
  }
  return null;
}

async function getToken() {
  const r = await fetchComRetry(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${CONFIG.clientId}&client_secret=${CONFIG.clientSecret}`
  });
  if (!r) return null;
  const d = await r.json();
  return d.access_token;
}

// Busca todos itens ATIVOS sem fulfillment via search_type=scan
async function getItemsSemFull(token) {
  let allIds = [], scrollId = null;
  while (true) {
    const url = scrollId
      ? `${BASE}/users/${CONFIG.sellerId}/items/search?search_type=scan&scroll_id=${scrollId}&limit=100`
      : `${BASE}/users/${CONFIG.sellerId}/items/search?search_type=scan&limit=100&status=active&logistic_type=cross_docking`;
    const r = await fetchComRetry(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r) break;
    const d = await r.json();
    if (!d.results || d.results.length === 0) break;
    allIds = allIds.concat(d.results);
    scrollId = d.scroll_id;
    if (allIds.length % 500 === 0 || allIds.length >= (d.paging?.total || 0)) {
      console.log(`  ${allIds.length}/${d.paging?.total || '?'} itens scaneados...`);
    }
    if (allIds.length >= (d.paging?.total || 0)) break;
    await sleep(200);
  }
  return allIds;
}

async function getDetalhesLote(ids, token) {
  const r = await fetchComRetry(
    `${BASE}/items?ids=${ids.join(',')}&attributes=id,title,available_quantity,seller_custom_field,shipping,price`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r) return [];
  const d = await r.json();
  return d.filter(i => i.code === 200).map(i => i.body);
}

// Busca TODOS pedidos pagos dos últimos 30 dias e agrupa quantidade por item_id
async function getVendas30dMap(token) {
  console.log('[VENDAS] Buscando todos os pedidos dos últimos 30d...');
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - 30);
  const dateFromIso = dateFrom.toISOString();

  const vendas = {};
  let offset = 0;
  let totalPedidos = 0;
  while (true) {
    const r = await fetchComRetry(
      `${BASE}/orders/search?seller=${CONFIG.sellerId}&order.status=paid&order.date_created.from=${dateFromIso}&limit=50&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r) break;
    const d = await r.json();
    if (!d.results || d.results.length === 0) break;
    totalPedidos += d.results.length;
    for (const order of d.results) {
      for (const oi of (order.order_items || [])) {
        const id = oi.item?.id;
        if (!id) continue;
        vendas[id] = (vendas[id] || 0) + (oi.quantity || 0);
      }
    }
    if (d.results.length < 50) break;
    offset += 50;
    if (offset % 500 === 0) console.log(`  ${offset} pedidos processados...`);
    await sleep(150);
  }
  console.log(`[VENDAS] ${totalPedidos} pedidos, ${Object.keys(vendas).length} itens com vendas`);
  return vendas;
}

async function sendTelegramResumo(items) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId) return;
  const hoje = new Date().toLocaleDateString('pt-BR');
  const totalEstoque = items.reduce((s, i) => s + (i.disponivel || 0), 0);
  const totalVendas = items.reduce((s, i) => s + (i.vendas30d || 0), 0);
  const text = `Anúncios SEM Fulfillment - ${hoje}\n\n${items.length} anúncios ativos com estoque\n${totalEstoque} unidades em estoque\n${totalVendas} vendidas nos últimos 30d`;
  try {
    await fetchComRetry(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text })
    });
    console.log('Resumo enviado no Telegram!');
  } catch (e) { console.log('Erro Telegram:', e.message); }
}

async function sendGoogleSheets(items) {
  if (!items.length || !CONFIG.googleSheetUrl) return;
  try {
    await fetchComRetry(CONFIG.googleSheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alerts: items, tipo: 'sem_full' })
    });
    console.log('Dados enviados para o Google Sheets!');
  } catch (e) {
    console.log('Erro ao enviar para Google Sheets:', e.message);
  }
}

function saveData(items) {
  try {
    const dataDir = path.join(__dirname, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const payload = { alerts: items, savedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(dataDir, 'sem_full.json'), JSON.stringify(payload));
    console.log('Dados salvos em data/sem_full.json');
  } catch (e) {
    console.log('Erro ao salvar dados locais:', e.message);
  }
}

(async () => {
  console.log(`[${new Date().toISOString()}] Verificando anúncios SEM fulfillment...`);
  const token = await getToken();
  if (!token) { console.log('Falha ao obter token.'); return; }

  // Pega todos os IDs ativos com cross_docking (sem full)
  const allIds = await getItemsSemFull(token);
  console.log(`${allIds.length} anúncios ATIVOS sem fulfillment encontrados.`);

  if (allIds.length === 0) { console.log('Nenhum item para processar.'); return; }

  // Busca vendas 30d em batch (1 só consulta paginada de pedidos)
  const vendasMap = await getVendas30dMap(token);

  // Busca detalhes em lotes de 20 e filtra com estoque > 0
  console.log('Buscando detalhes dos itens...');
  const items = [];
  for (let i = 0; i < allIds.length; i += 20) {
    const lote = allIds.slice(i, i + 20);
    await sleep(300);
    const detalhes = await getDetalhesLote(lote, token);
    for (const item of detalhes) {
      const disponivel = Number(item.available_quantity || 0);
      if (disponivel <= 0) continue; // só com estoque
      const logistic = item.shipping?.logistic_type;
      if (logistic === 'fulfillment') continue; // segurança extra
      items.push({
        title: item.title || '',
        sku: item.seller_custom_field || 'N/A',
        mlb: item.id,
        disponivel,
        vendas30d: vendasMap[item.id] || 0,
        preco: Number(item.price || 0),
        logistica: logistic || '',
      });
    }
    if (i % 200 === 0) console.log(`  Processados ${i}/${allIds.length} (encontrados ${items.length} com estoque)...`);
  }

  // Ordena por vendas 30d desc (mais vendidos primeiro)
  items.sort((a, b) => b.vendas30d - a.vendas30d);

  console.log(`Total: ${items.length} anúncios sem Full ATIVOS COM ESTOQUE`);
  console.log(`Top 10 mais vendidos sem Full:`);
  items.slice(0, 10).forEach((i, idx) => {
    console.log(`  ${idx+1}. [${i.vendas30d}v] ${i.title.slice(0,60)} | SKU=${i.sku} | MLB=${i.mlb} | est=${i.disponivel}`);
  });

  await sendTelegramResumo(items);
  await sendGoogleSheets(items);
  saveData(items);
})();
