require('dotenv').config();
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
  alertThreshold: 0.50,
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
  const r = await fetchComRetry('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${CONFIG.clientId}&client_secret=${CONFIG.clientSecret}`
  });
  if (!r) return null;
  const d = await r.json();
  return d.access_token;
}

async function getItemsFulfillment(token) {
  let allIds = [], offset = 0;
  while (true) {
    const r = await fetchComRetry(
      `${BASE}/users/${CONFIG.sellerId}/items/search?logistic_type=fulfillment&limit=50&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r) break;
    const d = await r.json();
    if (!d.results || d.results.length === 0) break;
    allIds = allIds.concat(d.results);
    const total = d.paging && d.paging.total ? d.paging.total : 0;
    if (allIds.length >= total) break;
    offset += 50;
    await sleep(500);
  }
  const lotes = [];
  for (let i = 0; i < allIds.length; i += 20) {
    lotes.push(allIds.slice(i, i + 20));
  }
  return lotes;
}

async function getDetalhesLote(ids, token) {
  const r = await fetchComRetry(
    `${BASE}/items?ids=${ids.join(',')}&attributes=id,title,available_quantity,inventory_id,item_relations,seller_custom_field`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r) return [];
  const d = await r.json();
  return d.filter(i => i.code === 200).map(i => i.body);
}

async function getEstoqueInventario(inventoryId, token) {
  try {
    const r = await fetchComRetry(
      `${BASE}/inventories/${inventoryId}/stock/fulfillment`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r) return { available: 0, aCaminho: 0, entradaPendente: 0 };
    const d = await r.json();
    const aCaminho = (d.not_available_detail || [])
      .filter(x => x.status === 'transfer')
      .reduce((s, x) => s + (x.quantity || 0), 0);
    const entradaPendente = (d.not_available_detail || [])
      .filter(x => x.status === 'internalProcess')
      .reduce((s, x) => s + (x.quantity || 0), 0);
    return { available: d.available_quantity ?? 0, aCaminho, entradaPendente };
  } catch (e) { return { available: 0, aCaminho: 0, entradaPendente: 0 }; }
}
async function getSales30d(itemId, token) {
  try {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - 30);
    let total = 0, offset = 0;
    while (true) {
      const r = await fetchComRetry(
        `${BASE}/orders/search?seller=${CONFIG.sellerId}&q=${itemId}&order.status=paid&order.date_created.from=${dateFrom.toISOString()}&limit=50&offset=${offset}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r) break;
      const d = await r.json();
      if (!d.results || d.results.length === 0) break;
      total += (d.results || []).reduce((sum, o) =>
        sum + (o.order_items || []).filter(i => i.item.id === itemId)
                           .reduce((s, i) => s + i.quantity, 0), 0);
      if (d.results.length < 50) break;
      offset += 50;
      await sleep(300);
    }
    return total;
  } catch (e) { return 0; }
}

function agruparPorInventario(todosItens) {
  const grupos = {};
  for (const item of todosItens) {
    const invId = item.inventory_id || item.id;
    if (!grupos[invId]) {
      grupos[invId] = {
        inventoryId: invId,
        available: item.available_quantity ?? 0,
        title: item.title,
        sku: item.seller_custom_field || 'N/A',
        mlb: item.id,
        ids: new Set(),
      };
    }
    if (!grupos[invId].sku || grupos[invId].sku === 'N/A') {
      grupos[invId].sku = item.seller_custom_field || 'N/A';
    }
    grupos[invId].ids.add(item.id);
    if (item.item_relations) {
      for (const rel of item.item_relations) {
        grupos[invId].ids.add(rel.id);
      }
    }
  }
  return grupos;
}

async function sendTelegram(alerts) {
  if (!alerts.length) { console.log('Estoque OK — nenhum alerta.'); return; }
  const lines = alerts.map(a =>
    `• ${a.title}\n  SKU: ${a.sku} | MLB: ${a.mlb} | Disponivel: ${a.available} un | A caminho: ${a.aCaminho} un | Entrada pendente: ${a.entradaPendente} un | Vendas 30d: ${a.sales30d} un | ${a.pct}% | ~${a.daysLeft} dias`
  ).join('\n\n');
  const text = `Alerta Fulfillment ML\n${alerts.length} produto(s) abaixo de ${CONFIG.alertThreshold * 100}%\n\n${lines}`;
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    await fetchComRetry(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text: chunk })
    });
    await sleep(500);
  }
  console.log('Alerta enviado no Telegram!');
}

