const path = require('path');
const fs = require('fs');
// Tenta carregar .env de vários caminhos possíveis (apenas em desenvolvimento local)
const envPaths = [
  path.join(__dirname, '.env'),
  path.resolve(__dirname, '../../.env'),
  'C:\\monitor-estoque\\.env',
];
const envPath = envPaths.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (envPath) {
  require('dotenv').config({ path: envPath });
  console.log('[ENV] .env carregado de:', envPath);
} else {
  console.log('[ENV] Nenhum .env encontrado, usando variáveis do ambiente do sistema');
}
const express = require('express');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// ── DEBUG: Lista todas variáveis ML_ e DASH_ disponíveis ───────────────────────
console.log('[DEBUG] Variáveis de ambiente disponíveis:');
const envKeys = Object.keys(process.env).filter(k => /^(ML_|DASH_|GOOGLE_|TELEGRAM_)/.test(k));
console.log('[DEBUG] Encontradas:', envKeys.length, '->', envKeys.join(', '));
console.log('[DEBUG] Total process.env keys:', Object.keys(process.env).length);

// ── Autenticação básica ────────────────────────────────────────────────────────
const DASH_USER = process.env.DASH_USER || '';
const DASH_PASS = process.env.DASH_PASS || '';

if (DASH_USER && DASH_PASS) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="Monitor ML"');
      return res.status(401).send('Autenticação necessária');
    }
    const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
    const [user, pass] = decoded.split(':');
    if (user === DASH_USER && pass === DASH_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="Monitor ML"');
    return res.status(401).send('Usuário ou senha incorretos');
  });
  console.log('Autenticação ativada (usuário: ' + DASH_USER + ')');
}

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ML ──────────────────────────────────────────────────────────────────
const CONFIG = {
  clientId:     process.env.ML_CLIENT_ID,
  clientSecret: process.env.ML_CLIENT_SECRET,
  sellerId:     process.env.ML_SELLER_ID,
};
const BASE = 'https://api.mercadolibre.com';
const sleep = ms => new Promise(res => setTimeout(res, ms));

// ── Funções ML (reusadas do monitor.js) ────────────────────────────────────────
async function fetchComRetry(url, options, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, options);
      return r;
    } catch (e) {
      console.log(`Erro de conexao, tentativa ${i + 1}/${tentativas}...`);
      await sleep(2000 * (i + 1));
    }
  }
  return null;
}

async function getToken() {
  console.log('[AUTH] Iniciando autenticação ML...');
  console.log('[AUTH] CLIENT_ID presente:', !!CONFIG.clientId, 'len:', CONFIG.clientId?.length);
  console.log('[AUTH] CLIENT_SECRET presente:', !!CONFIG.clientSecret, 'len:', CONFIG.clientSecret?.length);
  console.log('[AUTH] SELLER_ID:', CONFIG.sellerId);

  if (!CONFIG.clientId || !CONFIG.clientSecret) {
    console.error('[AUTH] Variáveis de ambiente ML_CLIENT_ID ou ML_CLIENT_SECRET não definidas');
    return null;
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
    }).toString();

    const r = await fetchComRetry(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r) {
      console.error('[AUTH] Sem resposta do ML após retries');
      return null;
    }
    const d = await r.json();
    if (!r.ok) {
      console.error('[AUTH] Erro do ML:', r.status, JSON.stringify(d));
      return null;
    }
    console.log('[AUTH] Token obtido com sucesso');
    return d.access_token;
  } catch (e) {
    console.error('[AUTH] Exceção:', e.message);
    return null;
  }
}

async function getAllSellerItems(token) {
  let allIds = [];
  // Usa search_type=scan para paginar grandes volumes (>1000 itens)
  // Busca itens ativos do seller
  let scrollId = null;
  while (true) {
    const url = scrollId
      ? `${BASE}/users/${CONFIG.sellerId}/items/search?search_type=scan&scroll_id=${scrollId}&limit=100`
      : `${BASE}/users/${CONFIG.sellerId}/items/search?search_type=scan&limit=100&status=active`;
    const r = await fetchComRetry(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r) break;
    const d = await r.json();
    if (!d.results || d.results.length === 0) break;
    allIds = allIds.concat(d.results);
    scrollId = d.scroll_id;
    const total = d.paging?.total || 0;
    console.log(`[NF]   Scan: ${allIds.length}/${total} itens...`);
    if (allIds.length >= total) break;
    await sleep(300);
  }
  return allIds;
}

async function getDetalhesLote(ids, token) {
  const r = await fetchComRetry(
    `${BASE}/items?ids=${ids.join(',')}&attributes=id,title,available_quantity,inventory_id,seller_custom_field,shipping,attributes`,
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
    if (!r) return null;
    const d = await r.json();
    if (d.error) return null;
    return {
      available: d.available_quantity ?? 0,
      aCaminho: (d.not_available_detail || [])
        .filter(x => x.status === 'transfer')
        .reduce((s, x) => s + (x.quantity || 0), 0),
    };
  } catch { return null; }
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
  } catch { return 0; }
}

