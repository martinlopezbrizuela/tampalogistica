const Api = (() => {
  async function req(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* respuesta sin body (ej. archivos) */ }
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : 'ERROR_DESCONOCIDO';
      throw new Error(msg);
    }
    return data;
  }
  return {
    get: (url) => req('GET', url),
    post: (url, body) => req('POST', url, body || {}),
    put: (url, body) => req('PUT', url, body || {}),
  };
})();

function showToast(message, type) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast' + (type ? ' ' + type : '');
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 3800);
}

function apiErrorMessage(err) {
  return (err && err.message) ? err.message.replace(/_/g, ' ') : 'ERROR DESCONOCIDO';
}
// ======================================================================
// AGROFORCE + TAMPA - CONTROL DE STOCK
// Frontend SPA (vanilla JS, sin build step)
// ======================================================================

const state = {
  warehouses: [],
  products: [],
  responsibles: [],
  destinations: [],
};

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleDateString('es-PY');
}
function fmtDateTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleDateString('es-PY') + ' ' + d.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' });
}
function fmtNum(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return v;
  return n.toLocaleString('es-PY', { maximumFractionDigits: 3 });
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

// ---------------------------------------------------------------------
// AUTENTICACION
// ---------------------------------------------------------------------
async function initAuth() {
  try {
    const responsibles = await Api.get('/api/responsibles/public');
    const sel = document.getElementById('login-responsible');
    responsibles.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.first_name} ${r.last_name || ''}`.trim();
      sel.appendChild(opt);
    });
  } catch (e) { /* silencioso */ }

  const session = await Api.get('/api/auth/session');
  if (session.authenticated) {
    startApp(session.actingAsName);
  } else {
    document.getElementById('login-screen').classList.remove('hidden');
  }

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('login-password').value;
    const responsibleId = document.getElementById('login-responsible').value;
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';
    try {
      const r = await Api.post('/api/auth/login', { password, responsibleId: responsibleId || null });
      startApp(r.actingAsName);
    } catch (err) {
      errEl.textContent = 'CONTRASEÑA INCORRECTA';
    }
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await Api.post('/api/auth/logout');
    location.reload();
  });
}

async function startApp(actingAsName) {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  document.getElementById('acting-as-label').textContent = actingAsName ? `ACTUANDO COMO: ${actingAsName}` : '';

  const [warehouses, products, responsibles, destinations] = await Promise.all([
    Api.get('/api/warehouses'), Api.get('/api/products'),
    Api.get('/api/responsibles'), Api.get('/api/destinations')
  ]);
  state.warehouses = warehouses; state.products = products;
  state.responsibles = responsibles; state.destinations = destinations;

  window.addEventListener('hashchange', router);
  router();
}

async function refreshLookups() {
  const [warehouses, products, responsibles, destinations] = await Promise.all([
    Api.get('/api/warehouses'), Api.get('/api/products'),
    Api.get('/api/responsibles'), Api.get('/api/destinations')
  ]);
  state.warehouses = warehouses; state.products = products;
  state.responsibles = responsibles; state.destinations = destinations;
}

// ---------------------------------------------------------------------
// ROUTER
// ---------------------------------------------------------------------
const VIEWS = {
  dashboard: viewDashboard,
  stock: viewStock,
  depositos: viewWarehouses,
  productos: viewProducts,
  entradas: viewEntradas,
  salidas: viewSalidas,
  transferencias: viewTransfers,
  inventario: viewInventoryCounts,
  movimientos: viewMovements,
  responsables: viewResponsibles,
  destinos: viewDestinations,
  reportes: viewReports,
  auditoria: viewAudit,
  configuracion: viewConfig,
};

function router() {
  const hash = location.hash.replace('#/', '') || 'dashboard';
  document.querySelectorAll('.sidebar a').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === hash);
  });
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="empty-state">CARGANDO…</div>';
  const fn = VIEWS[hash] || viewDashboard;
  fn(main).catch((err) => {
    main.innerHTML = `<div class="empty-state">ERROR: ${apiErrorMessage(err)}</div>`;
  });
}

// ---------------------------------------------------------------------
// HELPERS DE UI: TABLA GENERICA Y MODAL DE FORMULARIO
// ---------------------------------------------------------------------
function renderTable(container, { columns, rows, emptyText }) {
  if (!rows.length) {
    container.appendChild(el(`<div class="empty-state">${emptyText || 'SIN REGISTROS'}</div>`));
    return;
  }
  const wrap = el('<div class="table-wrap"><table><thead><tr></tr></thead><tbody></tbody></table></div>');
  const trHead = wrap.querySelector('thead tr');
  columns.forEach((c) => trHead.appendChild(el(`<th>${c.label}</th>`)));
  const tbody = wrap.querySelector('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    columns.forEach((c) => {
      const td = document.createElement('td');
      const val = c.render ? c.render(row) : (row[c.key] ?? '');
      if (val instanceof Node) td.appendChild(val); else td.innerHTML = val;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  container.appendChild(wrap);
}

function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

function openFormModal({ title, fields, initial = {}, onSubmit, submitLabel = 'GUARDAR' }) {
  const root = document.getElementById('modal-root');
  const overlay = el('<div class="modal-overlay"></div>');
  const box = el(`<div class="modal-box"><h3>${title}</h3><form class="form-grid" id="dyn-form"></form>
    <div class="modal-actions">
      <button type="button" class="btn btn-outline" id="dyn-cancel">CANCELAR</button>
      <button type="submit" form="dyn-form" class="btn btn-primary">${submitLabel}</button>
    </div></div>`);
  overlay.appendChild(box);
  root.innerHTML = ''; root.appendChild(overlay);

  const form = box.querySelector('#dyn-form');
  fields.forEach((f) => {
    const wrap = el(`<div class="form-field ${f.full ? 'full' : ''}"><label>${f.label}${f.required ? ' *' : ''}</label></div>`);
    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      if (!f.required) input.appendChild(el(`<option value="">—</option>`));
      (f.options || []).forEach((o) => {
        const opt = el(`<option value="${o.value}">${o.label}</option>`);
        if (String(initial[f.name]) === String(o.value)) opt.selected = true;
        input.appendChild(opt);
      });
    } else if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.value = initial[f.name] || '';
    } else {
      input = document.createElement('input');
      input.type = f.type || 'text';
      if (f.step) input.step = f.step;
      input.value = initial[f.name] ?? '';
    }
    input.name = f.name;
    if (f.required) input.required = true;
    wrap.appendChild(input);
    form.appendChild(wrap);
  });

  box.querySelector('#dyn-cancel').addEventListener('click', closeModal);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {};
    fields.forEach((f) => { data[f.name] = form.elements[f.name].value; });
    try {
      await onSubmit(data);
      closeModal();
    } catch (err) {
      showToast(apiErrorMessage(err), 'error');
    }
  });
}

function warehouseOptions() { return state.warehouses.map((w) => ({ value: w.id, label: w.name })); }
function productOptions() { return state.products.map((p) => ({ value: p.id, label: p.name })); }
function responsibleOptions() { return state.responsibles.map((r) => ({ value: r.id, label: `${r.first_name} ${r.last_name || ''}`.trim() })); }
function destinationOptions() { return state.destinations.map((d) => ({ value: d.id, label: `${d.name} (${d.type})` })); }


// ---------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------
async function viewDashboard(main) {
  const d = await Api.get('/api/dashboard');
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">DASHBOARD</h2>'));

  const kpis = el('<div class="kpi-grid"></div>');
  const cards = [
    ['STOCK TOTAL', fmtNum(d.totalStock), ''],
    ...d.byWarehouse.map((w) => [`TOTAL ${w.name}`, fmtNum(w.total), '']),
    ['PRODUCTOS CON STOCK BAJO', d.lowStockCount, 'alert'],
    ['PRODUCTOS SIN STOCK', d.noStockCount, 'danger'],
    ['MOVIMIENTOS DEL DÍA', d.movementsToday, 'green'],
    ['ENTRADAS DEL MES', d.inMonth, 'green'],
    ['SALIDAS DEL MES', d.outMonth, ''],
    ['TRANSFERENCIAS PENDIENTES', d.pendingTransfers, 'alert'],
    ['PRÓXIMOS A VENCER', d.expiringSoon.length, 'alert'],
  ];
  cards.forEach(([label, value, cls]) => {
    kpis.appendChild(el(`<div class="kpi-card ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div></div>`));
  });
  main.appendChild(kpis);

  const grid = el('<div style="display:grid; grid-template-columns:1fr 1fr; gap:18px;"></div>');

  const recentPanel = el('<div class="panel"><h3>ÚLTIMOS MOVIMIENTOS</h3></div>');
  renderTable(recentPanel, {
    columns: [
      { key: 'movement_number', label: 'N°' }, { key: 'type', label: 'TIPO' },
      { label: 'FECHA', render: (r) => fmtDate(r.movement_date) },
      { label: 'ORIGEN → DESTINO', render: (r) => `${r.origin_name || '-'} → ${r.dest_name || '-'}` },
    ], rows: d.recentMovements, emptyText: 'SIN MOVIMIENTOS AÚN'
  });
  grid.appendChild(recentPanel);

  const alertPanel = el('<div class="panel"><h3>ALERTAS — PRÓXIMOS A VENCER (60 DÍAS)</h3></div>');
  renderTable(alertPanel, {
    columns: [
      { key: 'name', label: 'PRODUCTO' }, { key: 'lot_code', label: 'LOTE' },
      { label: 'VENCE', render: (r) => fmtDate(r.expiry_date) },
    ], rows: d.expiringSoon, emptyText: 'SIN VENCIMIENTOS PRÓXIMOS'
  });
  grid.appendChild(alertPanel);

  const lowPanel = el('<div class="panel"><h3>STOCK CRÍTICO / BAJO</h3></div>');
  renderTable(lowPanel, {
    columns: [
      { key: 'name', label: 'PRODUCTO' }, { label: 'STOCK ACTUAL', render: (r) => fmtNum(r.total) },
      { label: 'MÍNIMO', render: (r) => fmtNum(r.min_stock) },
    ], rows: d.lowStockList, emptyText: 'SIN PRODUCTOS EN STOCK BAJO'
  });
  grid.appendChild(lowPanel);

  const transitPanel = el('<div class="panel"><h3>TRANSFERENCIAS EN TRÁNSITO</h3></div>');
  renderTable(transitPanel, {
    columns: [
      { key: 'transfer_number', label: 'N°' },
      { label: 'ORIGEN → DESTINO', render: (r) => `${r.origin_name} → ${r.dest_name}` },
      { key: 'status', label: 'ESTADO' },
    ], rows: d.inTransit, emptyText: 'SIN TRANSFERENCIAS EN TRÁNSITO'
  });
  grid.appendChild(transitPanel);

  main.appendChild(grid);
}