async function sendGoogleSheets(alerts) {
  if (!alerts.length || !CONFIG.googleSheetUrl) return;
  try {
    const r = await fetchComRetry(CONFIG.googleSheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alerts })
    });
    if (r) console.log('Dados enviados para o Google Sheets!');
  } catch (e) {
    console.log('Erro ao enviar para Google Sheets:', e.message);
  }
}

function saveData(alerts) {
  try {
    const dataDir = path.join(__dirname, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const payload = { alerts, savedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(dataDir, 'estoque.json'), JSON.stringify(payload));
    console.log('Dados salvos em data/estoque.json');
  } catch (e) {
    console.log('Erro ao salvar dados locais:', e.message);
  }
}

(async () => {
  console.log(`[${new Date().toISOString()}] Verificando estoque...`);
  const token = await getToken();
  if (!token) { console.log('Falha ao obter token.'); return; }
  const lotes = await getItemsFulfillment(token);
  console.log(`${lotes.flat().length} itens fulfillment encontrados.`);
  const todosItens = [];
  for (const lote of lotes) {
    await sleep(800);
    const itens = await getDetalhesLote(lote, token);
    todosItens.push(...itens);
  }
  const grupos = agruparPorInventario(todosItens);
  console.log(`${Object.keys(grupos).length} inventarios unicos encontrados.`);
  const alerts = [];
  const emTransito = []; // Itens com aCaminho > 0 ou entradaPendente > 0 (independente de vendas)
  for (const grupo of Object.values(grupos)) {
    const idsArray = Array.from(grupo.ids);

    // Busca estoque ANTES do filtro de vendas para capturar TODOS os em trânsito
    await sleep(300);
    const estoque = await getEstoqueInventario(grupo.inventoryId, token);
    const available = estoque.available;
    const aCaminho = estoque.aCaminho;
    const entradaPendente = estoque.entradaPendente;

    // Captura para "em trânsito" se houver remessa pendente (mesmo sem vendas)
    if (aCaminho > 0 || entradaPendente > 0) {
      emTransito.push({
        title: grupo.title,
        sku: grupo.sku,
        mlb: grupo.mlb,
        available, aCaminho, entradaPendente,
      });
    }

    // Busca vendas 30d
    let sales30d = 0;
    for (const id of idsArray) {
      await sleep(500);
      sales30d += await getSales30d(id, token);
    }
    if (sales30d === 0) continue;

    const pct = (available / sales30d) * 100;
    const daysLeft = Math.round(available / (sales30d / 30));
    console.log(`${grupo.title}: SKU=${grupo.sku} MLB=${grupo.mlb} disponivel=${available} aCaminho=${aCaminho} entradaPendente=${entradaPendente} vendas30d=${sales30d} pct=${pct.toFixed(1)}%`);
    if (pct <= CONFIG.alertThreshold * 100) {
      alerts.push({
        title: grupo.title,
        sku: grupo.sku,
        mlb: grupo.mlb,
        available, aCaminho, entradaPendente,
        sales30d, pct: pct.toFixed(1), daysLeft
      });
    }
  }
  // Deduplica por título (evita linhas repetidas na planilha)
  const seen = new Set();
  const alertsUnicos = alerts.filter(a => {
    const key = a.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`${alerts.length} alertas -> ${alertsUnicos.length} unicos (${alerts.length - alertsUnicos.length} duplicatas removidas)`);
  console.log(`${emTransito.length} itens em transito (a caminho ou entrada pendente)`);

  await sendTelegram(alertsUnicos);
  await sendGoogleSheets(alertsUnicos);
  saveData(alertsUnicos);

  // Envia "em trânsito" como um tipo separado para nova aba
  if (emTransito.length > 0 && CONFIG.googleSheetUrl) {
    try {
      await fetchComRetry(CONFIG.googleSheetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alerts: emTransito, tipo: 'em_transito' }),
      });
      console.log('Em transito enviado para o Google Sheets!');
    } catch (e) {
      console.log('Erro ao enviar em transito:', e.message);
    }
  }
})();