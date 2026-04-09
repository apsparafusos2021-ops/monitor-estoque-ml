require('dotenv').config();
const fetch = require('node-fetch');

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
  const r = await fetchComRetry('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${CONFIG.clientId}&client_secret=${CONFIG.clientSecret}`
  });
  if (!r) return null;
  const d = await r.json();
  return d.access_token;
}

async function getShipmentInfo(shippingId, token) {
  try {
    const r = await fetchComRetry(
      `${BASE}/shipments/${shippingId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function getPedidosCD(token) {
  const dateFrom = new Date();
  dateFrom.setHours(0, 0, 0, 0);
  let todosPedidos = [], offset = 0;
  while (true) {
    const r = await fetchComRetry(
      `${BASE}/orders/search?seller=${CONFIG.sellerId}&order.status=paid&order.date_created.from=${dateFrom.toISOString()}&limit=50&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r) break;
    const d = await r.json();
    if (!d.results || d.results.length === 0) break;
    todosPedidos = todosPedidos.concat(d.results);
    if (d.results.length < 50) break;
    offset += 50;
    await sleep(300);
  }
  console.log(`Total pedidos hoje: ${todosPedidos.length}`);
  const pedidosCD = [];
  for (const pedido of todosPedidos) {
    const shippingId = pedido.shipping?.id;
    if (!shippingId) continue;
    await sleep(200);
    const shipment = await getShipmentInfo(shippingId, token);
    if (!shipment) continue;
    if (shipment.logistic_type === 'cross_docking') {
      pedidosCD.push({ ...pedido, logistica: shipment.logistic_type });
    }
  }
  return pedidosCD;
}

async function getItemDetails(itemId, token) {
  try {
    const r = await fetchComRetry(
      `${BASE}/items/${itemId}?attributes=id,title,seller_custom_field`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r) return null;
    return await r.json();
  } catch (e) { return null; }
}
async function sendTelegram(resumo) {
  if (!resumo.length) { console.log('Nenhum pedido CD hoje.'); return; }
  const lines = resumo.map(a =>
    `• ${a.title}\n  SKU: ${a.sku} | MLB: ${a.mlb} | Vendas hoje: ${a.quantidade} un`
  ).join('\n\n');
  const hoje = new Date().toLocaleDateString('pt-BR');
  const text = `Resumo Pedidos CD - ${hoje}\n${resumo.length} produto(s) vendidos pelo CD hoje\n\n${lines}`;
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
  console.log('Resumo enviado no Telegram!');
}

async function sendGoogleSheets(resumo) {
  if (!resumo.length || !CONFIG.googleSheetUrl) return;
  try {
    await fetchComRetry(CONFIG.googleSheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alerts: resumo, tipo: 'coleta' })
    });
    console.log('Dados enviados para o Google Sheets!');
  } catch (e) {
    console.log('Erro ao enviar para Google Sheets:', e.message);
  }
}

(async () => {
  console.log(`[${new Date().toISOString()}] Verificando pedidos CD do dia...`);
  const token = await getToken();
  if (!token) { console.log('Falha ao obter token.'); return; }
  const pedidos = await getPedidosCD(token);
  console.log(`${pedidos.length} pedidos CD encontrados hoje.`);
  if (!pedidos.length) {
    console.log('Nenhum pedido CD hoje.');
    return;
  }
  const agrupado = {};
  for (const pedido of pedidos) {
    for (const item of pedido.order_items || []) {
      const itemId = item.item.id;
      if (!agrupado[itemId]) {
        agrupado[itemId] = {
          itemId,
          quantidade: 0,
          logistica: pedido.logistica,
        };
      }
      agrupado[itemId].quantidade += item.quantity;
    }
  }
  const resumo = [];
  for (const [itemId, dados] of Object.entries(agrupado)) {
    await sleep(300);
    const details = await getItemDetails(itemId, token);
    resumo.push({
      title: details?.title || itemId,
      sku: details?.seller_custom_field || 'N/A',
      mlb: itemId,
      quantidade: dados.quantidade,
      logistica: dados.logistica,
    });
  }
  resumo.sort((a, b) => b.quantidade - a.quantidade);
  console.log(`${resumo.length} SKUs unicos encontrados.`);
  resumo.forEach(r => console.log(`${r.title}: SKU=${r.sku} MLB=${r.mlb} quantidade=${r.quantidade}`));
  await sendTelegram(resumo);
  await sendGoogleSheets(resumo);
})();