// ---------------------------------------------------------------------
// STOCK GENERAL
// ---------------------------------------------------------------------
async function viewStock(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">STOCK GENERAL</h2>'));

  const toolbar = el(`<div class="view-toolbar">
    <input type="text" id="f-search" placeholder="BUSCAR PRODUCTO...">
    <select id="f-warehouse"><option value="">TODOS LOS DEPÓSITOS</option></select>
    <select id="f-status"><option value="">TODOS LOS ESTADOS</option><option value="lowStock">STOCK BAJO</option><option value="noStock">SIN STOCK</option></select>
  </div>`);
  state.warehouses.forEach((w) => toolbar.querySelector('#f-warehouse').appendChild(el(`<option value="${w.id}">${w.name}</option>`)));
  main.appendChild(toolbar);

  const resultDiv = el('<div></div>');
  main.appendChild(resultDiv);

  async function load() {
    const search = toolbar.querySelector('#f-search').value;
    const warehouseId = toolbar.querySelector('#f-warehouse').value;
    const status = toolbar.querySelector('#f-status').value;
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (warehouseId) params.set('warehouseId', warehouseId);
    if (status) params.set(status, 'true');
    const data = await Api.get('/api/stock?' + params.toString());
    resultDiv.innerHTML = '';
    const columns = [
      { key: 'name', label: 'PRODUCTO' }, { key: 'presentation', label: 'PRESENTACIÓN' },
      ...data.warehouses.map((w) => ({ label: w.name, render: (r) => fmtNum(r.byWarehouse[w.id] || 0) })),
      { label: 'TOTAL', render: (r) => `<b>${fmtNum(r.total)}</b>` },
      { label: 'MÍNIMO', render: (r) => fmtNum(r.min_stock) },
      { label: 'ESTADO', render: (r) => {
        const map = { NORMAL: 'badge-ok', BAJO: 'badge-warn', CRITICO: 'badge-danger' };
        return `<span class="badge ${map[r.status]}">${r.status}</span>`;
      }},
    ];
    renderTable(resultDiv, { columns, rows: data.products, emptyText: 'SIN PRODUCTOS PARA MOSTRAR' });
  }
  toolbar.querySelectorAll('input,select').forEach((i) => i.addEventListener('input', load));
  await load();
}

// ---------------------------------------------------------------------
// DEPOSITOS
// ---------------------------------------------------------------------
async function viewWarehouses(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">DEPÓSITOS</h2>'));
  const toolbar = el('<div class="view-toolbar"><button class="btn btn-primary" id="btn-new">+ NUEVO DEPÓSITO</button></div>');
  main.appendChild(toolbar);
  const resultDiv = el('<div></div>');
  main.appendChild(resultDiv);

  const warehouses = await Api.get('/api/warehouses');
  renderTable(resultDiv, {
    columns: [
      { key: 'name', label: 'NOMBRE' }, { key: 'location', label: 'UBICACIÓN' },
      { key: 'responsible_name', label: 'RESPONSABLE' }, { key: 'phone', label: 'TELÉFONO' },
      { label: 'PRODUCTOS', render: (r) => r.product_count },
      { label: 'STOCK TOTAL', render: (r) => fmtNum(r.total_quantity) },
      { label: 'ÚLTIMO MOVIMIENTO', render: (r) => fmtDateTime(r.last_movement_at) },
      { label: 'ESTADO', render: (r) => r.active ? '<span class="badge badge-ok">ACTIVO</span>' : '<span class="badge badge-gray">INACTIVO</span>' },
      { label: '', render: (r) => {
        const btn = el(`<button class="btn btn-outline btn-sm">EDITAR</button>`);
        btn.addEventListener('click', () => editWarehouse(r));
        return btn;
      }},
    ], rows: warehouses, emptyText: 'SIN DEPÓSITOS REGISTRADOS'
  });

  function fieldsFor(initial) {
    return [
      { name: 'name', label: 'NOMBRE', required: true, full: true },
      { name: 'location', label: 'UBICACIÓN', full: true },
      { name: 'responsible_name', label: 'RESPONSABLE' },
      { name: 'phone', label: 'TELÉFONO' },
      { name: 'notes', label: 'OBSERVACIONES', type: 'textarea', full: true },
    ];
  }
  toolbar.querySelector('#btn-new').addEventListener('click', () => {
    openFormModal({
      title: 'NUEVO DEPÓSITO', fields: fieldsFor({}),
      onSubmit: async (data) => { await Api.post('/api/warehouses', data); showToast('DEPÓSITO CREADO', 'success'); await refreshLookups(); router(); }
    });
  });
  function editWarehouse(r) {
    openFormModal({
      title: 'EDITAR DEPÓSITO', fields: fieldsFor(r), initial: r,
      onSubmit: async (data) => { await Api.put('/api/warehouses/' + r.id, { ...data, active: r.active }); showToast('DEPÓSITO ACTUALIZADO', 'success'); await refreshLookups(); router(); }
    });
  }
}