// ── Parse XML NF-e ─────────────────────────────────────────────────────────────
function parseNFe(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'det',
  });
  const parsed = parser.parse(xmlText);

  // Navega na estrutura do XML: pode ser nfeProc > NFe > infNFe ou NFe > infNFe
  const nfe = parsed.nfeProc?.NFe || parsed.NFe;
  if (!nfe) throw new Error('XML inválido: não encontrou tag NFe');
  const infNFe = nfe.infNFe;
  if (!infNFe) throw new Error('XML inválido: não encontrou tag infNFe');

  const dets = infNFe.det || [];
  return dets.map(det => {
    const prod = det.prod || {};
    return {
      ean: String(prod.cEAN || prod.cEANTrib || '').trim(),
      nome: String(prod.xProd || '').trim(),
      quantidade: Math.round(parseFloat(prod.qCom || prod.qTrib || 0)),
      sku: String(prod.cProd || '').trim(),
      unidade: String(prod.uCom || '').trim(),
    };
  }).filter(p => p.ean && p.ean !== 'SEM GTIN' && p.ean.length >= 8);
}

// ── Extrai EAN/GTIN dos atributos de um item ML ───────────────────────────────
function getItemGTIN(item) {
  if (!item.attributes) return [];
  const gtins = [];
  for (const attr of item.attributes) {
    if (attr.id === 'GTIN' || attr.id === 'EAN') {
      if (attr.value_name) gtins.push(String(attr.value_name).trim());
    }
  }
  return gtins;
}

// ── Verifica se item tem fulfillment ───────────────────────────────────────────
function isFulfillment(item) {
  const logistic = item.shipping?.logistic_type;
  return logistic === 'fulfillment';
}

