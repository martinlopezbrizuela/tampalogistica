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
let pendingStockFilter = null; // seteado desde el dashboard al tocar una tarjeta de alerta

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
  movimientos: viewMovements,
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
    ['PRODUCTOS CON STOCK BAJO', d.lowStockCount, 'alert', 'STOCK_BAJO'],
    ['PRODUCTOS SIN STOCK', d.noStockCount, 'danger', 'SIN_STOCK'],
    ['MOVIMIENTOS DEL DÍA', d.movementsToday, 'green'],
    ['ENTRADAS DEL MES', d.inMonth, 'green'],
    ['SALIDAS DEL MES', d.outMonth, ''],
    ['TRANSFERENCIAS PENDIENTES', d.pendingTransfers, 'alert'],
    ['PRÓXIMOS A VENCER', d.expiringSoon.length, 'alert'],
  ];
  cards.forEach(([label, value, cls, filter]) => {
    const card = el(`<div class="kpi-card ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div></div>`);
    if (filter) { card.style.cursor = 'pointer'; card.addEventListener('click', () => { pendingStockFilter = filter; location.hash = '#/stock'; }); }
    kpis.appendChild(card);
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
// HELPERS COMPARTIDOS: EDITOR DE ITEMS Y CONSTANTES
// ---------------------------------------------------------------------
const UNITS = ['LITRO', 'KILO', 'UNIDAD', 'BIDON', 'CAJA', 'OTRO'];
const SALIDA_REASONS = ['VENTA', 'DEMOSTRACION', 'ENSAYO', 'MUESTRA', 'USO INTERNO', 'TRASLADO', 'DEVOLUCION', 'BONIFICACION', 'OTROS'];
const DEST_TYPES = ['CLIENTE', 'ESTANCIA', 'VENDEDOR', 'ENSAYO', 'DEPOSITO', 'DEMOSTRACION', 'OTRO'];
const ADJUST_TYPES = [
  { value: 'AJUSTE_POSITIVO', label: 'AJUSTE POSITIVO (SUMA STOCK)' },
  { value: 'AJUSTE_NEGATIVO', label: 'AJUSTE NEGATIVO (RESTA STOCK)' },
  { value: 'DEVOLUCION', label: 'DEVOLUCIÓN (SUMA STOCK)' },
  { value: 'DANADA', label: 'MERCADERÍA DAÑADA (RESTA STOCK)' },
  { value: 'VENCIDA', label: 'MERCADERÍA VENCIDA (RESTA STOCK)' },
];

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

// Selector con "+ Nuevo" inline para Responsable o Destino, sin salir del formulario
function buildQuickSelect({ label, options, onCreateNew }) {
  const wrap = el(`<div class="form-field"><label>${label}</label>
    <div style="display:flex; gap:6px;">
      <select style="flex:1;"><option value="">—</option></select>
      <button type="button" class="btn btn-outline btn-sm" style="white-space:nowrap;">+ NUEVO</button>
    </div></div>`);
  const select = wrap.querySelector('select');
  options.forEach((o) => select.appendChild(el(`<option value="${o.value}">${o.label}</option>`)));
  wrap.querySelector('button').addEventListener('click', () => onCreateNew(select));
  return { wrap, select };
}

const STATUS_BADGE = {
  DISPONIBLE: 'badge-ok', STOCK_BAJO: 'badge-warn', SIN_STOCK: 'badge-danger', SIN_MOVIMIENTO: 'badge-gray',
};
const STATUS_LABEL = {
  DISPONIBLE: 'DISPONIBLE', STOCK_BAJO: 'STOCK BAJO', SIN_STOCK: 'SIN STOCK', SIN_MOVIMIENTO: 'SIN MOVIMIENTO',
};

// ---------------------------------------------------------------------
// STOCK — pantalla unica (depositos + alertas resumidas + tabla)
// ---------------------------------------------------------------------
async function viewStock(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">STOCK</h2>'));

  const selWarehouseWrap = el('<div class="view-toolbar" id="wh-tabs" style="margin-bottom:10px;"></div>');
  main.appendChild(selWarehouseWrap);

  const alertsWrap = el('<div class="kpi-grid" id="alerts-wrap" style="margin-bottom:10px;"></div>');
  main.appendChild(alertsWrap);

  const toolbar = el(`<div class="view-toolbar">
    <input type="text" id="f-search" placeholder="BUSCAR PRODUCTO...">
    <div id="status-chips" style="display:flex; gap:6px;"></div>
    <button class="btn btn-primary" id="btn-new-product" style="margin-left:auto;">+ NUEVO PRODUCTO</button>
  </div>`);
  main.appendChild(toolbar);

  const resultDiv = el('<div></div>');
  main.appendChild(resultDiv);

  let currentWarehouse = '';
  let currentStatus = pendingStockFilter || '';
  pendingStockFilter = null;

  const STATUS_FILTERS = [
    { value: '', label: 'TODOS' }, { value: 'DISPONIBLE', label: 'DISPONIBLES' },
    { value: 'STOCK_BAJO', label: 'STOCK BAJO' }, { value: 'SIN_STOCK', label: 'SIN STOCK' },
  ];

  function renderChips() {
    const chipsWrap = toolbar.querySelector('#status-chips');
    chipsWrap.innerHTML = '';
    STATUS_FILTERS.forEach((f) => {
      const btn = el(`<button type="button" class="btn btn-sm ${currentStatus === f.value ? 'btn-primary' : 'btn-outline'}">${f.label}</button>`);
      btn.addEventListener('click', () => { currentStatus = f.value; load(); });
      chipsWrap.appendChild(btn);
    });
  }

  async function load() {
    const params = new URLSearchParams();
    const search = toolbar.querySelector('#f-search').value;
    if (search) params.set('search', search);
    if (currentWarehouse) params.set('warehouseId', currentWarehouse);
    if (currentStatus) params.set('status', currentStatus);
    const data = await Api.get('/api/stock?' + params.toString());

    // tarjetas de deposito (clickeables)
    selWarehouseWrap.innerHTML = '';
    const allBtn = el(`<button type="button" class="btn btn-sm ${!currentWarehouse ? 'btn-primary' : 'btn-outline'}">TODOS</button>`);
    allBtn.addEventListener('click', () => { currentWarehouse = ''; load(); });
    selWarehouseWrap.appendChild(allBtn);
    data.warehouses.forEach((w) => {
      const btn = el(`<button type="button" class="btn btn-sm ${currentWarehouse === String(w.id) ? 'btn-primary' : 'btn-outline'}">${w.name} · ${fmtNum(w.total)}</button>`);
      btn.addEventListener('click', () => { currentWarehouse = String(w.id); load(); });
      selWarehouseWrap.appendChild(btn);
    });

    // tarjetas resumen de alerta
    alertsWrap.innerHTML = '';
    const alertCards = [
      ['🔴 SIN STOCK', data.alertCounts.SIN_STOCK, 'danger', 'SIN_STOCK'],
      ['🟡 STOCK BAJO', data.alertCounts.STOCK_BAJO, 'alert', 'STOCK_BAJO'],
    ];
    alertCards.forEach(([label, count, cls, filterValue]) => {
      const card = el(`<div class="kpi-card ${cls}" style="cursor:pointer;">
        <div class="kpi-label">${label}</div><div class="kpi-value">${count}</div>
        <div style="font-size:10.5px; color:var(--navy); font-weight:700; margin-top:4px;">VER PRODUCTOS →</div>
      </div>`);
      card.addEventListener('click', () => { currentStatus = filterValue; load(); });
      alertsWrap.appendChild(card);
    });

    renderChips();

    resultDiv.innerHTML = '';
    const columns = [
      { key: 'name', label: 'PRODUCTO' }, { key: 'presentation', label: 'PRESENTACIÓN' },
      ...data.warehouses.map((w) => ({ label: w.name, render: (r) => fmtNum(r.byWarehouse[w.id] || 0) })),
      { label: 'TOTAL', render: (r) => `<b>${fmtNum(r.total)}</b>` },
      { label: 'MÍNIMO', render: (r) => fmtNum(r.min_stock) },
      { label: 'ESTADO', render: (r) => `<span class="badge ${STATUS_BADGE[r.status]}">${STATUS_LABEL[r.status]}</span>` },
      { label: '', render: (r) => { const b = el('<button class="btn btn-outline btn-sm">EDITAR</button>'); b.addEventListener('click', () => editProduct(r)); return b; } },
    ];
    renderTable(resultDiv, { columns, rows: data.products, emptyText: 'SIN PRODUCTOS PARA MOSTRAR' });
  }
  toolbar.querySelector('#f-search').addEventListener('input', () => load());
  await load();

  function productFields(initial) {
    return [
      { name: 'internal_code', label: 'CÓDIGO INTERNO' }, { name: 'sku', label: 'SKU' },
      { name: 'name', label: 'NOMBRE DEL PRODUCTO', required: true, full: true },
      { name: 'active_ingredient', label: 'PRINCIPIO ACTIVO', full: true },
      { name: 'concentration', label: 'CONCENTRACIÓN' }, { name: 'presentation', label: 'PRESENTACIÓN' },
      { name: 'unit', label: 'UNIDAD', type: 'select', options: UNITS.map((u) => ({ value: u, label: u })), required: true },
      { name: 'category', label: 'CATEGORÍA' },
      { name: 'min_stock', label: 'STOCK MÍNIMO', type: 'number', step: '0.001' },
      { name: 'notes', label: 'OBSERVACIONES', type: 'textarea', full: true },
    ];
  }
  toolbar.querySelector('#btn-new-product').addEventListener('click', () => {
    openFormModal({
      title: 'NUEVO PRODUCTO', fields: productFields({}),
      onSubmit: async (data) => { await Api.post('/api/products', data); showToast('PRODUCTO CREADO', 'success'); await refreshLookups(); load(); }
    });
  });
  function editProduct(r) {
    openFormModal({
      title: 'EDITAR PRODUCTO', fields: productFields(r), initial: r,
      onSubmit: async (data) => { await Api.put('/api/products/' + r.id, { ...data, active: true }); showToast('PRODUCTO ACTUALIZADO', 'success'); await refreshLookups(); load(); }
    });
  }
}

// ---------------------------------------------------------------------
// MOVIMIENTOS — entrada / salida / transferencia / ajuste / conteo, todo aca
// ---------------------------------------------------------------------
async function viewMovements(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">MOVIMIENTOS</h2>'));

  const actionsBar = el(`<div class="view-toolbar">
    <button class="btn btn-green" id="btn-entrada">+ ENTRADA</button>
    <button class="btn btn-danger" id="btn-salida">− SALIDA</button>
    <button class="btn btn-primary" id="btn-transfer">⇄ TRANSFERENCIA</button>
    <button class="btn btn-outline" id="btn-ajuste">🔧 AJUSTE</button>
    <button class="btn btn-outline" id="btn-conteo">📋 CONTEO DE INVENTARIO</button>
  </div>`);
  main.appendChild(actionsBar);

  // ---- transferencias pendientes / en transito (necesitan una accion) ----
  const pendingWrap = el('<div id="pending-transfers"></div>');
  main.appendChild(pendingWrap);
  async function loadPendingTransfers() {
    const list = await Api.get('/api/transfers');
    const pending = list.filter((t) => t.status === 'PENDIENTE' || t.status === 'EN_TRANSITO');
    pendingWrap.innerHTML = '';
    if (!pending.length) return;
    pendingWrap.appendChild(el('<h3 style="margin:16px 0 8px;color:var(--navy);font-size:13px;">TRANSFERENCIAS QUE NECESITAN UNA ACCIÓN</h3>'));
    renderTable(pendingWrap, {
      columns: [
        { key: 'transfer_number', label: 'N°' },
        { label: 'ORIGEN → DESTINO', render: (r) => `${r.origin_name} → ${r.dest_name}` },
        { label: 'PRODUCTOS', render: (r) => (r.items || []).map((i) => `${i.product_name} (${fmtNum(i.quantity_sent)})`).join(', ') },
        { label: 'ESTADO', render: (r) => { const map = { PENDIENTE: 'badge-gray', EN_TRANSITO: 'badge-warn' }; return `<span class="badge ${map[r.status]}">${r.status.replace('_', ' ')}</span>`; } },
        { label: '', render: (r) => {
          const wrap = document.createElement('div');
          if (r.status === 'PENDIENTE') {
            const b1 = el('<button class="btn btn-green btn-sm">DESPACHAR</button>');
            b1.addEventListener('click', async () => { try { await Api.post(`/api/transfers/${r.id}/despachar`); showToast('TRANSFERENCIA DESPACHADA', 'success'); loadPendingTransfers(); loadHistory(); } catch (e) { showToast(apiErrorMessage(e), 'error'); } });
            const b2 = el('<button class="btn btn-outline btn-sm" style="margin-left:6px;">CANCELAR</button>');
            b2.addEventListener('click', async () => { try { await Api.post(`/api/transfers/${r.id}/cancelar`); showToast('TRANSFERENCIA CANCELADA', 'success'); loadPendingTransfers(); } catch (e) { showToast(apiErrorMessage(e), 'error'); } });
            wrap.appendChild(b1); wrap.appendChild(b2);
          } else {
            const b1 = el('<button class="btn btn-green btn-sm">CONFIRMAR RECEPCIÓN</button>');
            b1.addEventListener('click', () => confirmReceive(r));
            wrap.appendChild(b1);
          }
          return wrap;
        }},
      ], rows: pending, emptyText: ''
    });
  }

  function confirmReceive(r) {
    const root = document.getElementById('modal-root');
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el(`<div class="modal-box"><h3>CONFIRMAR RECEPCIÓN — ${r.transfer_number}</h3>
      <div class="form-field"><label>QUIÉN RECIBIÓ *</label><input type="text" id="received-by"></div></div>`);
    overlay.appendChild(box); root.innerHTML = ''; root.appendChild(overlay);

    box.appendChild(el('<h4 style="margin:14px 0 6px;font-size:12px;color:#6b7280;">CANTIDAD REAL RECIBIDA</h4>'));
    const table = el('<table class="items-table"><thead><tr><th>PRODUCTO</th><th>ENVIADO</th><th>RECIBIDO</th></tr></thead><tbody></tbody></table>');
    box.appendChild(table);
    (r.items || []).forEach((it) => {
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
        closeModal(); loadPendingTransfers(); loadHistory();
      } catch (err) { showToast(apiErrorMessage(err), 'error'); }
    });
  }

  // ---- historial unificado ----
  const filtersBar = el(`<div class="view-toolbar">
    <input type="text" id="f-search" placeholder="N° DE MOVIMIENTO...">
    <select id="f-type"><option value="">TODOS LOS TIPOS</option></select>
    <select id="f-warehouse"><option value="">TODOS LOS DEPÓSITOS</option></select>
    <input type="date" id="f-from"><input type="date" id="f-to">
    <button class="btn btn-outline btn-sm" id="btn-export">EXPORTAR</button>
  </div>`);
  const MOVEMENT_TYPES = ['ENTRADA', 'SALIDA', 'DEVOLUCION', 'AJUSTE_POSITIVO', 'AJUSTE_NEGATIVO', 'DANADA', 'VENCIDA', 'TRANSFERENCIA_SALIDA', 'TRANSFERENCIA_ENTRADA'];
  filtersBar.querySelector('#f-type').append(...MOVEMENT_TYPES.map((t) => el(`<option value="${t}">${t.replace('_', ' ')}</option>`)));
  filtersBar.querySelector('#f-warehouse').append(...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
  main.appendChild(el('<h3 style="margin:18px 0 8px;color:var(--navy);font-size:13px;">HISTORIAL</h3>'));
  main.appendChild(filtersBar);
  const listDiv = document.createElement('div'); main.appendChild(listDiv);

  async function loadHistory() {
    const params = new URLSearchParams();
    const s = filtersBar.querySelector('#f-search').value; if (s) params.set('search', s);
    const t = filtersBar.querySelector('#f-type').value; if (t) params.set('type', t);
    const w = filtersBar.querySelector('#f-warehouse').value; if (w) params.set('warehouseId', w);
    const from = filtersBar.querySelector('#f-from').value; if (from) params.set('dateFrom', from);
    const to = filtersBar.querySelector('#f-to').value; if (to) params.set('dateTo', to);
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
  filtersBar.querySelectorAll('input,select').forEach((i) => i.addEventListener('input', loadHistory));
  filtersBar.querySelector('#btn-export').addEventListener('click', () => {
    const params = new URLSearchParams();
    const from = filtersBar.querySelector('#f-from').value; if (from) params.set('dateFrom', from);
    const to = filtersBar.querySelector('#f-to').value; if (to) params.set('dateTo', to);
    const w = filtersBar.querySelector('#f-warehouse').value; if (w) params.set('warehouseId', w);
    const t = filtersBar.querySelector('#f-type').value; if (t) params.set('type', t);
    params.set('format', 'xlsx');
    window.open('/api/reports/movimientos?' + params.toString(), '_blank');
  });

  await Promise.all([loadPendingTransfers(), loadHistory()]);

  // ---- modal: nueva entrada ----
  actionsBar.querySelector('#btn-entrada').addEventListener('click', () => {
    const root = document.getElementById('modal-root');
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el('<div class="modal-box" style="max-width:720px;"><h3>REGISTRAR ENTRADA</h3></div>');
    overlay.appendChild(box); root.innerHTML = ''; root.appendChild(overlay);

    const form = el(`<form class="form-grid">
      <div class="form-field"><label>DEPÓSITO DE INGRESO *</label><select name="warehouse_id" required></select></div>
      <div class="form-field"><label>FECHA</label><input type="date" name="movement_date"></div>
      <div class="form-field"><label>QUIÉN ENTREGÓ</label><input type="text" name="delivered_by"></div>
      <div class="form-field"><label>QUIÉN RECIBIÓ</label><input type="text" name="received_by"></div>
      <div class="form-field"><label>N° DE REMISIÓN / FACTURA</label><input type="text" name="document_number"></div>
      <div class="form-field full"><label>OBSERVACIONES</label><textarea name="notes"></textarea></div>
    </form>`);
    form.querySelector('[name=warehouse_id]').append(...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
    box.appendChild(form);
    box.appendChild(el('<h4 style="margin:14px 0 6px;font-size:12px;color:#6b7280;">PRODUCTOS RECIBIDOS</h4>'));
    const itemsHost = document.createElement('div'); box.appendChild(itemsHost);
    const itemsEditor = buildItemsEditor(itemsHost, { withExpiry: true });

    const actions = el('<div class="modal-actions"><button type="button" class="btn btn-outline">CANCELAR</button><button type="button" class="btn btn-green">CONFIRMAR ENTRADA</button></div>');
    box.appendChild(actions);
    actions.querySelectorAll('button')[0].addEventListener('click', closeModal);
    actions.querySelectorAll('button')[1].addEventListener('click', async () => {
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
        closeModal(); await refreshLookups(); loadHistory();
      } catch (err) { showToast(apiErrorMessage(err), 'error'); }
    });
  });

  // ---- modal: nueva salida ----
  actionsBar.querySelector('#btn-salida').addEventListener('click', () => {
    const root = document.getElementById('modal-root');
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el('<div class="modal-box" style="max-width:720px;"><h3>REGISTRAR SALIDA</h3></div>');
    overlay.appendChild(box); root.innerHTML = ''; root.appendChild(overlay);

    const form = el(`<form class="form-grid">
      <div class="form-field"><label>DEPÓSITO *</label><select name="warehouse_id" required></select></div>
      <div class="form-field"><label>FECHA</label><input type="date" name="movement_date"></div>
      <div class="form-field"><label>QUIÉN RETIRA</label><input type="text" name="picked_up_by"></div>
      <div class="form-field"><label>QUIÉN ENTREGA</label><input type="text" name="delivered_by"></div>
      <div class="form-field"><label>MOTIVO DE LA SALIDA *</label><select name="reason" required></select></div>
      <div class="form-field"><label>N° DE PEDIDO / FACTURA</label><input type="text" name="document_number"></div>
      <div class="form-field full"><label>OBSERVACIONES</label><textarea name="notes"></textarea></div>
    </form>`);
    form.querySelector('[name=warehouse_id]').append(...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
    form.querySelector('[name=reason]').append(el('<option value="">—</option>'), ...SALIDA_REASONS.map((r) => el(`<option value="${r}">${r}</option>`)));
    box.appendChild(form);

    const destField = buildQuickSelect({
      label: 'DESTINO / CLIENTE / ESTANCIA', options: destinationOptions(),
      onCreateNew: (select) => openFormModal({
        title: 'NUEVO DESTINO', fields: [
          { name: 'name', label: 'NOMBRE', required: true, full: true },
          { name: 'type', label: 'TIPO', type: 'select', required: true, options: DEST_TYPES.map((t) => ({ value: t, label: t })) },
        ],
        onSubmit: async (data) => {
          const d = await Api.post('/api/destinations', data);
          await refreshLookups();
          select.appendChild(el(`<option value="${d.id}" selected>${d.name} (${d.type})</option>`));
          showToast('DESTINO CREADO', 'success');
        }
      })
    });
    box.appendChild(destField.wrap);

    box.appendChild(el('<h4 style="margin:14px 0 6px;font-size:12px;color:#6b7280;">PRODUCTOS A RETIRAR</h4>'));
    const itemsHost = document.createElement('div'); box.appendChild(itemsHost);
    const itemsEditor = buildItemsEditor(itemsHost, { withExpiry: false });

    const actions = el('<div class="modal-actions"><button type="button" class="btn btn-outline">CANCELAR</button><button type="button" class="btn btn-danger">CONFIRMAR SALIDA</button></div>');
    box.appendChild(actions);
    actions.querySelectorAll('button')[0].addEventListener('click', closeModal);
    actions.querySelectorAll('button')[1].addEventListener('click', async () => {
      const fd = new FormData(form);
      const items = itemsEditor.getItems();
      if (!items.length) return showToast('AGREGUE AL MENOS UN PRODUCTO', 'error');
      if (!fd.get('reason')) return showToast('INDIQUE EL MOTIVO DE LA SALIDA', 'error');
      try {
        await Api.post('/api/movements/salida', {
          warehouse_id: fd.get('warehouse_id'), movement_date: fd.get('movement_date') || undefined,
          picked_up_by: fd.get('picked_up_by'), delivered_by: fd.get('delivered_by'),
          destination_id: destField.select.value || undefined, reason: fd.get('reason'),
          document_number: fd.get('document_number'), notes: fd.get('notes'), items,
        });
        showToast('SALIDA REGISTRADA CORRECTAMENTE', 'success');
        closeModal(); await refreshLookups(); loadHistory();
      } catch (err) { showToast(apiErrorMessage(err), 'error'); }
    });
  });

  // ---- modal: nueva transferencia ----
  actionsBar.querySelector('#btn-transfer').addEventListener('click', () => {
    const root = document.getElementById('modal-root');
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el('<div class="modal-box" style="max-width:720px;"><h3>NUEVA TRANSFERENCIA</h3></div>');
    overlay.appendChild(box); root.innerHTML = ''; root.appendChild(overlay);

    const form = el(`<form class="form-grid">
      <div class="form-field"><label>DEPÓSITO ORIGEN *</label><select name="warehouse_origin_id" required></select></div>
      <div class="form-field"><label>DEPÓSITO DESTINO *</label><select name="warehouse_destination_id" required></select></div>
      <div class="form-field"><label>QUIÉN RETIRA</label><input type="text" name="picked_up_by"></div>
      <div class="form-field"><label>TRANSPORTISTA</label><input type="text" name="carrier"></div>
      <div class="form-field"><label>VEHÍCULO</label><input type="text" name="vehicle"></div>
      <div class="form-field"><label>FECHA DE SALIDA</label><input type="date" name="ship_date"></div>
      <div class="form-field full"><label>OBSERVACIONES</label><textarea name="notes"></textarea></div>
    </form>`);
    form.querySelector('[name=warehouse_origin_id]').append(el('<option value="">—</option>'), ...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
    form.querySelector('[name=warehouse_destination_id]').append(el('<option value="">—</option>'), ...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
    box.appendChild(form);

    box.appendChild(el('<h4 style="margin:14px 0 6px;font-size:12px;color:#6b7280;">PRODUCTOS A TRANSFERIR</h4>'));
    const itemsHost = document.createElement('div'); box.appendChild(itemsHost);
    const itemsEditor = buildItemsEditor(itemsHost, { withExpiry: false });

    const actions = el('<div class="modal-actions"><button type="button" class="btn btn-outline">CANCELAR</button><button type="button" class="btn btn-primary">CREAR TRANSFERENCIA</button></div>');
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
          picked_up_by: fd.get('picked_up_by'), carrier: fd.get('carrier'), vehicle: fd.get('vehicle'),
          ship_date: fd.get('ship_date') || undefined, notes: fd.get('notes'), items,
        });
        showToast('TRANSFERENCIA CREADA (PENDIENTE DE DESPACHO)', 'success');
        closeModal(); loadPendingTransfers();
      } catch (err) { showToast(apiErrorMessage(err), 'error'); }
    });
  });

  // ---- modal: ajuste / devolucion / danada / vencida ----
  actionsBar.querySelector('#btn-ajuste').addEventListener('click', () => {
    const root = document.getElementById('modal-root');
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el('<div class="modal-box"><h3>AJUSTE DE STOCK</h3></div>');
    overlay.appendChild(box); root.innerHTML = ''; root.appendChild(overlay);

    const form = el(`<form class="form-grid">
      <div class="form-field full"><label>TIPO *</label><select name="type" required></select></div>
      <div class="form-field"><label>DEPÓSITO *</label><select name="warehouse_id" required></select></div>
      <div class="form-field"><label>PRODUCTO *</label><select name="product_id" required></select></div>
      <div class="form-field"><label>LOTE (OPCIONAL)</label><input type="text" name="lot_code"></div>
      <div class="form-field"><label>CANTIDAD *</label><input type="number" step="0.001" name="quantity" required></div>
      <div class="form-field full"><label>MOTIVO *</label><input type="text" name="reason" required></div>
      <div class="form-field full"><label>OBSERVACIONES</label><textarea name="notes"></textarea></div>
    </form>`);
    form.querySelector('[name=type]').append(...ADJUST_TYPES.map((t) => el(`<option value="${t.value}">${t.label}</option>`)));
    form.querySelector('[name=warehouse_id]').append(el('<option value="">—</option>'), ...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
    form.querySelector('[name=product_id]').append(el('<option value="">—</option>'), ...productOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));
    box.appendChild(form);

    const actions = el('<div class="modal-actions"><button type="button" class="btn btn-outline">CANCELAR</button><button type="button" class="btn btn-primary">CONFIRMAR AJUSTE</button></div>');
    box.appendChild(actions);
    actions.querySelectorAll('button')[0].addEventListener('click', closeModal);
    actions.querySelectorAll('button')[1].addEventListener('click', async () => {
      const fd = new FormData(form);
      try {
        await Api.post('/api/movements/ajuste', {
          type: fd.get('type'), warehouse_id: fd.get('warehouse_id'), product_id: fd.get('product_id'),
          lot_code: fd.get('lot_code') || undefined, quantity: fd.get('quantity'), reason: fd.get('reason'), notes: fd.get('notes'),
        });
        showToast('AJUSTE REGISTRADO', 'success');
        closeModal(); loadHistory();
      } catch (err) { showToast(apiErrorMessage(err), 'error'); }
    });
  });

  // ---- modal: conteo de inventario ----
  actionsBar.querySelector('#btn-conteo').addEventListener('click', () => {
    const root = document.getElementById('modal-root');
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el(`<div class="modal-box"><h3>INICIAR CONTEO DE INVENTARIO</h3>
      <div class="form-field"><label>DEPÓSITO *</label><select id="conteo-wh"></select></div></div>`);
    overlay.appendChild(box); root.innerHTML = ''; root.appendChild(overlay);
    box.querySelector('#conteo-wh').append(el('<option value="">—</option>'), ...warehouseOptions().map((o) => el(`<option value="${o.value}">${o.label}</option>`)));

    const actions = el('<div class="modal-actions"><button type="button" class="btn btn-outline">CANCELAR</button><button type="button" class="btn btn-primary">INICIAR CONTEO</button></div>');
    box.appendChild(actions);
    actions.querySelectorAll('button')[0].addEventListener('click', closeModal);
    actions.querySelectorAll('button')[1].addEventListener('click', async () => {
      const warehouseId = box.querySelector('#conteo-wh').value;
      if (!warehouseId) return showToast('SELECCIONE UN DEPÓSITO', 'error');
      try {
        const count = await Api.post('/api/inventory-counts', { warehouse_id: warehouseId });
        openCountEditor(count.id);
      } catch (err) { showToast(apiErrorMessage(err), 'error'); }
    });
  });

  async function openCountEditor(countId) {
    const detail = await Api.get('/api/inventory-counts/' + countId);
    const root = document.getElementById('modal-root');
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el(`<div class="modal-box" style="max-width:760px;"><h3>${detail.count_number} — ${detail.warehouse_name}</h3></div>`);
    overlay.appendChild(box); root.innerHTML = ''; root.appendChild(overlay);

    const table = el('<table class="items-table"><thead><tr><th>PRODUCTO</th><th>LOTE</th><th>STOCK SISTEMA</th><th>CANTIDAD FÍSICA</th></tr></thead><tbody></tbody></table>');
    detail.items.forEach((it) => {
      const tr = el(`<tr>
        <td>${it.product_name}</td><td>${it.lot_code || '-'}</td><td>${fmtNum(it.system_qty)}</td>
        <td><input type="number" step="0.001" value="${it.system_qty}" data-item-id="${it.id}" style="width:100px;"></td>
      </tr>`);
      table.querySelector('tbody').appendChild(tr);
    });
    box.appendChild(table);
    if (!detail.items.length) box.appendChild(el('<p class="empty-state">ESTE DEPÓSITO NO TIENE STOCK CARGADO PARA CONTAR.</p>'));

    const actions = el('<div class="modal-actions"><button type="button" class="btn btn-outline">CERRAR VENTANA</button><button type="button" class="btn btn-primary">CERRAR CONTEO Y GENERAR AJUSTES</button></div>');
    box.appendChild(actions);
    actions.querySelectorAll('button')[0].addEventListener('click', closeModal);
    actions.querySelectorAll('button')[1].addEventListener('click', async () => {
      const inputs = Array.from(table.querySelectorAll('input[data-item-id]'));
      try {
        await Api.post(`/api/inventory-counts/${countId}/cerrar`, {
          items: inputs.map((i) => ({ item_id: i.dataset.itemId, physical_qty: i.value }))
        });
        showToast('CONTEO CERRADO. SE GENERARON LOS AJUSTES NECESARIOS.', 'success');
        closeModal(); loadHistory();
      } catch (err) { showToast(apiErrorMessage(err), 'error'); }
    });
  }
}

// ---------------------------------------------------------------------
// CONFIGURACIÓN — productos / depositos / responsables / destinos, con tabs
// ---------------------------------------------------------------------
async function viewConfig(main) {
  main.innerHTML = '';
  main.appendChild(el('<h2 class="view-title">CONFIGURACIÓN</h2>'));

  const tabsBar = el(`<div class="view-toolbar">
    <button type="button" class="btn btn-primary btn-sm" data-tab="productos">PRODUCTOS</button>
    <button type="button" class="btn btn-outline btn-sm" data-tab="depositos">DEPÓSITOS</button>
    <button type="button" class="btn btn-outline btn-sm" data-tab="responsables">RESPONSABLES</button>
    <button type="button" class="btn btn-outline btn-sm" data-tab="destinos">DESTINOS</button>
  </div>`);
  main.appendChild(tabsBar);
  const content = document.createElement('div');
  main.appendChild(content);

  function setActiveTab(tab) {
    tabsBar.querySelectorAll('button').forEach((b) => b.className = 'btn btn-sm ' + (b.dataset.tab === tab ? 'btn-primary' : 'btn-outline'));
  }
  tabsBar.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { setActiveTab(b.dataset.tab); renderTab(b.dataset.tab); }));

  async function renderTab(tab) {
    content.innerHTML = '<div class="empty-state">CARGANDO…</div>';
    if (tab === 'productos') return renderProductsTab();
    if (tab === 'depositos') return renderWarehousesTab();
    if (tab === 'responsables') return renderResponsiblesTab();
    if (tab === 'destinos') return renderDestinationsTab();
  }

  async function renderProductsTab() {
    content.innerHTML = '';
    const toolbar = el(`<div class="view-toolbar"><input type="text" id="f-search" placeholder="BUSCAR..."><button class="btn btn-primary" id="btn-new">+ NUEVO PRODUCTO</button></div>`);
    content.appendChild(toolbar);
    const listDiv = document.createElement('div'); content.appendChild(listDiv);

    async function load() {
      const search = toolbar.querySelector('#f-search').value;
      const params = new URLSearchParams(); if (search) params.set('search', search);
      const products = await Api.get('/api/products?' + params.toString());
      listDiv.innerHTML = '';
      renderTable(listDiv, {
        columns: [
          { key: 'internal_code', label: 'CÓDIGO' }, { key: 'name', label: 'NOMBRE' },
          { key: 'category', label: 'CATEGORÍA' }, { key: 'presentation', label: 'PRESENTACIÓN' },
          { key: 'unit', label: 'UNIDAD' }, { label: 'MÍNIMO', render: (r) => fmtNum(r.min_stock) },
          { label: 'ESTADO', render: (r) => r.active ? '<span class="badge badge-ok">ACTIVO</span>' : '<span class="badge badge-gray">INACTIVO</span>' },
          { label: '', render: (r) => { const b = el('<button class="btn btn-outline btn-sm">EDITAR</button>'); b.addEventListener('click', () => edit(r)); return b; } },
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
        { name: 'notes', label: 'OBSERVACIONES', type: 'textarea', full: true },
      ];
    }
    toolbar.querySelector('#btn-new').addEventListener('click', () => {
      openFormModal({ title: 'NUEVO PRODUCTO', fields: fieldsFor(),
        onSubmit: async (data) => { await Api.post('/api/products', data); showToast('PRODUCTO CREADO', 'success'); await refreshLookups(); load(); } });
    });
    function edit(r) {
      openFormModal({ title: 'EDITAR PRODUCTO', fields: fieldsFor(), initial: r,
        onSubmit: async (data) => { await Api.put('/api/products/' + r.id, { ...data, active: r.active }); showToast('PRODUCTO ACTUALIZADO', 'success'); await refreshLookups(); load(); } });
    }
  }

  async function renderWarehousesTab() {
    content.innerHTML = '';
    const toolbar = el('<div class="view-toolbar"><button class="btn btn-primary" id="btn-new">+ NUEVO DEPÓSITO</button></div>');
    content.appendChild(toolbar);
    const listDiv = document.createElement('div'); content.appendChild(listDiv);

    const warehouses = await Api.get('/api/warehouses');
    renderTable(listDiv, {
      columns: [
        { key: 'name', label: 'NOMBRE' }, { key: 'location', label: 'UBICACIÓN' },
        { key: 'responsible_name', label: 'RESPONSABLE' }, { key: 'phone', label: 'TELÉFONO' },
        { label: 'STOCK TOTAL', render: (r) => fmtNum(r.total_quantity) },
        { label: 'ESTADO', render: (r) => r.active ? '<span class="badge badge-ok">ACTIVO</span>' : '<span class="badge badge-gray">INACTIVO</span>' },
        { label: '', render: (r) => { const b = el('<button class="btn btn-outline btn-sm">EDITAR</button>'); b.addEventListener('click', () => edit(r)); return b; } },
      ], rows: warehouses, emptyText: 'SIN DEPÓSITOS REGISTRADOS'
    });

    function fieldsFor() {
      return [
        { name: 'name', label: 'NOMBRE', required: true, full: true },
        { name: 'location', label: 'UBICACIÓN', full: true },
        { name: 'responsible_name', label: 'RESPONSABLE' }, { name: 'phone', label: 'TELÉFONO' },
        { name: 'notes', label: 'OBSERVACIONES', type: 'textarea', full: true },
      ];
    }
    toolbar.querySelector('#btn-new').addEventListener('click', () => {
      openFormModal({ title: 'NUEVO DEPÓSITO', fields: fieldsFor(),
        onSubmit: async (data) => { await Api.post('/api/warehouses', data); showToast('DEPÓSITO CREADO', 'success'); await refreshLookups(); renderWarehousesTab(); } });
    });
    function edit(r) {
      openFormModal({ title: 'EDITAR DEPÓSITO', fields: fieldsFor(), initial: r,
        onSubmit: async (data) => { await Api.put('/api/warehouses/' + r.id, { ...data, active: r.active }); showToast('DEPÓSITO ACTUALIZADO', 'success'); await refreshLookups(); renderWarehousesTab(); } });
    }
  }

  async function renderResponsiblesTab() {
    content.innerHTML = '';
    const toolbar = el('<div class="view-toolbar"><button class="btn btn-primary" id="btn-new">+ NUEVO RESPONSABLE</button></div>');
    content.appendChild(toolbar);
    const listDiv = document.createElement('div'); content.appendChild(listDiv);

    const rows = await Api.get('/api/responsibles');
    renderTable(listDiv, {
      columns: [
        { label: 'NOMBRE', render: (r) => `${r.first_name} ${r.last_name || ''}` }, { key: 'company', label: 'EMPRESA' },
        { key: 'position', label: 'CARGO' }, { key: 'phone', label: 'TELÉFONO' },
        { key: 'warehouse_name', label: 'DEPÓSITO ASIGNADO' },
        { label: 'ESTADO', render: (r) => r.active ? '<span class="badge badge-ok">ACTIVO</span>' : '<span class="badge badge-gray">INACTIVO</span>' },
        { label: '', render: (r) => { const b = el('<button class="btn btn-outline btn-sm">EDITAR</button>'); b.addEventListener('click', () => edit(r)); return b; } },
      ], rows, emptyText: 'SIN RESPONSABLES REGISTRADOS'
    });

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
        onSubmit: async (data) => { await Api.post('/api/responsibles', data); showToast('RESPONSABLE CREADO', 'success'); await refreshLookups(); renderResponsiblesTab(); } });
    });
    function edit(r) {
      openFormModal({ title: 'EDITAR RESPONSABLE', fields: fieldsFor(), initial: r,
        onSubmit: async (data) => { await Api.put('/api/responsibles/' + r.id, { ...data, active: r.active }); showToast('RESPONSABLE ACTUALIZADO', 'success'); await refreshLookups(); renderResponsiblesTab(); } });
    }
  }

  async function renderDestinationsTab() {
    content.innerHTML = '';
    const toolbar = el('<div class="view-toolbar"><button class="btn btn-primary" id="btn-new">+ NUEVO DESTINO</button></div>');
    content.appendChild(toolbar);
    const listDiv = document.createElement('div'); content.appendChild(listDiv);

    const rows = await Api.get('/api/destinations');
    renderTable(listDiv, {
      columns: [
        { key: 'name', label: 'NOMBRE' }, { key: 'type', label: 'TIPO' }, { key: 'notes', label: 'OBSERVACIONES' },
        { label: 'ESTADO', render: (r) => r.active ? '<span class="badge badge-ok">ACTIVO</span>' : '<span class="badge badge-gray">INACTIVO</span>' },
        { label: '', render: (r) => { const b = el('<button class="btn btn-outline btn-sm">EDITAR</button>'); b.addEventListener('click', () => edit(r)); return b; } },
      ], rows, emptyText: 'SIN DESTINOS REGISTRADOS'
    });

    function fieldsFor() {
      return [
        { name: 'name', label: 'NOMBRE', required: true, full: true },
        { name: 'type', label: 'TIPO', type: 'select', required: true, options: DEST_TYPES.map((t) => ({ value: t, label: t })) },
        { name: 'notes', label: 'OBSERVACIONES', type: 'textarea', full: true },
      ];
    }
    toolbar.querySelector('#btn-new').addEventListener('click', () => {
      openFormModal({ title: 'NUEVO DESTINO', fields: fieldsFor(),
        onSubmit: async (data) => { await Api.post('/api/destinations', data); showToast('DESTINO CREADO', 'success'); await refreshLookups(); renderDestinationsTab(); } });
    });
    function edit(r) {
      openFormModal({ title: 'EDITAR DESTINO', fields: fieldsFor(), initial: r,
        onSubmit: async (data) => { await Api.put('/api/destinations/' + r.id, { ...data, active: r.active }); showToast('DESTINO ACTUALIZADO', 'success'); await refreshLookups(); renderDestinationsTab(); } });
    }
  }

  await renderProductsTab();
}

// ---------------------------------------------------------------------
// ARRANQUE
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', initAuth);