// ---------------------------------------------------------------------
// PRODUCTOS
// ---------------------------------------------------------------------
const UNITS = ['LITRO', 'KILO', 'UNIDAD', 'BIDON', 'CAJA', 'OTRO'];

async function viewProducts(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">PRODUCTOS TAMPA</h2>'));
  const toolbar = el(`<div class="view-toolbar">
    <input type="text" id="f-search" placeholder="BUSCAR...">
    <button class="btn btn-primary" id="btn-new">+ NUEVO PRODUCTO</button>
  </div>`);
  main.appendChild(toolbar);
  const resultDiv = el('<div></div>');
  main.appendChild(resultDiv);

  async function load() {
    const search = toolbar.querySelector('#f-search').value;
    const params = new URLSearchParams(); if (search) params.set('search', search);
    const products = await Api.get('/api/products?' + params.toString());
    resultDiv.innerHTML = '';
    renderTable(resultDiv, {
      columns: [
        { key: 'internal_code', label: 'CÓDIGO' }, { key: 'name', label: 'NOMBRE' },
        { key: 'category', label: 'CATEGORÍA' }, { key: 'presentation', label: 'PRESENTACIÓN' },
        { key: 'unit', label: 'UNIDAD' }, { label: 'STOCK TOTAL', render: (r) => fmtNum(r.total_stock) },
        { label: 'MÍNIMO', render: (r) => fmtNum(r.min_stock) },
        { label: 'ESTADO', render: (r) => r.active ? '<span class="badge badge-ok">ACTIVO</span>' : '<span class="badge badge-gray">INACTIVO</span>' },
        { label: '', render: (r) => {
          const wrap = document.createElement('div');
          const btn = el(`<button class="btn btn-outline btn-sm">EDITAR</button>`);
          btn.addEventListener('click', () => editProduct(r));
          const btn2 = el(`<button class="btn btn-outline btn-sm" style="margin-left:6px;">HISTORIAL</button>`);
          btn2.addEventListener('click', () => showProductHistory(r));
          wrap.appendChild(btn); wrap.appendChild(btn2);
          return wrap;
        }},
      ], rows: products, emptyText: 'SIN PRODUCTOS REGISTRADOS'
    });
  }
  toolbar.querySelector('#f-search').addEventListener('input', load);
  await load();

  function fieldsFor() {
    return [
      { name: 'internal_code', label: 'CÓDIGO INTERNO' }, { name: 'sku', label: 'SKU' },
      { name: 'name', label: 'NOMBRE DEL PRODUCTO', required: true, full: true },
      { name: 'active_ingredient', label: 'PRINCIPIO ACTIVO', full: true },
      { name: 'concentration', label: 'CONCENTRACIÓN' }, { name: 'presentation', label: 'PRESENTACIÓN' },
      { name: 'unit', label: 'UNIDAD', type: 'select', options: UNITS.map((u) => ({ value: u, label: u })), required: true },
      { name: 'category', label: 'CATEGORÍA' },
      { name: 'min_stock', label: 'STOCK MÍNIMO', type: 'number', step: '0.001' },
      { name: 'description', label: 'DESCRIPCIÓN', type: 'textarea', full: true },
      { name: 'notes', label: 'OBSERVACIONES', type: 'textarea', full: true },
      { name: 'photo_url', label: 'URL DE FOTO (OPCIONAL)', full: true },
    ];
  }
  toolbar.querySelector('#btn-new').addEventListener('click', () => {
    openFormModal({
      title: 'NUEVO PRODUCTO', fields: fieldsFor(),
      onSubmit: async (data) => { await Api.post('/api/products', data); showToast('PRODUCTO CREADO', 'success'); await refreshLookups(); load(); }
    });
  });
  function editProduct(r) {
    openFormModal({
      title: 'EDITAR PRODUCTO', fields: fieldsFor(), initial: r,
      onSubmit: async (data) => { await Api.put('/api/products/' + r.id, { ...data, active: r.active }); showToast('PRODUCTO ACTUALIZADO', 'success'); await refreshLookups(); load(); }
    });
  }
  async function showProductHistory(r) {
    const detail = await Api.get('/api/products/' + r.id);
    const root = document.getElementById('modal-root');
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el(`<div class="modal-box" style="max-width:820px;"><h3>HISTORIAL — ${detail.name}</h3></div>`);
    overlay.appendChild(box); root.innerHTML = ''; root.appendChild(overlay);

    box.appendChild(el('<h4 style="margin-bottom:6px;font-size:12px;color:#6b7280;">STOCK ACTUAL POR DEPÓSITO</h4>'));
    renderTable(box, { columns: [
      { key: 'warehouse_name', label: 'DEPÓSITO' }, { key: 'lot_code', label: 'LOTE' },
      { label: 'VENCE', render: (x) => fmtDate(x.expiry_date) }, { label: 'CANTIDAD', render: (x) => fmtNum(x.quantity) },
    ], rows: detail.stockByWarehouse, emptyText: 'SIN STOCK ACTUAL' });

    box.appendChild(el('<h4 style="margin:16px 0 6px;font-size:12px;color:#6b7280;">MOVIMIENTOS</h4>'));
    renderTable(box, { columns: [
      { key: 'movement_number', label: 'N°' }, { key: 'type', label: 'TIPO' },
      { label: 'FECHA', render: (x) => fmtDate(x.movement_date) }, { key: 'lot_code', label: 'LOTE' },
      { label: 'CANTIDAD', render: (x) => fmtNum(x.quantity) },
      { label: 'ORIGEN → DESTINO', render: (x) => `${x.origin_name || '-'} → ${x.dest_name || '-'}` },
      { key: 'delivered_by', label: 'ENTREGÓ' }, { key: 'received_by', label: 'RECIBIÓ' },
    ], rows: detail.history, emptyText: 'SIN MOVIMIENTOS REGISTRADOS' });

    const closeBtn = el('<div class="modal-actions"><button class="btn btn-outline">CERRAR</button></div>');
    closeBtn.querySelector('button').addEventListener('click', closeModal);
    box.appendChild(closeBtn);
  }
}

