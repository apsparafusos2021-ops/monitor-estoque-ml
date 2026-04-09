require('dotenv').config();
const fetch = require('node-fetch');
(async () => {
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=' + process.env.ML_CLIENT_ID + '&client_secret=' + process.env.ML_CLIENT_SECRET
  });
  const t = (await r.json()).access_token;
  const dateFrom = new Date();
  dateFrom.setHours(0, 0, 0, 0);
  const r2 = await fetch('https://api.mercadolibre.com/orders/search?seller=569138182&order.status=paid&order.date_created.from=' + dateFrom.toISOString() + '&limit=10', {
    headers: { Authorization: 'Bearer ' + t }
  });
  const d = await r2.json();
  const tipos = {};
  for (const pedido of d.results || []) {
    const shippingId = pedido.shipping?.id;
    if (!shippingId) continue;
    const r3 = await fetch('https://api.mercadolibre.com/shipments/' + shippingId, { headers: { Authorization: 'Bearer ' + t } });
    const s = await r3.json();
    const tipo = s.logistic_type || 'undefined';
    tipos[tipo] = (tipos[tipo] || 0) + 1;
  }
  console.log('Tipos encontrados:', tipos);
})();