// ── Endpoint principal ─────────────────────────────────────────────────────────
app.post('/api/analyze-nf', async (req, res) => {
  try {
    const xmlText = typeof req.body === 'string' ? req.body : req.body.xml;
    if (!xmlText) return res.status(400).json({ error: 'XML não fornecido' });

    console.log('[NF] Parseando XML...');
    const produtosNF = parseNFe(xmlText);
    if (produtosNF.length === 0) {
      return res.status(400).json({ error: 'Nenhum produto com EAN válido encontrado no XML' });
    }
    console.log(`[NF] ${produtosNF.length} produtos com EAN encontrados na NF`);

    // Obter token ML
    const token = await getToken();
    if (!token) return res.status(500).json({ error: 'Falha ao autenticar com Mercado Livre' });

    // Buscar TODOS os itens do seller (inclui full e não-full)
    console.log('[NF] Buscando todos os itens do seller...');
    const allItemIds = await getAllSellerItems(token);
    console.log(`[NF] ${allItemIds.length} itens encontrados no seller`);

    // Buscar detalhes em lotes de 20 (incluindo attributes e shipping)
    const lotes = [];
    for (let i = 0; i < allItemIds.length; i += 20) {
      lotes.push(allItemIds.slice(i, i + 20));
    }

    const allItems = [];
    for (const lote of lotes) {
      await sleep(400);
      const itens = await getDetalhesLote(lote, token);
      allItems.push(...itens);
    }
    console.log(`[NF] Detalhes obtidos para ${allItems.length} itens`);

    // Construir mapeamento EAN → item(s)
    const eanMap = {};
    let gtinCount = 0;
    for (const item of allItems) {
      const gtins = getItemGTIN(item);
      if (gtins.length > 0) gtinCount++;
      for (const gtin of gtins) {
        if (!eanMap[gtin]) eanMap[gtin] = [];
        eanMap[gtin].push(item);
      }
    }
    console.log(`[NF] ${gtinCount} itens com GTIN, ${Object.keys(eanMap).length} EANs únicos mapeados`);

    // Cruzar produtos da NF com itens ML
    const resultados = [];
    for (const prodNF of produtosNF) {
      const mlItems = eanMap[prodNF.ean] || [];

      if (mlItems.length === 0) {
        console.log(`[NF] EAN ${prodNF.ean} -> Não encontrado`);
        resultados.push({
          ...prodNF,
          status: 'nao_encontrado',
          statusLabel: 'Não encontrado no ML',
          mlbIds: [],
          titulo: prodNF.nome,
          fulfillment: false,
          estoqueFull: null,
          aCaminho: null,
          vendas30d: null,
          diasEstoque: null,
          sugestaoEnvio: null,
        });
        continue;
      }

      // Verificar se algum anúncio tem fulfillment
      const ffItems = mlItems.filter(isFulfillment);
      const hasFulfillment = ffItems.length > 0;
      const primaryItem = hasFulfillment ? ffItems[0] : mlItems[0];
      const mlbIds = mlItems.map(i => i.id);

      let estoqueFull = null;
      let aCaminho = null;
      let vendas30d = null;
      let diasEstoque = null;
      let sugestaoEnvio = null;

      if (hasFulfillment) {
        // Buscar estoque fulfillment
        const invId = primaryItem.inventory_id || primaryItem.id;
        await sleep(300);
        const estoque = await getEstoqueInventario(invId, token);
        if (estoque) {
          estoqueFull = estoque.available;
          aCaminho = estoque.aCaminho;
        }

        // Buscar vendas 30d (soma de todos os anúncios desse EAN)
        vendas30d = 0;
        for (const item of mlItems) {
          await sleep(300);
          vendas30d += await getSales30d(item.id, token);
        }

        if (vendas30d > 0 && estoqueFull !== null) {
          diasEstoque = Math.round(estoqueFull / (vendas30d / 30));
          // Sugestão: cobrir 30 dias de vendas menos o que já tem
          sugestaoEnvio = Math.max(0, vendas30d - estoqueFull - (aCaminho || 0));
        }
      }

      const statusLabel = hasFulfillment ? 'Fulfillment' : 'Sem Fulfillment';
      console.log(`[NF] EAN ${prodNF.ean} -> ${statusLabel} | MLB: ${mlbIds.join(', ')}`);

      resultados.push({
        ...prodNF,
        status: hasFulfillment ? 'fulfillment' : 'sem_fulfillment',
        statusLabel,
        mlbIds,
        titulo: primaryItem.title || prodNF.nome,
        skuML: primaryItem.seller_custom_field || '',
        fulfillment: hasFulfillment,
        estoqueFull,
        aCaminho,
        vendas30d,
        diasEstoque,
        sugestaoEnvio,
      });
    }

    console.log(`[NF] Análise concluída: ${resultados.length} produtos processados`);
    res.json({ resultados });

  } catch (e) {
    console.error('[NF] Erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Endpoint de envio para Slack ──────────────────────────────────────────────
app.post('/api/send-slack', async (req, res) => {
  try {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      return res.status(500).json({ error: 'SLACK_WEBHOOK_URL não configurado' });
    }

    const { eans } = req.body;
    if (!Array.isArray(eans) || eans.length === 0) {
      return res.status(400).json({ error: 'Nenhum EAN selecionado' });
    }

    const text = eans.join('\n');
    console.log(`[SLACK] Enviando ${eans.length} EAN(s)...`);

    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('[SLACK] Erro:', r.status, errText);
      return res.status(500).json({ error: `Slack respondeu ${r.status}: ${errText}` });
    }

    console.log('[SLACK] Enviado com sucesso');
    res.json({ ok: true, count: eans.length });
  } catch (e) {
    console.error('[SLACK] Exceção:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Endpoint para buscar estoque no Tiny ERP ──────────────────────────────────
// Cache em memória para não buscar o ID do produto toda vez
const tinyProductIdCache = {};

async function tinySearchProductId(sku, token) {
  if (tinyProductIdCache[sku]) return tinyProductIdCache[sku];
  try {
    const params = new URLSearchParams({ token, pesquisa: sku, formato: 'json' }).toString();
    const r = await fetch('https://api.tiny.com.br/api2/produtos.pesquisa.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const d = await r.json();
    if (d.retorno?.status === 'OK' && d.retorno.produtos?.length > 0) {
      // Busca o produto que tem o código EXATO (não parcial)
      const produto = d.retorno.produtos.find(p => p.produto.codigo === sku)?.produto
                   || d.retorno.produtos[0].produto;
      tinyProductIdCache[sku] = produto.id;
      return produto.id;
    }
  } catch (e) {
    console.error('[TINY] Erro busca SKU', sku, ':', e.message);
  }
  return null;
}

async function tinyGetStock(productId, token) {
  try {
    const params = new URLSearchParams({ token, id: productId, formato: 'json' }).toString();
    const r = await fetch('https://api.tiny.com.br/api2/produto.obter.estoque.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const d = await r.json();
    if (d.retorno?.status === 'OK' && d.retorno.produto) {
      const saldo = Number(d.retorno.produto.saldo || 0);
      const reservado = Number(d.retorno.produto.saldoReservado || 0);
      return { saldo, reservado, disponivel: saldo - reservado };
    }
  } catch (e) {
    console.error('[TINY] Erro estoque ID', productId, ':', e.message);
  }
  return null;
}

app.post('/api/tiny-stock', async (req, res) => {
  try {
    const token = process.env.TINY_API_TOKEN;
    if (!token) return res.status(500).json({ error: 'TINY_API_TOKEN não configurado' });

    const { skus } = req.body;
    if (!Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: 'Nenhum SKU fornecido' });
    }

    console.log(`[TINY] Buscando estoque de ${skus.length} SKUs...`);
    const resultados = {};

    // Rate limit: 2 req/segundo para ficar dentro de 30/min
    for (const sku of skus) {
      if (!sku || sku === 'N/A' || sku === '–') {
        resultados[sku] = null;
        continue;
      }
      await sleep(500);
      const productId = await tinySearchProductId(sku, token);
      if (!productId) {
        resultados[sku] = null;
        continue;
      }
      await sleep(500);
      const stock = await tinyGetStock(productId, token);
      resultados[sku] = stock;
    }

    console.log(`[TINY] Concluído. ${Object.values(resultados).filter(v => v !== null).length}/${skus.length} encontrados`);
    res.json({ estoques: resultados });
  } catch (e) {
    console.error('[TINY] Erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