// ---------------------------------------------------------------------
// FORMULARIO DE ITEMS REUTILIZABLE (para entradas y salidas)
// ---------------------------------------------------------------------
function buildItemsEditor(container, { withExpiry }) {
  const wrap = el(`<div>
    <div class="table-wrap"><table class="items-table">
      <thead><tr>
        <th style="width:26%">PRODUCTO</th><th style="width:14%">LOTE</th>
        ${withExpiry ? '<th style="width:14%">VENCIMIENTO</th>' : ''}
        <th style="width:14%">CANTIDAD</th><th style="width:14%">UNIDAD</th><th></th>
      </tr></thead>
      <tbody></tbody>
    </table></div>
    <button type="button" class="btn btn-outline btn-sm" id="add-item-row" style="margin-top:8px;">+ AGREGAR PRODUCTO</button>
  </div>`);
  container.appendChild(wrap);
  const tbody = wrap.querySelector('tbody');

  function addRow() {
    const tr = document.createElement('tr');
    const productSelect = document.createElement('select');
    productSelect.appendChild(el('<option value="">SELECCIONAR…</option>'));
    state.products.forEach((p) => productSelect.appendChild(el(`<option value="${p.id}" data-unit="${p.unit}">${p.name}</option>`)));
    const tdProduct = document.createElement('td'); tdProduct.appendChild(productSelect);

    const lotInput = el('<input type="text" placeholder="LOTE">');
    const tdLot = document.createElement('td'); tdLot.appendChild(lotInput);

    let tdExpiry;
    if (withExpiry) {
      const expInput = el('<input type="date">');
      tdExpiry = document.createElement('td'); tdExpiry.appendChild(expInput);
    }

    const qtyInput = el('<input type="number" step="0.001" min="0" placeholder="0">');
    const tdQty = document.createElement('td'); tdQty.appendChild(qtyInput);

    const unitInput = el('<input type="text" placeholder="UNIDAD">');
    const tdUnit = document.createElement('td'); tdUnit.appendChild(unitInput);
    productSelect.addEventListener('change', () => {
      const opt = productSelect.selectedOptions[0];
      unitInput.value = opt ? (opt.dataset.unit || '') : '';
    });

    const tdRemove = document.createElement('td');
    const removeSpan = el('<span class="items-row-remove">✕</span>');
    removeSpan.addEventListener('click', () => tr.remove());
    tdRemove.appendChild(removeSpan);

    tr.appendChild(tdProduct); tr.appendChild(tdLot);
    if (withExpiry) tr.appendChild(tdExpiry);
    tr.appendChild(tdQty); tr.appendChild(tdUnit); tr.appendChild(tdRemove);
    tbody.appendChild(tr);
  }
  wrap.querySelector('#add-item-row').addEventListener('click', addRow);
  addRow();

  return {
    getItems() {
      return Array.from(tbody.querySelectorAll('tr')).map((tr) => {
        const tds = tr.querySelectorAll('td');
        const productId = tds[0].querySelector('select').value;
        const lotCode = tds[1].querySelector('input').value;
        let idx = 2, expiry = null;
        if (withExpiry) { expiry = tds[2].querySelector('input').value; idx = 3; }
        const quantity = tds[idx].querySelector('input').value;
        const unit = tds[idx + 1].querySelector('input').value;
        return { product_id: productId, lot_code: lotCode || undefined, expiry_date: expiry || undefined, quantity, unit };
      }).filter((it) => it.product_id && it.quantity);
    }
  };
}

// ---------------------------------------------------------------------
// ENTRADAS
// ---------------------------------------------------------------------
async function viewEntradas(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">REGISTRAR ENTRADA</h2>'));

  const panel = el('<div class="panel"></div>');
  const form = el(`<form id="entrada-form">
    <div class="form-grid">
      <div class="form-field"><label>DEPÓSITO DE INGRESO *</label><select name="warehouse_id" required></select></div>
      <div class="form-field"><label>FECHA</label><input type="date" name="movement_date"></div>
      <div class="form-field"><label>QUIÉN ENTREGÓ</label><input type="text" name="delivered_by"></div>
      <div class="form-field"><label>QUIÉN RECIBIÓ</label><input type="text" name="received_by"></div>
      <div class="form-field"><label>N° DE REMISIÓN / FACTURA</label><input type="text" name="document_number"></div>
      <div class="form-field full"><label>OBSERVACIONES</label><textarea name="notes"></textarea></div>
    </div>
  </form>`);
  form.querySelector('[name=warehouse_id]').append(...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
  panel.appendChild(form);

  const itemsHost = document.createElement('div');
  panel.appendChild(el('<h3 style="margin-top:18px;">PRODUCTOS RECIBIDOS</h3>'));
  panel.appendChild(itemsHost);
  const itemsEditor = buildItemsEditor(itemsHost, { withExpiry: true });

  const submitBtn = el('<button class="btn btn-green" style="margin-top:16px;">CONFIRMAR ENTRADA</button>');
  panel.appendChild(submitBtn);
  main.appendChild(panel);

  submitBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const items = itemsEditor.getItems();
    if (!items.length) return showToast('AGREGUE AL MENOS UN PRODUCTO', 'error');
    try {
      await Api.post('/api/movements/entrada', {
        warehouse_id: fd.get('warehouse_id'), movement_date: fd.get('movement_date') || undefined,
        delivered_by: fd.get('delivered_by'), received_by: fd.get('received_by'),
        document_number: fd.get('document_number'), notes: fd.get('notes'), items,
      });
      showToast('ENTRADA REGISTRADA CORRECTAMENTE', 'success');
      await refreshLookups(); router();
    } catch (err) { showToast(apiErrorMessage(err), 'error'); }
  });

  main.appendChild(el('<h3 style="margin:22px 0 10px;color:#001E4F;">ÚLTIMAS ENTRADAS</h3>'));
  const listDiv = document.createElement('div'); main.appendChild(listDiv);
  const recent = await Api.get('/api/movements?type=ENTRADA');
  renderTable(listDiv, {
    columns: [
      { key: 'movement_number', label: 'N°' }, { label: 'FECHA', render: (r) => fmtDate(r.movement_date) },
      { key: 'dest_name', label: 'DEPÓSITO' }, { key: 'delivered_by', label: 'ENTREGÓ' }, { key: 'received_by', label: 'RECIBIÓ' },
      { label: 'PRODUCTOS', render: (r) => (r.items || []).map((i) => `${i.product_name} (${fmtNum(i.quantity)})`).join(', ') },
    ], rows: recent.slice(0, 30), emptyText: 'SIN ENTRADAS REGISTRADAS AÚN'
  });
}

// ---------------------------------------------------------------------
// SALIDAS
// ---------------------------------------------------------------------
const SALIDA_REASONS = ['VENTA', 'DEMOSTRACION', 'ENSAYO', 'MUESTRA', 'USO INTERNO', 'TRASLADO', 'DEVOLUCION', 'BONIFICACION', 'OTROS'];

