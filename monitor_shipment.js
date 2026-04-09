require('dotenv').config();
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

const CONFIG = {
  telegramToken:  process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  googleSheetUrl: process.env.GOOGLE_SHEET_URL,
};

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function sendTelegram(alerts) {
  if (!alerts.length) { console.log('Nenhum item critico encontrado.'); return; }
  const lines = alerts.map(a =>
    `• ${a.title}\n  Vendas 30d: ${a.vendas} | Sugestao ML: ${a.sugestao} un | Status: ${a.status}`
  ).join('\n\n');
  const text = `Planejamento Fulfillment ML\n${alerts.length} produto(s) para reabastecer\n\n${lines}`;
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text: chunk })
    });
    await sleep(500);
  }
  console.log('Alerta enviado no Telegram!');
}

(async () => {
  console.log(`[${new Date().toISOString()}] Iniciando monitor shipment...`);
  const browser = await puppeteer.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log('Abrindo pagina do Mercado Livre...');
  await page.goto('https://www.mercadolivre.com.br/anuncios/lista/shipment_planning/plans', {
    waitUntil: 'networkidle2', timeout: 60000
  });

  console.log('Faca o login manualmente no navegador que abriu.');
  console.log('Depois de logar e a pagina carregar, pressione ENTER aqui...');
  await new Promise(resolve => process.stdin.once('data', resolve));

  console.log('Extraindo dados...');
  await sleep(3000);

  const alerts = await page.evaluate(() => {
    const results = [];
    const rows = document.querySelectorAll('tbody tr');
    rows.forEach(row => {
      const cols = row.querySelectorAll('td');
      if (cols.length >= 3) {
        const title = cols[0]?.innerText?.trim();
        const vendas = cols[1]?.innerText?.trim();
        const sugestao = cols[2]?.innerText?.trim();
        if (title && title.length > 5) {
          results.push({ title, vendas, sugestao, status: 'Critico' });
        }
      }
    });
    return results;
  });

  console.log(`${alerts.length} itens encontrados.`);
  await browser.close();
  await sendTelegram(alerts);
})();