async function viewSalidas(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">REGISTRAR SALIDA</h2>'));

  const panel = el('<div class="panel"></div>');
  const form = el(`<form id="salida-form">
    <div class="form-grid">
      <div class="form-field"><label>DEPÓSITO *</label><select name="warehouse_id" required></select></div>
      <div class="form-field"><label>FECHA</label><input type="date" name="movement_date"></div>
      <div class="form-field"><label>QUIÉN RETIRA</label><input type="text" name="picked_up_by"></div>
      <div class="form-field"><label>QUIÉN ENTREGA</label><input type="text" name="delivered_by"></div>
      <div class="form-field"><label>DESTINO / CLIENTE / ESTANCIA</label><select name="destination_id"></select></div>
      <div class="form-field"><label>MOTIVO DE LA SALIDA *</label><select name="reason" required></select></div>
      <div class="form-field"><label>N° DE PEDIDO / FACTURA / REMISIÓN</label><input type="text" name="document_number"></div>
      <div class="form-field full"><label>OBSERVACIONES</label><textarea name="notes"></textarea></div>
    </div>
  </form>`);
  form.querySelector('[name=warehouse_id]').append(...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
  form.querySelector('[name=destination_id]').append(el('<option value="">—</option>'), ...destinationOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
  form.querySelector('[name=reason]').append(el('<option value="">—</option>'), ...SALIDA_REASONS.map((r) => el(`<option value="${r}">${r}</option>`)));
  panel.appendChild(form);

  const itemsHost = document.createElement('div');
  panel.appendChild(el('<h3 style="margin-top:18px;">PRODUCTOS A RETIRAR</h3>'));
  panel.appendChild(itemsHost);
  const itemsEditor = buildItemsEditor(itemsHost, { withExpiry: false });

  const summary = el('<div class="summary-box hidden"></div>');
  panel.appendChild(summary);

  const submitBtn = el('<button class="btn btn-green" style="margin-top:16px;">CONFIRMAR SALIDA</button>');
  panel.appendChild(submitBtn);
  main.appendChild(panel);

  submitBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const items = itemsEditor.getItems();
    if (!items.length) return showToast('AGREGUE AL MENOS UN PRODUCTO', 'error');
    if (!fd.get('reason')) return showToast('INDIQUE EL MOTIVO DE LA SALIDA', 'error');

    const wName = state.warehouses.find((w) => String(w.id) === fd.get('warehouse_id'))?.name || '';
    const itemsTxt = items.map((it) => {
      const p = state.products.find((p) => String(p.id) === String(it.product_id));
      return `${fmtNum(it.quantity)} ${it.unit || ''} DE ${p ? p.name : it.product_id}`;
    }).join(' / ');
    summary.textContent = `ESTÁ POR REGISTRAR UNA SALIDA DE ${itemsTxt} DESDE ${wName}.`;
    summary.classList.remove('hidden');
    if (!submitBtn.dataset.confirmed) { submitBtn.dataset.confirmed = '1'; submitBtn.textContent = 'CONFIRMAR MOVIMIENTO'; return; }

    try {
      await Api.post('/api/movements/salida', {
        warehouse_id: fd.get('warehouse_id'), movement_date: fd.get('movement_date') || undefined,
        picked_up_by: fd.get('picked_up_by'), delivered_by: fd.get('delivered_by'),
        destination_id: fd.get('destination_id') || undefined, reason: fd.get('reason'),
        document_number: fd.get('document_number'), notes: fd.get('notes'), items,
      });
      showToast('SALIDA REGISTRADA CORRECTAMENTE', 'success');
      await refreshLookups(); router();
    } catch (err) { showToast(apiErrorMessage(err), 'error'); }
  });

  main.appendChild(el('<h3 style="margin:22px 0 10px;color:#001E4F;">ÚLTIMAS SALIDAS</h3>'));
  const listDiv = document.createElement('div'); main.appendChild(listDiv);
  const recent = await Api.get('/api/movements?type=SALIDA');
  renderTable(listDiv, {
    columns: [
      { key: 'movement_number', label: 'N°' }, { label: 'FECHA', render: (r) => fmtDate(r.movement_date) },
      { key: 'origin_name', label: 'DEPÓSITO' }, { key: 'reason', label: 'MOTIVO' },
      { label: 'PRODUCTOS', render: (r) => (r.items || []).map((i) => `${i.product_name} (${fmtNum(i.quantity)})`).join(', ') },
    ], rows: recent.slice(0, 30), emptyText: 'SIN SALIDAS REGISTRADAS AÚN'
  });
}

// ---------------------------------------------------------------------
// TRANSFERENCIAS
// ---------------------------------------------------------------------
async function viewTransfers(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">TRANSFERENCIAS ENTRE DEPÓSITOS</h2>'));
  const toolbar = el('<div class="view-toolbar"><button class="btn btn-primary" id="btn-new">+ NUEVA TRANSFERENCIA</button></div>');
  main.appendChild(toolbar);
  const listDiv = document.createElement('div'); main.appendChild(listDiv);

  async function load() {
    const transfers = await Api.get('/api/transfers');
    listDiv.innerHTML = '';
    renderTable(listDiv, {
      columns: [
        { key: 'transfer_number', label: 'N°' },
        { label: 'ORIGEN → DESTINO', render: (r) => `${r.origin_name} → ${r.dest_name}` },
        { label: 'PRODUCTOS', render: (r) => (r.items || []).map((i) => `${i.product_name} (${fmtNum(i.quantity_sent)}${i.quantity_received != null ? '/' + fmtNum(i.quantity_received) + ' REC.' : ''})`).join(', ') },
        { key: 'carrier', label: 'TRANSPORTISTA' },
        { label: 'ESTADO', render: (r) => {
          const map = { PENDIENTE: 'badge-gray', DESPACHADA: 'badge-info', EN_TRANSITO: 'badge-warn', RECIBIDA: 'badge-ok', CANCELADA: 'badge-danger' };
          return `<span class="badge ${map[r.status] || ''}">${r.status.replace('_',' ')}</span>`;
        }},
        { label: '', render: (r) => {
          const wrap = document.createElement('div');
          if (r.status === 'PENDIENTE') {
            const b1 = el('<button class="btn btn-green btn-sm">DESPACHAR</button>');
            b1.addEventListener('click', async () => {
              try { await Api.post(`/api/transfers/${r.id}/despachar`); showToast('TRANSFERENCIA DESPACHADA', 'success'); load(); }
              catch (e) { showToast(apiErrorMessage(e), 'error'); }
            });
            const b2 = el('<button class="btn btn-outline btn-sm" style="margin-left:6px;">CANCELAR</button>');
            b2.addEventListener('click', async () => {
              try { await Api.post(`/api/transfers/${r.id}/cancelar`); showToast('TRANSFERENCIA CANCELADA', 'success'); load(); }
              catch (e) { showToast(apiErrorMessage(e), 'error'); }
            });
            wrap.appendChild(b1); wrap.appendChild(b2);
          } else if (r.status === 'EN_TRANSITO') {
            const b1 = el('<button class="btn btn-green btn-sm">CONFIRMAR RECEPCIÓN</button>');
            b1.addEventListener('click', () => confirmReceive(r));
            wrap.appendChild(b1);
          }
          return wrap;
        }},
      ], rows: transfers, emptyText: 'SIN TRANSFERENCIAS REGISTRADAS'
    });
  }
  await load();

  toolbar.querySelector('#btn-new').addEventListener('click', () => {
    const root = document.getElementById('modal-root');
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el('<div class="modal-box" style="max-width:720px;"><h3>NUEVA TRANSFERENCIA</h3></div>');
    overlay.appendChild(box); root.innerHTML = ''; root.appendChild(overlay);

    const form = el(`<form class="form-grid">
      <div class="form-field"><label>DEPÓSITO ORIGEN *</label><select name="warehouse_origin_id" required></select></div>
      <div class="form-field"><label>DEPÓSITO DESTINO *</label><select name="warehouse_destination_id" required></select></div>
      <div class="form-field"><label>RESPONSABLE DE PREPARACIÓN</label><select name="prepared_by_id"></select></div>
      <div class="form-field"><label>QUIÉN RETIRA</label><input type="text" name="picked_up_by"></div>
      <div class="form-field"><label>TRANSPORTISTA</label><input type="text" name="carrier"></div>
      <div class="form-field"><label>VEHÍCULO</label><input type="text" name="vehicle"></div>
      <div class="form-field"><label>FECHA DE SALIDA</label><input type="date" name="ship_date"></div>
      <div class="form-field"><label>FECHA ESTIMADA DE LLEGADA</label><input type="date" name="eta_date"></div>
      <div class="form-field full"><label>OBSERVACIONES</label><textarea name="notes"></textarea></div>
    </form>`);
    form.querySelector('[name=warehouse_origin_id]').append(el('<option value="">—</option>'), ...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
    form.querySelector('[name=warehouse_destination_id]').append(el('<option value="">—</option>'), ...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
    form.querySelector('[name=prepared_by_id]').append(el('<option value="">—</option>'), ...responsibleOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
    box.appendChild(form);

    box.appendChild(el('<h4 style="margin:16px 0 6px;font-size:12px;color:#6b7280;">PRODUCTOS A TRANSFERIR</h4>'));
    const itemsHost = document.createElement('div'); box.appendChild(itemsHost);
    const itemsEditor = buildItemsEditor(itemsHost, { withExpiry: false });

    const actions = el(`<div class="modal-actions">
      <button type="button" class="btn btn-outline">CANCELAR</button>
      <button type="button" class="btn btn-primary">CREAR TRANSFERENCIA</button>
    </div>`);
    box.appendChild(actions);
    actions.querySelectorAll('button')[0].addEventListener('click', closeModal);
    actions.querySelectorAll('button')[1].addEventListener('click', async () => {
      const fd = new FormData(form);
      const origin = fd.get('warehouse_origin_id'), dest = fd.get('warehouse_destination_id');
      if (!origin || !dest) return showToast('SELECCIONE ORIGEN Y DESTINO', 'error');
      if (origin === dest) return showToast('ORIGEN Y DESTINO NO PUEDEN SER IGUALES', 'error');
      const items = itemsEditor.getItems();
      if (!items.length) return showToast('AGREGUE AL MENOS UN PRODUCTO', 'error');
      try {
        await Api.post('/api/transfers', {
          warehouse_origin_id: origin, warehouse_destination_id: dest,
          prepared_by_id: fd.get('prepared_by_id') || undefined, picked_up_by: fd.get('picked_up_by'),
          carrier: fd.get('carrier'), vehicle: fd.get('vehicle'), ship_date: fd.get('ship_date') || undefined,
          eta_date: fd.get('eta_date') || undefined, notes: fd.get('notes'), items,
        });
        showToast('TRANSFERENCIA CREADA (PENDIENTE DE DESPACHO)', 'success');
        closeModal(); load();
      } catch (err) { showToast(apiErrorMessage(err), 'error'); }
    });
  });

  function confirmReceive(r) {
    const root = document.getElementById('modal-root');
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el(`<div class="modal-box"><h3>CONFIRMAR RECEPCIÓN — ${r.transfer_number}</h3>
      <div class="form-field"><label>QUIÉN RECIBIÓ *</label><input type="text" id="received-by"></div></div>`);
    overlay.appendChild(box); root.innerHTML = ''; root.appendChild(overlay);

    box.appendChild(el('<h4 style="margin:14px 0 6px;font-size:12px;color:#6b7280;">CANTIDAD REAL RECIBIDA</h4>'));
    const table = el('<table class="items-table"><thead><tr><th>PRODUCTO</th><th>ENVIADO</th><th>RECIBIDO</th></tr></thead><tbody></tbody></table>');
    box.appendChild(table);
    const items = r.items || [];
    items.forEach((it) => {
      const tr = el(`<tr>
        <td>${it.product_name}${it.lot_code ? ' (LOTE ' + it.lot_code + ')' : ''}</td>
        <td>${fmtNum(it.quantity_sent)}</td>
        <td><input type="number" step="0.001" value="${it.quantity_sent}" data-item-id="${it.id}" style="width:90px;"></td>
      </tr>`);
      table.querySelector('tbody').appendChild(tr);
    });

    const actions = el(`<div class="modal-actions">
      <button type="button" class="btn btn-outline">CANCELAR</button>
      <button type="button" class="btn btn-primary">CONFIRMAR RECEPCIÓN</button>
    </div>`);
    box.appendChild(actions);
    actions.querySelectorAll('button')[0].addEventListener('click', closeModal);
    actions.querySelectorAll('button')[1].addEventListener('click', async () => {
      const receivedBy = box.querySelector('#received-by').value;
      if (!receivedBy) return showToast('INDIQUE QUIÉN RECIBIÓ', 'error');
      const qtyInputs = Array.from(table.querySelectorAll('input[data-item-id]'));
      try {
        await Api.post(`/api/transfers/${r.id}/recibir`, {
          received_by: receivedBy,
          items: qtyInputs.map((inp) => ({ transfer_item_id: inp.dataset.itemId, quantity_received: inp.value }))
        });
        showToast('RECEPCIÓN CONFIRMADA', 'success');
        closeModal(); load();
      } catch (err) { showToast(apiErrorMessage(err), 'error'); }
    });
  }
}

// ---------------------------------------------------------------------
// INVENTARIO FISICO (CONTEOS)
// ---------------------------------------------------------------------
async function viewInventoryCounts(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">CONTROL DE INVENTARIO</h2>'));
  const toolbar = el(`<div class="view-toolbar">
    <select id="new-warehouse"></select>
    <button class="btn btn-primary" id="btn-new">INICIAR CONTEO</button>
  </div>`);
  toolbar.querySelector('#new-warehouse').append(el('<option value="">SELECCIONAR DEPÓSITO…</option>'), ...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
  main.appendChild(toolbar);
  const listDiv = document.createElement('div'); main.appendChild(listDiv);

  async function load() {
    const counts = await Api.get('/api/inventory-counts');
    listDiv.innerHTML = '';
    renderTable(listDiv, {
      columns: [
        { key: 'count_number', label: 'N°' }, { key: 'warehouse_name', label: 'DEPÓSITO' },
        { label: 'FECHA', render: (r) => fmtDate(r.count_date) },
        { label: 'ESTADO', render: (r) => r.status === 'CERRADO' ? '<span class="badge badge-ok">CERRADO</span>' : '<span class="badge badge-warn">ABIERTO</span>' },
        { label: '', render: (r) => {
          const btn = el(`<button class="btn btn-outline btn-sm">${r.status === 'ABIERTO' ? 'CONTAR / CERRAR' : 'VER'}</button>`);
          btn.addEventListener('click', () => openCount(r));
          return btn;
        }},
      ], rows: counts, emptyText: 'SIN CONTEOS REGISTRADOS'
    });
  }
  await load();

  toolbar.querySelector('#btn-new').addEventListener('click', async () => {
    const warehouseId = toolbar.querySelector('#new-warehouse').value;
    if (!warehouseId) return showToast('SELECCIONE UN DEPÓSITO', 'error');
    try {
      await Api.post('/api/inventory-counts', { warehouse_id: warehouseId });
      showToast('CONTEO INICIADO', 'success'); load();
    } catch (err) { showToast(apiErrorMessage(err), 'error'); }
  });

  async function openCount(r) {
    const detail = await Api.get('/api/inventory-counts/' + r.id);
    const root = document.getElementById('modal-root');
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el(`<div class="modal-box" style="max-width:760px;"><h3>${detail.count_number} — ${detail.warehouse_name}</h3></div>`);
    overlay.appendChild(box); root.innerHTML = ''; root.appendChild(overlay);

    const readonly = detail.status === 'CERRADO';
    const table = el('<table class="items-table"><thead><tr><th>PRODUCTO</th><th>LOTE</th><th>STOCK SISTEMA</th><th>CANTIDAD FÍSICA</th><th>DIFERENCIA</th></tr></thead><tbody></tbody></table>');
    detail.items.forEach((it) => {
      const tr = el(`<tr>
        <td>${it.product_name}</td><td>${it.lot_code || '-'}</td><td>${fmtNum(it.system_qty)}</td>
        <td>${readonly ? fmtNum(it.physical_qty) : `<input type="number" step="0.001" value="${it.physical_qty ?? it.system_qty}" data-item-id="${it.id}" style="width:100px;">`}</td>
        <td>${it.difference != null ? fmtNum(it.difference) : '-'}</td>
      </tr>`);
      table.querySelector('tbody').appendChild(tr);
    });
    box.appendChild(table);

    const actions = el('<div class="modal-actions"><button type="button" class="btn btn-outline">CERRAR VENTANA</button></div>');
    box.appendChild(actions);
    actions.querySelector('button').addEventListener('click', closeModal);
    if (!readonly) {
      const closeBtn = el('<button type="button" class="btn btn-primary">CERRAR CONTEO Y GENERAR AJUSTES</button>');
      actions.appendChild(closeBtn);
      closeBtn.addEventListener('click', async () => {
        const inputs = Array.from(table.querySelectorAll('input[data-item-id]'));
        try {
          await Api.post(`/api/inventory-counts/${detail.id}/cerrar`, {
            items: inputs.map((i) => ({ item_id: i.dataset.itemId, physical_qty: i.value }))
          });
          showToast('CONTEO CERRADO. SE GENERARON LOS AJUSTES NECESARIOS.', 'success');
          closeModal(); load();
        } catch (err) { showToast(apiErrorMessage(err), 'error'); }
      });
    }
  }
}

// ---------------------------------------------------------------------
// MOVIMIENTOS (LISTADO GENERAL)
// ---------------------------------------------------------------------
const MOVEMENT_TYPES = ['ENTRADA','SALIDA','DEVOLUCION','AJUSTE_POSITIVO','AJUSTE_NEGATIVO','DANADA','VENCIDA','TRANSFERENCIA_SALIDA','TRANSFERENCIA_ENTRADA'];

async function viewMovements(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">MOVIMIENTOS</h2>'));
  const toolbar = el(`<div class="view-toolbar">
    <input type="text" id="f-search" placeholder="N° DE MOVIMIENTO...">
    <select id="f-type"><option value="">TODOS LOS TIPOS</option></select>
    <select id="f-warehouse"><option value="">TODOS LOS DEPÓSITOS</option></select>
    <input type="date" id="f-from"><input type="date" id="f-to">
  </div>`);
  toolbar.querySelector('#f-type').append(...MOVEMENT_TYPES.map((t) => el(`<option value="${t}">${t.replace('_',' ')}</option>`)));
  toolbar.querySelector('#f-warehouse').append(...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
  main.appendChild(toolbar);
  const listDiv = document.createElement('div'); main.appendChild(listDiv);

  async function load() {
    const params = new URLSearchParams();
    const s = toolbar.querySelector('#f-search').value; if (s) params.set('search', s);
    const t = toolbar.querySelector('#f-type').value; if (t) params.set('type', t);
    const w = toolbar.querySelector('#f-warehouse').value; if (w) params.set('warehouseId', w);
    const from = toolbar.querySelector('#f-from').value; if (from) params.set('dateFrom', from);
    const to = toolbar.querySelector('#f-to').value; if (to) params.set('dateTo', to);
    const rows = await Api.get('/api/movements?' + params.toString());
    listDiv.innerHTML = '';
    renderTable(listDiv, {
      columns: [
        { key: 'movement_number', label: 'N°' }, { key: 'type', label: 'TIPO' },
        { label: 'FECHA', render: (r) => fmtDate(r.movement_date) },
        { label: 'ORIGEN → DESTINO', render: (r) => `${r.origin_name || '-'} → ${r.dest_name || '-'}` },
        { label: 'PRODUCTOS', render: (r) => (r.items || []).map((i) => `${i.product_name} (${fmtNum(i.quantity)})`).join(', ') },
        { key: 'reason', label: 'MOTIVO' }, { key: 'created_by', label: 'REGISTRADO POR' },
      ], rows, emptyText: 'SIN MOVIMIENTOS PARA ESTOS FILTROS'
    });
  }
  toolbar.querySelectorAll('input,select').forEach((i) => i.addEventListener('input', load));
  await load();
}

// ---------------------------------------------------------------------
// RESPONSABLES
// ---------------------------------------------------------------------
async function viewResponsibles(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">RESPONSABLES</h2>'));
  const toolbar = el('<div class="view-toolbar"><button class="btn btn-primary" id="btn-new">+ NUEVO RESPONSABLE</button></div>');
  main.appendChild(toolbar);
  const listDiv = document.createElement('div'); main.appendChild(listDiv);

  async function load() {
    const rows = await Api.get('/api/responsibles');
    listDiv.innerHTML = '';
    renderTable(listDiv, {
      columns: [
        { label: 'NOMBRE', render: (r) => `${r.first_name} ${r.last_name || ''}` }, { key: 'company', label: 'EMPRESA' },
        { key: 'position', label: 'CARGO' }, { key: 'phone', label: 'TELÉFONO' }, { key: 'email', label: 'EMAIL' },
        { key: 'warehouse_name', label: 'DEPÓSITO ASIGNADO' },
        { label: 'ESTADO', render: (r) => r.active ? '<span class="badge badge-ok">ACTIVO</span>' : '<span class="badge badge-gray">INACTIVO</span>' },
        { label: '', render: (r) => { const b = el('<button class="btn btn-outline btn-sm">EDITAR</button>'); b.addEventListener('click', () => edit(r)); return b; } },
      ], rows, emptyText: 'SIN RESPONSABLES REGISTRADOS'
    });
  }
  await load();

  function fieldsFor() {
    return [
      { name: 'first_name', label: 'NOMBRE', required: true }, { name: 'last_name', label: 'APELLIDO' },
      { name: 'company', label: 'EMPRESA' }, { name: 'position', label: 'CARGO' },
      { name: 'phone', label: 'TELÉFONO' }, { name: 'email', label: 'EMAIL' },
      { name: 'warehouse_id', label: 'DEPÓSITO ASIGNADO', type: 'select', options: warehouseOptions() },
    ];
  }
  toolbar.querySelector('#btn-new').addEventListener('click', () => {
    openFormModal({ title: 'NUEVO RESPONSABLE', fields: fieldsFor(),
      onSubmit: async (data) => { await Api.post('/api/responsibles', data); showToast('RESPONSABLE CREADO', 'success'); await refreshLookups(); load(); } });
  });
  function edit(r) {
    openFormModal({ title: 'EDITAR RESPONSABLE', fields: fieldsFor(), initial: r,
      onSubmit: async (data) => { await Api.put('/api/responsibles/' + r.id, { ...data, active: r.active }); showToast('RESPONSABLE ACTUALIZADO', 'success'); await refreshLookups(); load(); } });
  }
}

// ---------------------------------------------------------------------
// DESTINOS
// ---------------------------------------------------------------------
const DEST_TYPES = ['CLIENTE','ESTANCIA','VENDEDOR','ENSAYO','DEPOSITO','DEMOSTRACION','OTRO'];

async function viewDestinations(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">DESTINOS</h2>'));
  const toolbar = el('<div class="view-toolbar"><button class="btn btn-primary" id="btn-new">+ NUEVO DESTINO</button></div>');
  main.appendChild(toolbar);
  const listDiv = document.createElement('div'); main.appendChild(listDiv);

  async function load() {
    const rows = await Api.get('/api/destinations');
    listDiv.innerHTML = '';
    renderTable(listDiv, {
      columns: [
        { key: 'name', label: 'NOMBRE' }, { key: 'type', label: 'TIPO' }, { key: 'notes', label: 'OBSERVACIONES' },
        { label: 'ESTADO', render: (r) => r.active ? '<span class="badge badge-ok">ACTIVO</span>' : '<span class="badge badge-gray">INACTIVO</span>' },
        { label: '', render: (r) => { const b = el('<button class="btn btn-outline btn-sm">EDITAR</button>'); b.addEventListener('click', () => edit(r)); return b; } },
      ], rows, emptyText: 'SIN DESTINOS REGISTRADOS'
    });
  }
  await load();
  function fieldsFor() {
    return [
      { name: 'name', label: 'NOMBRE', required: true, full: true },
      { name: 'type', label: 'TIPO', type: 'select', required: true, options: DEST_TYPES.map((t) => ({ value: t, label: t })) },
      { name: 'notes', label: 'OBSERVACIONES', type: 'textarea', full: true },
    ];
  }
  toolbar.querySelector('#btn-new').addEventListener('click', () => {
    openFormModal({ title: 'NUEVO DESTINO', fields: fieldsFor(),
      onSubmit: async (data) => { await Api.post('/api/destinations', data); showToast('DESTINO CREADO', 'success'); await refreshLookups(); load(); } });
  });
  function edit(r) {
    openFormModal({ title: 'EDITAR DESTINO', fields: fieldsFor(), initial: r,
      onSubmit: async (data) => { await Api.put('/api/destinations/' + r.id, { ...data, active: r.active }); showToast('DESTINO ACTUALIZADO', 'success'); await refreshLookups(); load(); } });
  }
}

// ---------------------------------------------------------------------
// REPORTES
// ---------------------------------------------------------------------
async function viewReports(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">REPORTES</h2>'));

  const filters = el(`<div class="panel">
    <h3>FILTROS (APLICAN A LOS REPORTES QUE CORRESPONDA)</h3>
    <div class="view-toolbar">
      <label style="font-size:11px;">DESDE <input type="date" id="r-from"></label>
      <label style="font-size:11px;">HASTA <input type="date" id="r-to"></label>
      <select id="r-warehouse"><option value="">TODOS LOS DEPÓSITOS</option></select>
      <select id="r-format"><option value="csv">CSV</option><option value="xlsx">EXCEL (XLSX)</option></select>
    </div>
  </div>`);
  filters.querySelector('#r-warehouse').append(...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
  main.appendChild(filters);

  const reports = [
    ['STOCK ACTUAL (GENERAL O POR DEPÓSITO)', 'stock-actual', true],
    ['MOVIMIENTOS POR FECHA / DEPÓSITO', 'movimientos', true],
    ['PRODUCTOS CON STOCK BAJO', 'stock-bajo', false],
    ['PRODUCTOS PRÓXIMOS A VENCER', 'vencimientos', false],
    ['MERCADERÍA ENTREGADA / RETIRADA POR PERSONA', 'por-persona', true],
  ];
  const grid = el('<div class="kpi-grid"></div>');
  reports.forEach(([label, endpoint, useFilters]) => {
    const card = el(`<div class="kpi-card"><div class="kpi-label">${label}</div></div>`);
    const btn = el('<button class="btn btn-primary btn-sm" style="margin-top:10px;">DESCARGAR</button>');
    card.appendChild(btn);
    btn.addEventListener('click', () => {
      const params = new URLSearchParams();
      params.set('format', filters.querySelector('#r-format').value);
      if (useFilters) {
        const from = filters.querySelector('#r-from').value; if (from) params.set('dateFrom', from);
        const to = filters.querySelector('#r-to').value; if (to) params.set('dateTo', to);
        const w = filters.querySelector('#r-warehouse').value; if (w) params.set('warehouseId', w);
      }
      window.open(`/api/reports/${endpoint}?` + params.toString(), '_blank');
    });
    grid.appendChild(card);
  });
  main.appendChild(grid);
}

// ---------------------------------------------------------------------
// AUDITORIA
// ---------------------------------------------------------------------
async function viewAudit(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">AUDITORÍA</h2>'));
  const rows = await Api.get('/api/audit');
  const listDiv = document.createElement('div'); main.appendChild(listDiv);
  renderTable(listDiv, {
    columns: [
      { label: 'FECHA', render: (r) => fmtDateTime(r.created_at) }, { key: 'table_name', label: 'TABLA' },
      { key: 'action', label: 'ACCIÓN' }, { key: 'user_name', label: 'USUARIO' }, { key: 'reason', label: 'MOTIVO' },
    ], rows, emptyText: 'SIN REGISTROS DE AUDITORÍA'
  });
}

// ---------------------------------------------------------------------
// CONFIGURACION
// ---------------------------------------------------------------------
async function viewConfig(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">CONFIGURACIÓN</h2>'));

  main.appendChild(el(`<div class="panel"><h3>PARÁMETROS GENERALES</h3></div>`));
  const panel = main.querySelector('.panel');
  const rows = await Api.get('/api/config');
  rows.forEach((r) => {
    const field = el(`<div class="form-field" style="max-width:360px; margin-bottom:10px;">
      <label>${r.key.replace(/_/g, ' ')}</label>
      <input type="text" value="${r.value}">
    </div>`);
    const input = field.querySelector('input');
    input.addEventListener('change', async () => {
      try { await Api.put('/api/config/' + r.key, { value: input.value }); showToast('CONFIGURACIÓN ACTUALIZADA', 'success'); }
      catch (err) { showToast(apiErrorMessage(err), 'error'); }
    });
    panel.appendChild(field);
  });

  main.appendChild(el(`<div class="panel">
    <h3>ACCESOS RÁPIDOS</h3>
    <p style="font-size:12.5px;color:#6b7280;">
      PARA AGREGAR DEPÓSITOS, PRODUCTOS, RESPONSABLES O DESTINOS, USE LOS MÓDULOS CORRESPONDIENTES EN EL MENÚ LATERAL.
      EL STOCK MÍNIMO DE CADA PRODUCTO SE EDITA DESDE "PRODUCTOS".
    </p>
  </div>`));
}

// ---------------------------------------------------------------------
// SIDEBAR MOVIL + ARRANQUE
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', initAuth);
