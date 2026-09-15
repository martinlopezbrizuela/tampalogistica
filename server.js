// ======================================================================
// AGROFORCE + TAMPA — CONTROL DE STOCK — LÍNEA DE PASTURAS
// Un solo archivo de backend (server.js) para que sea fácil de subir
// desde el editor web de GitHub. Incluye: servidor, sesiones, TODAS
// las rutas de la API, y la creación automática de la base de datos
// (no hace falta correr nada aparte: al arrancar, crea las tablas y
// carga los 4 depósitos iniciales si todavía no existen).
// ======================================================================
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false } : undefined
});
pool.on('error', (err) => console.error('ERROR INESPERADO EN EL POOL DE POSTGRES', err));

// Ejecuta una funcion dentro de una transaccion (BEGIN/COMMIT/ROLLBACK),
// para que dos personas cargando movimientos al mismo tiempo no dejen
// el stock inconsistente.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// NUMERACION AUTOMATICA DE COMPROBANTES (ENT-2026-000001, SAL-2026-000001...)
// ---------------------------------------------------------------------
const PREFIXES = {
  ENTRADA: 'ENT', SALIDA: 'SAL', DEVOLUCION: 'DEV', AJUSTE_POSITIVO: 'AJU',
  AJUSTE_NEGATIVO: 'AJU', DANADA: 'BAJ', VENCIDA: 'BAJ', TRANSFERENCIA: 'TRA', INVENTARIO: 'INV'
};
async function nextNumber(client, typeKey) {
  const prefix = PREFIXES[typeKey] || 'MOV';
  const year = new Date().getFullYear();
  const counterName = `${prefix}_${year}`;
  const res = await client.query(
    `INSERT INTO counters (name, year, last_value) VALUES ($1, $2, 1)
     ON CONFLICT (name) DO UPDATE SET last_value = counters.last_value + 1
     RETURNING last_value`, [counterName, year]);
  return `${prefix}-${year}-${String(res.rows[0].last_value).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------
// AUDITORIA
// ---------------------------------------------------------------------
async function logAudit(client, { table, recordId, action, oldData, newData, userName, reason }) {
  await client.query(
    `INSERT INTO audit_log (table_name, record_id, action, old_data, new_data, user_name, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [table, recordId || null, action, oldData ? JSON.stringify(oldData) : null,
     newData ? JSON.stringify(newData) : null, userName || null, reason || null]);
}

// ---------------------------------------------------------------------
// AJUSTE SEGURO DE STOCK (con bloqueo de fila, no permite quedar negativo)
// ---------------------------------------------------------------------
async function adjustStock(client, { productId, lotId, warehouseId, delta }) {
  const existing = await client.query(
    `SELECT id, quantity FROM stock
     WHERE product_id=$1 AND warehouse_id=$2 AND (lot_id IS NOT DISTINCT FROM $3)
     FOR UPDATE`, [productId, warehouseId, lotId || null]);
  let currentQty = 0, rowId = null;
  if (existing.rows.length) { currentQty = parseFloat(existing.rows[0].quantity); rowId = existing.rows[0].id; }
  const newQty = currentQty + delta;
  if (newQty < 0) {
    const err = new Error('STOCK_INSUFICIENTE'); err.code = 'STOCK_INSUFICIENTE';
    err.details = { productId, warehouseId, lotId, currentQty, requested: -delta };
    throw err;
  }
  if (rowId) {
    await client.query(`UPDATE stock SET quantity=$1, updated_at=NOW() WHERE id=$2`, [newQty, rowId]);
  } else {
    await client.query(`INSERT INTO stock (product_id, lot_id, warehouse_id, quantity) VALUES ($1,$2,$3,$4)`,
      [productId, lotId || null, warehouseId, newQty]);
  }
  return newQty;
}

async function findOrCreateLot(client, productId, lotCode, expiryDate) {
  if (!lotCode) return null;
  const found = await client.query(`SELECT id FROM product_lots WHERE product_id=$1 AND lot_code=$2`, [productId, lotCode]);
  if (found.rows.length) return found.rows[0].id;
  const created = await client.query(
    `INSERT INTO product_lots (product_id, lot_code, expiry_date) VALUES ($1,$2,$3) RETURNING id`,
    [productId, lotCode, expiryDate || null]);
  return created.rows[0].id;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: 'NO_AUTENTICADO' });
}

const SCHEMA_SQL = `
-- ============================================================
-- AGROFORCE + TAMPA - CONTROL DE STOCK LINEA DE PASTURAS
-- Esquema PostgreSQL
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash TEXT,
  full_name VARCHAR(200),
  role VARCHAR(50) DEFAULT 'OPERADOR',
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS warehouses (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  location VARCHAR(255),
  responsible_name VARCHAR(150),
  phone VARCHAR(50),
  notes TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  internal_code VARCHAR(50) UNIQUE,
  sku VARCHAR(100),
  name VARCHAR(200) NOT NULL,
  active_ingredient VARCHAR(255),
  concentration VARCHAR(100),
  presentation VARCHAR(150),
  unit VARCHAR(20) NOT NULL DEFAULT 'UNIDAD',
  category VARCHAR(100),
  description TEXT,
  min_stock NUMERIC(14,3) DEFAULT 0,
  notes TEXT,
  photo_url TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_lots (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_code VARCHAR(100) NOT NULL,
  expiry_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(product_id, lot_code)
);

CREATE TABLE IF NOT EXISTS stock (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES product_lots(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(product_id, lot_id, warehouse_id)
);

CREATE TABLE IF NOT EXISTS responsibles (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100),
  company VARCHAR(150),
  position VARCHAR(100),
  phone VARCHAR(50),
  email VARCHAR(150),
  warehouse_id INTEGER REFERENCES warehouses(id),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS destinations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  type VARCHAR(30) NOT NULL,
  notes TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS counters (
  name VARCHAR(30) PRIMARY KEY,
  year INTEGER NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id SERIAL PRIMARY KEY,
  movement_number VARCHAR(30) UNIQUE NOT NULL,
  type VARCHAR(30) NOT NULL,
  movement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  warehouse_origin_id INTEGER REFERENCES warehouses(id),
  warehouse_destination_id INTEGER REFERENCES warehouses(id),
  responsible_id INTEGER REFERENCES responsibles(id),
  delivered_by VARCHAR(150),
  received_by VARCHAR(150),
  destination_id INTEGER REFERENCES destinations(id),
  reason VARCHAR(150),
  document_number VARCHAR(100),
  notes TEXT,
  transfer_id INTEGER,
  created_by VARCHAR(150),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_movement_items (
  id SERIAL PRIMARY KEY,
  movement_id INTEGER NOT NULL REFERENCES stock_movements(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES product_lots(id),
  quantity NUMERIC(14,3) NOT NULL,
  unit VARCHAR(20)
);

CREATE TABLE IF NOT EXISTS transfers (
  id SERIAL PRIMARY KEY,
  transfer_number VARCHAR(30) UNIQUE NOT NULL,
  warehouse_origin_id INTEGER NOT NULL REFERENCES warehouses(id),
  warehouse_destination_id INTEGER NOT NULL REFERENCES warehouses(id),
  prepared_by_id INTEGER REFERENCES responsibles(id),
  picked_up_by VARCHAR(150),
  carrier VARCHAR(150),
  vehicle VARCHAR(100),
  ship_date DATE,
  eta_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
  notes TEXT,
  received_by VARCHAR(150),
  received_at TIMESTAMPTZ,
  created_by VARCHAR(150),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfer_items (
  id SERIAL PRIMARY KEY,
  transfer_id INTEGER NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES product_lots(id),
  quantity_sent NUMERIC(14,3) NOT NULL,
  quantity_received NUMERIC(14,3),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS inventory_counts (
  id SERIAL PRIMARY KEY,
  count_number VARCHAR(30) UNIQUE NOT NULL,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  count_date DATE NOT NULL DEFAULT CURRENT_DATE,
  responsible_id INTEGER REFERENCES responsibles(id),
  status VARCHAR(20) NOT NULL DEFAULT 'ABIERTO',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_count_items (
  id SERIAL PRIMARY KEY,
  count_id INTEGER NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES product_lots(id),
  system_qty NUMERIC(14,3) NOT NULL,
  physical_qty NUMERIC(14,3),
  difference NUMERIC(14,3),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(60) NOT NULL,
  record_id INTEGER,
  action VARCHAR(30) NOT NULL,
  old_data JSONB,
  new_data JSONB,
  user_name VARCHAR(150),
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS configuration (
  key VARCHAR(80) PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_stock_warehouse ON stock(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_product ON stock(product_id);
CREATE INDEX IF NOT EXISTS idx_movements_date ON stock_movements(movement_date);
CREATE INDEX IF NOT EXISTS idx_movements_type ON stock_movements(type);
CREATE INDEX IF NOT EXISTS idx_movement_items_product ON stock_movement_items(product_id);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);
CREATE INDEX IF NOT EXISTS idx_lots_product ON product_lots(product_id);

`;

const SEED_SQL = `
-- Depositos iniciales (arrancan en 0, sin inventar stock)
INSERT INTO warehouses (name, location, active)
SELECT 'CIUDAD DEL ESTE', 'CIUDAD DEL ESTE, PARAGUAY', TRUE
WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE name = 'CIUDAD DEL ESTE');

INSERT INTO warehouses (name, location, active)
SELECT 'ASUNCION', 'ASUNCION, PARAGUAY', TRUE
WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE name = 'ASUNCION');

INSERT INTO warehouses (name, location, active)
SELECT 'YPACARAI', 'YPACARAI, PARAGUAY', TRUE
WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE name = 'YPACARAI');

INSERT INTO warehouses (name, location, active)
SELECT 'FILADELFIA', 'FILADELFIA, CHACO, PARAGUAY', TRUE
WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE name = 'FILADELFIA');

-- Configuracion inicial
INSERT INTO configuration (key, value) VALUES ('expiry_alert_days', '60')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO configuration (key, value) VALUES ('company_name', 'AGROFORCE + TAMPA')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO configuration (key, value) VALUES ('timezone', 'America/Asuncion')
  ON CONFLICT (key) DO NOTHING;

`;
const authRouter = express.Router();
authRouter.post('/login', async (req, res) => {
  const { password, responsibleId } = req.body || {};
  if (!password || password !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'CONTRASENA_INCORRECTA' });
  }
  req.session.authenticated = true;

  let actingAsName = null;
  if (responsibleId) {
    const r = await pool.query(
      `SELECT first_name, last_name FROM responsibles WHERE id=$1 AND active=TRUE`,
      [responsibleId]
    );
    if (r.rows.length) {
      actingAsName = `${r.rows[0].first_name} ${r.rows[0].last_name || ''}`.trim();
    }
  }
  req.session.actingAsId = responsibleId || null;
  req.session.actingAsName = actingAsName;

  res.json({ ok: true, actingAsName });
});

authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

authRouter.get('/session', (req, res) => {
  res.json({
    authenticated: !!(req.session && req.session.authenticated),
    actingAsName: req.session ? req.session.actingAsName : null
  });
});


const dashboardRouter = express.Router();
dashboardRouter.get('/', async (req, res, next) => {
  try {
    const [
      totalStock,
      byWarehouse,
      lowStock,
      noStock,
      movementsToday,
      inMonth,
      outMonth,
      pendingTransfers,
      expiringSoon,
      recentMovements,
      topMoved,
      inTransit
    ] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(quantity),0) AS total FROM stock`),
      pool.query(`
        SELECT w.id, w.name, COALESCE(SUM(s.quantity),0) AS total
        FROM warehouses w
        LEFT JOIN stock s ON s.warehouse_id = w.id
        WHERE w.active = TRUE
        GROUP BY w.id, w.name ORDER BY w.name`),
      pool.query(`
        SELECT p.id, p.name, p.min_stock, COALESCE(SUM(s.quantity),0) AS total
        FROM products p
        LEFT JOIN stock s ON s.product_id = p.id
        WHERE p.active = TRUE
        GROUP BY p.id, p.name, p.min_stock
        HAVING COALESCE(SUM(s.quantity),0) > 0 AND COALESCE(SUM(s.quantity),0) <= p.min_stock`),
      pool.query(`
        SELECT p.id, p.name
        FROM products p
        LEFT JOIN stock s ON s.product_id = p.id
        WHERE p.active = TRUE
        GROUP BY p.id, p.name
        HAVING COALESCE(SUM(s.quantity),0) <= 0`),
      pool.query(`SELECT COUNT(*) AS c FROM stock_movements WHERE movement_date = CURRENT_DATE`),
      pool.query(`SELECT COUNT(*) AS c FROM stock_movements WHERE type='ENTRADA' AND date_trunc('month', movement_date) = date_trunc('month', CURRENT_DATE)`),
      pool.query(`SELECT COUNT(*) AS c FROM stock_movements WHERE type='SALIDA' AND date_trunc('month', movement_date) = date_trunc('month', CURRENT_DATE)`),
      pool.query(`SELECT COUNT(*) AS c FROM transfers WHERE status IN ('PENDIENTE','DESPACHADA','EN_TRANSITO')`),
      pool.query(`
        SELECT DISTINCT p.id, p.name, pl.lot_code, pl.expiry_date
        FROM product_lots pl
        JOIN products p ON p.id = pl.product_id
        JOIN stock s ON s.lot_id = pl.id AND s.quantity > 0
        WHERE pl.expiry_date IS NOT NULL
          AND pl.expiry_date <= CURRENT_DATE + INTERVAL '60 days'
        ORDER BY pl.expiry_date ASC LIMIT 20`),
      pool.query(`
        SELECT sm.id, sm.movement_number, sm.type, sm.movement_date, sm.created_at,
               wo.name AS origin_name, wd.name AS dest_name
        FROM stock_movements sm
        LEFT JOIN warehouses wo ON wo.id = sm.warehouse_origin_id
        LEFT JOIN warehouses wd ON wd.id = sm.warehouse_destination_id
        ORDER BY sm.created_at DESC LIMIT 15`),
      pool.query(`
        SELECT p.name, COUNT(*) AS movs, COALESCE(SUM(smi.quantity),0) AS qty
        FROM stock_movement_items smi
        JOIN products p ON p.id = smi.product_id
        JOIN stock_movements sm ON sm.id = smi.movement_id
        WHERE sm.created_at >= NOW() - INTERVAL '30 days'
        GROUP BY p.name ORDER BY movs DESC LIMIT 8`),
      pool.query(`
        SELECT t.id, t.transfer_number, wo.name AS origin_name, wd.name AS dest_name, t.status, t.ship_date
        FROM transfers t
        JOIN warehouses wo ON wo.id = t.warehouse_origin_id
        JOIN warehouses wd ON wd.id = t.warehouse_destination_id
        WHERE t.status IN ('DESPACHADA','EN_TRANSITO')
        ORDER BY t.ship_date ASC`)
    ]);

    res.json({
      totalStock: parseFloat(totalStock.rows[0].total),
      byWarehouse: byWarehouse.rows,
      lowStockCount: lowStock.rows.length,
      lowStockList: lowStock.rows,
      noStockCount: noStock.rows.length,
      movementsToday: parseInt(movementsToday.rows[0].c, 10),
      inMonth: parseInt(inMonth.rows[0].c, 10),
      outMonth: parseInt(outMonth.rows[0].c, 10),
      pendingTransfers: parseInt(pendingTransfers.rows[0].c, 10),
      expiringSoon: expiringSoon.rows,
      recentMovements: recentMovements.rows,
      topMoved: topMoved.rows,
      inTransit: inTransit.rows
    });
  } catch (err) { next(err); }
});


const warehousesRouter = express.Router();
warehousesRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT w.*,
        COALESCE((SELECT SUM(s.quantity) FROM stock s WHERE s.warehouse_id = w.id), 0) AS total_quantity,
        (SELECT MAX(sm.created_at) FROM stock_movements sm
          WHERE sm.warehouse_origin_id = w.id OR sm.warehouse_destination_id = w.id) AS last_movement_at,
        (SELECT COUNT(DISTINCT s.product_id) FROM stock s WHERE s.warehouse_id = w.id AND s.quantity > 0) AS product_count
      FROM warehouses w
      ORDER BY w.name`);
    res.json(rows);
  } catch (err) { next(err); }
});

warehousesRouter.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM warehouses WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'NO_ENCONTRADO' });

    const stockRows = await pool.query(`
      SELECT p.id AS product_id, p.name, pl.lot_code, s.quantity, p.min_stock, p.unit
      FROM stock s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN product_lots pl ON pl.id = s.lot_id
      WHERE s.warehouse_id = $1 AND s.quantity > 0
      ORDER BY p.name`, [req.params.id]);

    res.json({ ...rows[0], stock: stockRows.rows });
  } catch (err) { next(err); }
});

warehousesRouter.post('/', async (req, res, next) => {
  try {
    const { name, location, responsible_name, phone, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'EL_NOMBRE_ES_OBLIGATORIO' });
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO warehouses (name, location, responsible_name, phone, notes)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [name, location || null, responsible_name || null, phone || null, notes || null]
      );
      await logAudit(client, { table: 'warehouses', recordId: rows[0].id, action: 'CREAR', newData: rows[0], userName: req.session.actingAsName });
      return rows[0];
    });
    res.json(result);
  } catch (err) { next(err); }
});

warehousesRouter.put('/:id', async (req, res, next) => {
  try {
    const { name, location, responsible_name, phone, notes, active } = req.body;
    const result = await withTransaction(async (client) => {
      const old = await client.query(`SELECT * FROM warehouses WHERE id=$1`, [req.params.id]);
      if (!old.rows.length) throw Object.assign(new Error('NO_ENCONTRADO'), { status: 404 });
      const { rows } = await client.query(
        `UPDATE warehouses SET name=$1, location=$2, responsible_name=$3, phone=$4, notes=$5,
          active=COALESCE($6, active), updated_at=NOW() WHERE id=$7 RETURNING *`,
        [name, location || null, responsible_name || null, phone || null, notes || null, active, req.params.id]
      );
      await logAudit(client, { table: 'warehouses', recordId: rows[0].id, action: 'EDITAR', oldData: old.rows[0], newData: rows[0], userName: req.session.actingAsName });
      return rows[0];
    });
    res.json(result);
  } catch (err) { next(err); }
});


const productsRouter = express.Router();
productsRouter.get('/', async (req, res, next) => {
  try {
    const { search, category, active } = req.query;
    const clauses = [];
    const params = [];
    if (search) {
      params.push(`%${search.toUpperCase()}%`);
      clauses.push(`(UPPER(p.name) LIKE $${params.length} OR UPPER(p.internal_code) LIKE $${params.length} OR UPPER(p.sku) LIKE $${params.length})`);
    }
    if (category) {
      params.push(category);
      clauses.push(`p.category = $${params.length}`);
    }
    if (active !== undefined) {
      params.push(active === 'true');
      clauses.push(`p.active = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT p.*, COALESCE((SELECT SUM(s.quantity) FROM stock s WHERE s.product_id=p.id),0) AS total_stock
      FROM products p ${where} ORDER BY p.name`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

productsRouter.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM products WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'NO_ENCONTRADO' });

    const stockByWarehouse = await pool.query(`
      SELECT w.name AS warehouse_name, pl.lot_code, pl.expiry_date, s.quantity
      FROM stock s
      JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN product_lots pl ON pl.id = s.lot_id
      WHERE s.product_id = $1 AND s.quantity > 0
      ORDER BY w.name`, [req.params.id]);

    const history = await pool.query(`
      SELECT sm.movement_number, sm.type, sm.movement_date, sm.created_at,
             wo.name AS origin_name, wd.name AS dest_name,
             sm.delivered_by, sm.received_by, smi.quantity, smi.unit, pl.lot_code
      FROM stock_movement_items smi
      JOIN stock_movements sm ON sm.id = smi.movement_id
      LEFT JOIN warehouses wo ON wo.id = sm.warehouse_origin_id
      LEFT JOIN warehouses wd ON wd.id = sm.warehouse_destination_id
      LEFT JOIN product_lots pl ON pl.id = smi.lot_id
      WHERE smi.product_id = $1
      ORDER BY sm.created_at DESC LIMIT 200`, [req.params.id]);

    res.json({ ...rows[0], stockByWarehouse: stockByWarehouse.rows, history: history.rows });
  } catch (err) { next(err); }
});

productsRouter.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.name) return res.status(400).json({ error: 'EL_NOMBRE_ES_OBLIGATORIO' });
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(`
        INSERT INTO products (internal_code, sku, name, active_ingredient, concentration, presentation,
          unit, category, description, min_stock, notes, photo_url)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [b.internal_code || null, b.sku || null, b.name, b.active_ingredient || null, b.concentration || null,
         b.presentation || null, b.unit || 'UNIDAD', b.category || null, b.description || null,
         b.min_stock || 0, b.notes || null, b.photo_url || null]);
      await logAudit(client, { table: 'products', recordId: rows[0].id, action: 'CREAR', newData: rows[0], userName: req.session.actingAsName });
      return rows[0];
    });
    res.json(result);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'CODIGO_INTERNO_DUPLICADO' });
    next(err);
  }
});

productsRouter.put('/:id', async (req, res, next) => {
  try {
    const b = req.body;
    const result = await withTransaction(async (client) => {
      const old = await client.query(`SELECT * FROM products WHERE id=$1`, [req.params.id]);
      if (!old.rows.length) throw Object.assign(new Error('NO_ENCONTRADO'), { status: 404 });
      const { rows } = await client.query(`
        UPDATE products SET internal_code=$1, sku=$2, name=$3, active_ingredient=$4, concentration=$5,
          presentation=$6, unit=$7, category=$8, description=$9, min_stock=$10, notes=$11, photo_url=$12,
          active=COALESCE($13, active), updated_at=NOW()
        WHERE id=$14 RETURNING *`,
        [b.internal_code || null, b.sku || null, b.name, b.active_ingredient || null, b.concentration || null,
         b.presentation || null, b.unit || 'UNIDAD', b.category || null, b.description || null,
         b.min_stock || 0, b.notes || null, b.photo_url || null, b.active, req.params.id]);
      await logAudit(client, { table: 'products', recordId: rows[0].id, action: 'EDITAR', oldData: old.rows[0], newData: rows[0], userName: req.session.actingAsName });
      return rows[0];
    });
    res.json(result);
  } catch (err) { next(err); }
});

productsRouter.post('/:id/deactivate', async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(`UPDATE products SET active=FALSE, updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id]);
      await logAudit(client, { table: 'products', recordId: rows[0].id, action: 'DESACTIVAR', newData: rows[0], userName: req.session.actingAsName });
      return rows[0];
    });
    res.json(result);
  } catch (err) { next(err); }
});


const stockRouter = express.Router();
// Vista general: producto x deposito, con totales y estado (verde/amarillo/rojo)
stockRouter.get('/', async (req, res, next) => {
  try {
    const { warehouseId, category, lowStock, noStock, search } = req.query;

    const { rows: warehouses } = await pool.query(`SELECT id, name FROM warehouses WHERE active=TRUE ORDER BY name`);

    const params = [];
    const clauses = ['p.active = TRUE'];
    if (category) { params.push(category); clauses.push(`p.category = $${params.length}`); }
    if (search) { params.push(`%${search.toUpperCase()}%`); clauses.push(`UPPER(p.name) LIKE $${params.length}`); }

    const { rows: products } = await pool.query(`
      SELECT p.id, p.name, p.presentation, p.unit, p.min_stock, p.category
      FROM products p WHERE ${clauses.join(' AND ')} ORDER BY p.name`, params);

    const { rows: stockRows } = await pool.query(`
      SELECT product_id, warehouse_id, SUM(quantity) AS qty FROM stock GROUP BY product_id, warehouse_id`);

    const stockMap = {};
    for (const r of stockRows) {
      stockMap[`${r.product_id}_${r.warehouse_id}`] = parseFloat(r.qty);
    }

    let result = products.map((p) => {
      const byWarehouse = {};
      let total = 0;
      for (const w of warehouses) {
        const qty = stockMap[`${p.id}_${w.id}`] || 0;
        byWarehouse[w.id] = qty;
        total += qty;
      }
      let status = 'NORMAL';
      if (total <= 0) status = 'CRITICO';
      else if (p.min_stock && total <= parseFloat(p.min_stock)) status = 'BAJO';
      return { ...p, byWarehouse, total, status };
    });

    if (warehouseId) result = result.filter((r) => (r.byWarehouse[warehouseId] || 0) > 0);
    if (lowStock === 'true') result = result.filter((r) => r.status === 'BAJO');
    if (noStock === 'true') result = result.filter((r) => r.status === 'CRITICO');

    res.json({ warehouses, products: result });
  } catch (err) { next(err); }
});


const movementsRouter = express.Router();
// ---------- LISTADO ----------
movementsRouter.get('/', async (req, res, next) => {
  try {
    const { type, warehouseId, productId, dateFrom, dateTo, search } = req.query;
    const clauses = [];
    const params = [];
    if (type) { params.push(type); clauses.push(`sm.type = $${params.length}`); }
    if (warehouseId) { params.push(warehouseId); clauses.push(`(sm.warehouse_origin_id = $${params.length} OR sm.warehouse_destination_id = $${params.length})`); }
    if (dateFrom) { params.push(dateFrom); clauses.push(`sm.movement_date >= $${params.length}`); }
    if (dateTo) { params.push(dateTo); clauses.push(`sm.movement_date <= $${params.length}`); }
    if (search) { params.push(`%${search.toUpperCase()}%`); clauses.push(`UPPER(sm.movement_number) LIKE $${params.length}`); }
    if (productId) {
      params.push(productId);
      clauses.push(`sm.id IN (SELECT movement_id FROM stock_movement_items WHERE product_id = $${params.length})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT sm.*, wo.name AS origin_name, wd.name AS dest_name,
        (SELECT json_agg(json_build_object('product_name', p.name, 'quantity', smi.quantity, 'unit', smi.unit, 'lot_code', pl.lot_code))
         FROM stock_movement_items smi JOIN products p ON p.id = smi.product_id
         LEFT JOIN product_lots pl ON pl.id = smi.lot_id
         WHERE smi.movement_id = sm.id) AS items
      FROM stock_movements sm
      LEFT JOIN warehouses wo ON wo.id = sm.warehouse_origin_id
      LEFT JOIN warehouses wd ON wd.id = sm.warehouse_destination_id
      ${where}
      ORDER BY sm.created_at DESC LIMIT 500`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// ---------- ENTRADA ----------
movementsRouter.post('/entrada', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.warehouse_id) return res.status(400).json({ error: 'FALTA_DEPOSITO' });
    if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'FALTA_AL_MENOS_UN_PRODUCTO' });
    for (const it of b.items) {
      if (!it.product_id || !it.quantity || parseFloat(it.quantity) <= 0) {
        return res.status(400).json({ error: 'CANTIDAD_INVALIDA' });
      }
    }
    const actingAs = req.session.actingAsName || b.received_by || 'SISTEMA';

    const result = await withTransaction(async (client) => {
      const number = await nextNumber(client, 'ENTRADA');
      const mov = await client.query(`
        INSERT INTO stock_movements (movement_number, type, movement_date, warehouse_destination_id,
          delivered_by, received_by, document_number, notes, created_by)
        VALUES ($1,'ENTRADA',$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [number, b.movement_date || new Date().toISOString().slice(0,10), b.warehouse_id,
         b.delivered_by || null, b.received_by || null, b.document_number || b.invoice_number || null,
         b.notes || null, actingAs]);

      for (const it of b.items) {
        const lotId = await findOrCreateLot(client, it.product_id, it.lot_code, it.expiry_date);
        await client.query(`
          INSERT INTO stock_movement_items (movement_id, product_id, lot_id, quantity, unit)
          VALUES ($1,$2,$3,$4,$5)`, [mov.rows[0].id, it.product_id, lotId, it.quantity, it.unit || null]);
        await adjustStock(client, { productId: it.product_id, lotId, warehouseId: b.warehouse_id, delta: parseFloat(it.quantity) });
      }

      await logAudit(client, { table: 'stock_movements', recordId: mov.rows[0].id, action: 'ENTRADA', newData: { number, items: b.items }, userName: actingAs });
      return mov.rows[0];
    });

    res.json(result);
  } catch (err) { next(err); }
});

// ---------- SALIDA ----------
movementsRouter.post('/salida', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.warehouse_id) return res.status(400).json({ error: 'FALTA_DEPOSITO' });
    if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'FALTA_AL_MENOS_UN_PRODUCTO' });
    for (const it of b.items) {
      if (!it.product_id || !it.quantity || parseFloat(it.quantity) <= 0) {
        return res.status(400).json({ error: 'CANTIDAD_INVALIDA' });
      }
    }
    const actingAs = req.session.actingAsName || b.picked_up_by || 'SISTEMA';

    const result = await withTransaction(async (client) => {
      const number = await nextNumber(client, 'SALIDA');
      const mov = await client.query(`
        INSERT INTO stock_movements (movement_number, type, movement_date, warehouse_origin_id,
          delivered_by, received_by, destination_id, reason, document_number, notes, created_by)
        VALUES ($1,'SALIDA',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [number, b.movement_date || new Date().toISOString().slice(0,10), b.warehouse_id,
         b.delivered_by || null, b.picked_up_by || null, b.destination_id || null, b.reason || null,
         b.document_number || b.invoice_number || b.order_number || null, b.notes || null, actingAs]);

      for (const it of b.items) {
        let lotId = null;
        if (it.lot_code) {
          const found = await client.query(`SELECT id FROM product_lots WHERE product_id=$1 AND lot_code=$2`, [it.product_id, it.lot_code]);
          lotId = found.rows[0] ? found.rows[0].id : null;
        }
        await client.query(`
          INSERT INTO stock_movement_items (movement_id, product_id, lot_id, quantity, unit)
          VALUES ($1,$2,$3,$4,$5)`, [mov.rows[0].id, it.product_id, lotId, it.quantity, it.unit || null]);
        try {
          await adjustStock(client, { productId: it.product_id, lotId, warehouseId: b.warehouse_id, delta: -parseFloat(it.quantity) });
        } catch (e) {
          if (e.code === 'STOCK_INSUFICIENTE') {
            const err = new Error('STOCK_INSUFICIENTE_PARA_ESTA_SALIDA');
            err.status = 400;
            err.friendly = `NO HAY STOCK SUFICIENTE PARA REALIZAR ESTA SALIDA (PRODUCTO ID ${it.product_id}).`;
            throw err;
          }
          throw e;
        }
      }

      await logAudit(client, { table: 'stock_movements', recordId: mov.rows[0].id, action: 'SALIDA', newData: { number, items: b.items }, userName: actingAs });
      return mov.rows[0];
    });

    res.json(result);
  } catch (err) {
    if (err.friendly) return res.status(err.status || 400).json({ error: err.friendly });
    next(err);
  }
});

// ---------- AJUSTE / DEVOLUCION / DANADA / VENCIDA (movimiento de un solo item) ----------
const ADJUST_TYPES = ['AJUSTE_POSITIVO', 'AJUSTE_NEGATIVO', 'DEVOLUCION', 'DANADA', 'VENCIDA'];
movementsRouter.post('/ajuste', async (req, res, next) => {
  try {
    const b = req.body;
    if (!ADJUST_TYPES.includes(b.type)) return res.status(400).json({ error: 'TIPO_DE_MOVIMIENTO_INVALIDO' });
    if (!b.warehouse_id || !b.product_id || !b.quantity || parseFloat(b.quantity) <= 0) {
      return res.status(400).json({ error: 'DATOS_INCOMPLETOS' });
    }
    if (!b.reason) return res.status(400).json({ error: 'EL_MOTIVO_ES_OBLIGATORIO' });

    const increases = b.type === 'AJUSTE_POSITIVO' || b.type === 'DEVOLUCION';
    const actingAs = req.session.actingAsName || 'SISTEMA';

    const result = await withTransaction(async (client) => {
      const number = await nextNumber(client, b.type === 'DEVOLUCION' ? 'DEVOLUCION' : (b.type.startsWith('AJUSTE') ? 'AJUSTE_POSITIVO' : 'DANADA'));
      let lotId = null;
      if (b.lot_code) lotId = await findOrCreateLot(client, b.product_id, b.lot_code, null);

      const mov = await client.query(`
        INSERT INTO stock_movements (movement_number, type, movement_date,
          warehouse_origin_id, warehouse_destination_id, reason, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [number, b.type, b.movement_date || new Date().toISOString().slice(0,10),
         increases ? null : b.warehouse_id, increases ? b.warehouse_id : null,
         b.reason, b.notes || null, actingAs]);

      await client.query(`
        INSERT INTO stock_movement_items (movement_id, product_id, lot_id, quantity, unit)
        VALUES ($1,$2,$3,$4,$5)`, [mov.rows[0].id, b.product_id, lotId, b.quantity, b.unit || null]);

      try {
        await adjustStock(client, {
          productId: b.product_id, lotId, warehouseId: b.warehouse_id,
          delta: increases ? parseFloat(b.quantity) : -parseFloat(b.quantity)
        });
      } catch (e) {
        if (e.code === 'STOCK_INSUFICIENTE') {
          const err = new Error('STOCK_INSUFICIENTE');
          err.status = 400;
          err.friendly = 'NO HAY STOCK SUFICIENTE PARA REGISTRAR ESTE AJUSTE/BAJA.';
          throw err;
        }
        throw e;
      }

      await logAudit(client, { table: 'stock_movements', recordId: mov.rows[0].id, action: b.type, newData: b, reason: b.reason, userName: actingAs });
      return mov.rows[0];
    });

    res.json(result);
  } catch (err) {
    if (err.friendly) return res.status(err.status || 400).json({ error: err.friendly });
    next(err);
  }
});


const transfersRouter = express.Router();
transfersRouter.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE t.status = $1`; }
    const { rows } = await pool.query(`
      SELECT t.*, wo.name AS origin_name, wd.name AS dest_name,
        (SELECT json_agg(json_build_object('id', ti.id, 'product_name', p.name, 'quantity_sent', ti.quantity_sent,
            'quantity_received', ti.quantity_received, 'lot_code', pl.lot_code))
         FROM transfer_items ti JOIN products p ON p.id = ti.product_id
         LEFT JOIN product_lots pl ON pl.id = ti.lot_id
         WHERE ti.transfer_id = t.id) AS items
      FROM transfers t
      JOIN warehouses wo ON wo.id = t.warehouse_origin_id
      JOIN warehouses wd ON wd.id = t.warehouse_destination_id
      ${where}
      ORDER BY t.created_at DESC`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// Crear transferencia en estado PENDIENTE (todavia no descuenta stock)
transfersRouter.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.warehouse_origin_id || !b.warehouse_destination_id) return res.status(400).json({ error: 'FALTAN_DEPOSITOS' });
    if (b.warehouse_origin_id === b.warehouse_destination_id) return res.status(400).json({ error: 'ORIGEN_Y_DESTINO_NO_PUEDEN_SER_IGUALES' });
    if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'FALTA_AL_MENOS_UN_PRODUCTO' });

    const actingAs = req.session.actingAsName || 'SISTEMA';
    const result = await withTransaction(async (client) => {
      const number = await nextNumber(client, 'TRANSFERENCIA');
      const t = await client.query(`
        INSERT INTO transfers (transfer_number, warehouse_origin_id, warehouse_destination_id,
          prepared_by_id, picked_up_by, carrier, vehicle, ship_date, eta_date, notes, created_by, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDIENTE') RETURNING *`,
        [number, b.warehouse_origin_id, b.warehouse_destination_id, b.prepared_by_id || null,
         b.picked_up_by || null, b.carrier || null, b.vehicle || null, b.ship_date || null,
         b.eta_date || null, b.notes || null, actingAs]);

      for (const it of b.items) {
        let lotId = null;
        if (it.lot_code) {
          const found = await client.query(`SELECT id FROM product_lots WHERE product_id=$1 AND lot_code=$2`, [it.product_id, it.lot_code]);
          lotId = found.rows[0] ? found.rows[0].id : null;
        }
        await client.query(`
          INSERT INTO transfer_items (transfer_id, product_id, lot_id, quantity_sent)
          VALUES ($1,$2,$3,$4)`, [t.rows[0].id, it.product_id, lotId, it.quantity]);
      }
      await logAudit(client, { table: 'transfers', recordId: t.rows[0].id, action: 'CREAR', newData: { number, items: b.items }, userName: actingAs });
      return t.rows[0];
    });
    res.json(result);
  } catch (err) { next(err); }
});

// Despachar: resta del origen y pasa a EN_TRANSITO
transfersRouter.post('/:id/despachar', async (req, res, next) => {
  try {
    const actingAs = req.session.actingAsName || 'SISTEMA';
    const result = await withTransaction(async (client) => {
      const t = await client.query(`SELECT * FROM transfers WHERE id=$1 FOR UPDATE`, [req.params.id]);
      if (!t.rows.length) throw Object.assign(new Error('NO_ENCONTRADA'), { status: 404 });
      if (t.rows[0].status !== 'PENDIENTE') throw Object.assign(new Error('LA_TRANSFERENCIA_YA_FUE_DESPACHADA'), { status: 400, friendly: 'ESTA TRANSFERENCIA YA FUE DESPACHADA O YA CAMBIO DE ESTADO.' });

      const items = await client.query(`SELECT * FROM transfer_items WHERE transfer_id=$1`, [req.params.id]);
      const mov = await client.query(`
        INSERT INTO stock_movements (movement_number, type, movement_date, warehouse_origin_id,
          warehouse_destination_id, transfer_id, created_by, notes)
        VALUES ($1,'TRANSFERENCIA_SALIDA',CURRENT_DATE,$2,$3,$4,$5,$6) RETURNING *`,
        [t.rows[0].transfer_number + '-SAL', t.rows[0].warehouse_origin_id, t.rows[0].warehouse_destination_id,
         t.rows[0].id, actingAs, 'DESPACHO DE TRANSFERENCIA ' + t.rows[0].transfer_number]);

      for (const it of items.rows) {
        try {
          await adjustStock(client, { productId: it.product_id, lotId: it.lot_id, warehouseId: t.rows[0].warehouse_origin_id, delta: -parseFloat(it.quantity_sent) });
        } catch (e) {
          if (e.code === 'STOCK_INSUFICIENTE') {
            const err = new Error('STOCK_INSUFICIENTE');
            err.status = 400;
            err.friendly = 'NO HAY STOCK SUFICIENTE EN EL DEPOSITO DE ORIGEN PARA DESPACHAR ESTA TRANSFERENCIA.';
            throw err;
          }
          throw e;
        }
        await client.query(`INSERT INTO stock_movement_items (movement_id, product_id, lot_id, quantity, unit) VALUES ($1,$2,$3,$4,$5)`,
          [mov.rows[0].id, it.product_id, it.lot_id, it.quantity_sent, null]);
      }

      const upd = await client.query(`UPDATE transfers SET status='EN_TRANSITO' WHERE id=$1 RETURNING *`, [req.params.id]);
      await logAudit(client, { table: 'transfers', recordId: t.rows[0].id, action: 'DESPACHAR', oldData: t.rows[0], newData: upd.rows[0], userName: actingAs });
      return upd.rows[0];
    });
    res.json(result);
  } catch (err) {
    if (err.friendly) return res.status(err.status || 400).json({ error: err.friendly });
    next(err);
  }
});

// Confirmar recepcion: suma al destino (con posible diferencia) y pasa a RECIBIDA
transfersRouter.post('/:id/recibir', async (req, res, next) => {
  try {
    const { received_by, items } = req.body; // items: [{transfer_item_id, quantity_received}]
    if (!received_by) return res.status(400).json({ error: 'INDICAR_QUIEN_RECIBIO' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'FALTAN_CANTIDADES_RECIBIDAS' });
    const actingAs = req.session.actingAsName || received_by;

    const result = await withTransaction(async (client) => {
      const t = await client.query(`SELECT * FROM transfers WHERE id=$1 FOR UPDATE`, [req.params.id]);
      if (!t.rows.length) throw Object.assign(new Error('NO_ENCONTRADA'), { status: 404 });
      if (t.rows[0].status !== 'EN_TRANSITO') throw Object.assign(new Error('ESTADO_INVALIDO'), { status: 400, friendly: 'LA TRANSFERENCIA NO ESTA EN TRANSITO.' });

      const number = t.rows[0].transfer_number + '-REC';
      const mov = await client.query(`
        INSERT INTO stock_movements (movement_number, type, movement_date, warehouse_origin_id,
          warehouse_destination_id, transfer_id, received_by, created_by, notes)
        VALUES ($1,'TRANSFERENCIA_ENTRADA',CURRENT_DATE,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [number, t.rows[0].warehouse_origin_id, t.rows[0].warehouse_destination_id, t.rows[0].id,
         received_by, actingAs, 'RECEPCION DE TRANSFERENCIA ' + t.rows[0].transfer_number]);

      let hasDifference = false;
      for (const it of items) {
        const ti = await client.query(`SELECT * FROM transfer_items WHERE id=$1 AND transfer_id=$2`, [it.transfer_item_id, req.params.id]);
        if (!ti.rows.length) continue;
        const qtyReceived = parseFloat(it.quantity_received);
        if (qtyReceived !== parseFloat(ti.rows[0].quantity_sent)) hasDifference = true;

        await client.query(`UPDATE transfer_items SET quantity_received=$1, notes=$2 WHERE id=$3`,
          [qtyReceived, it.notes || null, it.transfer_item_id]);

        await adjustStock(client, { productId: ti.rows[0].product_id, lotId: ti.rows[0].lot_id, warehouseId: t.rows[0].warehouse_destination_id, delta: qtyReceived });
        await client.query(`INSERT INTO stock_movement_items (movement_id, product_id, lot_id, quantity, unit) VALUES ($1,$2,$3,$4,$5)`,
          [mov.rows[0].id, ti.rows[0].product_id, ti.rows[0].lot_id, qtyReceived, null]);
      }

      const upd = await client.query(`
        UPDATE transfers SET status='RECIBIDA', received_by=$1, received_at=NOW() WHERE id=$2 RETURNING *`,
        [received_by, req.params.id]);

      await logAudit(client, {
        table: 'transfers', recordId: t.rows[0].id, action: 'RECIBIR', oldData: t.rows[0], newData: upd.rows[0],
        userName: actingAs, reason: hasDifference ? 'DIFERENCIA ENTRE CANTIDAD ENVIADA Y RECIBIDA' : null
      });
      return { ...upd.rows[0], hasDifference };
    });
    res.json(result);
  } catch (err) {
    if (err.friendly) return res.status(err.status || 400).json({ error: err.friendly });
    next(err);
  }
});

transfersRouter.post('/:id/cancelar', async (req, res, next) => {
  try {
    const actingAs = req.session.actingAsName || 'SISTEMA';
    const result = await withTransaction(async (client) => {
      const t = await client.query(`SELECT * FROM transfers WHERE id=$1 FOR UPDATE`, [req.params.id]);
      if (!t.rows.length) throw Object.assign(new Error('NO_ENCONTRADA'), { status: 404 });
      if (t.rows[0].status === 'EN_TRANSITO' || t.rows[0].status === 'RECIBIDA') {
        throw Object.assign(new Error('NO_SE_PUEDE_CANCELAR'), { status: 400, friendly: 'NO SE PUEDE CANCELAR UNA TRANSFERENCIA YA DESPACHADA. USE UN AJUSTE SI ES NECESARIO.' });
      }
      const upd = await client.query(`UPDATE transfers SET status='CANCELADA' WHERE id=$1 RETURNING *`, [req.params.id]);
      await logAudit(client, { table: 'transfers', recordId: t.rows[0].id, action: 'CANCELAR', oldData: t.rows[0], newData: upd.rows[0], userName: actingAs });
      return upd.rows[0];
    });
    res.json(result);
  } catch (err) {
    if (err.friendly) return res.status(err.status || 400).json({ error: err.friendly });
    next(err);
  }
});


const responsiblesRouter = express.Router();
responsiblesRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.*, w.name AS warehouse_name FROM responsibles r
      LEFT JOIN warehouses w ON w.id = r.warehouse_id
      ORDER BY r.first_name`);
    res.json(rows);
  } catch (err) { next(err); }
});

responsiblesRouter.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.first_name) return res.status(400).json({ error: 'EL_NOMBRE_ES_OBLIGATORIO' });
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(`
        INSERT INTO responsibles (first_name, last_name, company, position, phone, email, warehouse_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.first_name, b.last_name || null, b.company || null, b.position || null, b.phone || null, b.email || null, b.warehouse_id || null]);
      await logAudit(client, { table: 'responsibles', recordId: rows[0].id, action: 'CREAR', newData: rows[0], userName: req.session.actingAsName });
      return rows[0];
    });
    res.json(result);
  } catch (err) { next(err); }
});

responsiblesRouter.put('/:id', async (req, res, next) => {
  try {
    const b = req.body;
    const result = await withTransaction(async (client) => {
      const old = await client.query(`SELECT * FROM responsibles WHERE id=$1`, [req.params.id]);
      if (!old.rows.length) throw Object.assign(new Error('NO_ENCONTRADO'), { status: 404 });
      const { rows } = await client.query(`
        UPDATE responsibles SET first_name=$1, last_name=$2, company=$3, position=$4, phone=$5, email=$6,
          warehouse_id=$7, active=COALESCE($8, active) WHERE id=$9 RETURNING *`,
        [b.first_name, b.last_name || null, b.company || null, b.position || null, b.phone || null,
         b.email || null, b.warehouse_id || null, b.active, req.params.id]);
      await logAudit(client, { table: 'responsibles', recordId: rows[0].id, action: 'EDITAR', oldData: old.rows[0], newData: rows[0], userName: req.session.actingAsName });
      return rows[0];
    });
    res.json(result);
  } catch (err) { next(err); }
});


const destinationsRouter = express.Router();
destinationsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM destinations ORDER BY name`);
    res.json(rows);
  } catch (err) { next(err); }
});

destinationsRouter.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.name || !b.type) return res.status(400).json({ error: 'NOMBRE_Y_TIPO_SON_OBLIGATORIOS' });
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO destinations (name, type, notes) VALUES ($1,$2,$3) RETURNING *`,
        [b.name, b.type, b.notes || null]);
      await logAudit(client, { table: 'destinations', recordId: rows[0].id, action: 'CREAR', newData: rows[0], userName: req.session.actingAsName });
      return rows[0];
    });
    res.json(result);
  } catch (err) { next(err); }
});

destinationsRouter.put('/:id', async (req, res, next) => {
  try {
    const b = req.body;
    const result = await withTransaction(async (client) => {
      const old = await client.query(`SELECT * FROM destinations WHERE id=$1`, [req.params.id]);
      if (!old.rows.length) throw Object.assign(new Error('NO_ENCONTRADO'), { status: 404 });
      const { rows } = await client.query(
        `UPDATE destinations SET name=$1, type=$2, notes=$3, active=COALESCE($4,active) WHERE id=$5 RETURNING *`,
        [b.name, b.type, b.notes || null, b.active, req.params.id]);
      await logAudit(client, { table: 'destinations', recordId: rows[0].id, action: 'EDITAR', oldData: old.rows[0], newData: rows[0], userName: req.session.actingAsName });
      return rows[0];
    });
    res.json(result);
  } catch (err) { next(err); }
});


const inventoryCountsRouter = express.Router();
inventoryCountsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT ic.*, w.name AS warehouse_name
      FROM inventory_counts ic JOIN warehouses w ON w.id = ic.warehouse_id
      ORDER BY ic.created_at DESC`);
    res.json(rows);
  } catch (err) { next(err); }
});

// Inicia un conteo: trae el stock actual del deposito como base (systemQty)
inventoryCountsRouter.post('/', async (req, res, next) => {
  try {
    const { warehouse_id, responsible_id } = req.body;
    if (!warehouse_id) return res.status(400).json({ error: 'FALTA_DEPOSITO' });
    const actingAs = req.session.actingAsName || 'SISTEMA';

    const result = await withTransaction(async (client) => {
      const number = await nextNumber(client, 'INVENTARIO');
      const ic = await client.query(`
        INSERT INTO inventory_counts (count_number, warehouse_id, responsible_id) VALUES ($1,$2,$3) RETURNING *`,
        [number, warehouse_id, responsible_id || null]);

      const stockRows = await client.query(`
        SELECT product_id, lot_id, quantity FROM stock WHERE warehouse_id=$1 AND quantity > 0`, [warehouse_id]);
      for (const s of stockRows.rows) {
        await client.query(`
          INSERT INTO inventory_count_items (count_id, product_id, lot_id, system_qty)
          VALUES ($1,$2,$3,$4)`, [ic.rows[0].id, s.product_id, s.lot_id, s.quantity]);
      }
      await logAudit(client, { table: 'inventory_counts', recordId: ic.rows[0].id, action: 'CREAR', newData: ic.rows[0], userName: actingAs });
      return ic.rows[0];
    });
    res.json(result);
  } catch (err) { next(err); }
});

inventoryCountsRouter.get('/:id', async (req, res, next) => {
  try {
    const ic = await pool.query(`SELECT ic.*, w.name AS warehouse_name FROM inventory_counts ic JOIN warehouses w ON w.id=ic.warehouse_id WHERE ic.id=$1`, [req.params.id]);
    if (!ic.rows.length) return res.status(404).json({ error: 'NO_ENCONTRADO' });
    const items = await pool.query(`
      SELECT ici.*, p.name AS product_name, pl.lot_code
      FROM inventory_count_items ici
      JOIN products p ON p.id = ici.product_id
      LEFT JOIN product_lots pl ON pl.id = ici.lot_id
      WHERE ici.count_id = $1 ORDER BY p.name`, [req.params.id]);
    res.json({ ...ic.rows[0], items: items.rows });
  } catch (err) { next(err); }
});

// Cierra el conteo: carga cantidades fisicas, genera ajustes automaticos donde haya diferencia
inventoryCountsRouter.post('/:id/cerrar', async (req, res, next) => {
  try {
    const { items } = req.body; // [{item_id, physical_qty, notes}]
    if (!Array.isArray(items)) return res.status(400).json({ error: 'FALTAN_CANTIDADES' });
    const actingAs = req.session.actingAsName || 'SISTEMA';

    const result = await withTransaction(async (client) => {
      const ic = await client.query(`SELECT * FROM inventory_counts WHERE id=$1 FOR UPDATE`, [req.params.id]);
      if (!ic.rows.length) throw Object.assign(new Error('NO_ENCONTRADO'), { status: 404 });
      if (ic.rows[0].status === 'CERRADO') throw Object.assign(new Error('YA_CERRADO'), { status: 400, friendly: 'ESTE CONTEO YA FUE CERRADO.' });

      const adjNumber = await nextNumber(client, 'AJUSTE_POSITIVO');
      let anyDiff = false;

      for (const it of items) {
        const row = await client.query(`SELECT * FROM inventory_count_items WHERE id=$1 AND count_id=$2`, [it.item_id, req.params.id]);
        if (!row.rows.length) continue;
        const physical = parseFloat(it.physical_qty);
        const diff = physical - parseFloat(row.rows[0].system_qty);
        await client.query(`UPDATE inventory_count_items SET physical_qty=$1, difference=$2, notes=$3 WHERE id=$4`,
          [physical, diff, it.notes || null, it.item_id]);

        if (diff !== 0) {
          anyDiff = true;
          const type = diff > 0 ? 'AJUSTE_POSITIVO' : 'AJUSTE_NEGATIVO';
          const number = await nextNumber(client, type);
          const mov = await client.query(`
            INSERT INTO stock_movements (movement_number, type, movement_date,
              warehouse_origin_id, warehouse_destination_id, reason, notes, created_by)
            VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7) RETURNING *`,
            [number, type, diff > 0 ? null : ic.rows[0].warehouse_id, diff > 0 ? ic.rows[0].warehouse_id : null,
             'AJUSTE POR CONTEO FISICO ' + ic.rows[0].count_number, it.notes || null, actingAs]);
          await client.query(`INSERT INTO stock_movement_items (movement_id, product_id, lot_id, quantity, unit) VALUES ($1,$2,$3,$4,$5)`,
            [mov.rows[0].id, row.rows[0].product_id, row.rows[0].lot_id, Math.abs(diff), null]);
          await adjustStock(client, { productId: row.rows[0].product_id, lotId: row.rows[0].lot_id, warehouseId: ic.rows[0].warehouse_id, delta: diff });
        }
      }

      const upd = await client.query(`UPDATE inventory_counts SET status='CERRADO' WHERE id=$1 RETURNING *`, [req.params.id]);
      await logAudit(client, { table: 'inventory_counts', recordId: ic.rows[0].id, action: 'CERRAR', newData: upd.rows[0], userName: actingAs, reason: anyDiff ? 'SE GENERARON AJUSTES POR DIFERENCIA' : null });
      return { ...upd.rows[0], anyDiff };
    });
    res.json(result);
  } catch (err) {
    if (err.friendly) return res.status(err.status || 400).json({ error: err.friendly });
    next(err);
  }
});


const auditRouter = express.Router();
auditRouter.get('/', async (req, res, next) => {
  try {
    const { table, dateFrom, dateTo } = req.query;
    const clauses = [];
    const params = [];
    if (table) { params.push(table); clauses.push(`table_name = $${params.length}`); }
    if (dateFrom) { params.push(dateFrom); clauses.push(`created_at >= $${params.length}`); }
    if (dateTo) { params.push(dateTo); clauses.push(`created_at <= $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT 500`, params);
    res.json(rows);
  } catch (err) { next(err); }
});


const reportsRouter = express.Router();

function toCSV(rows, columns) {
  const header = columns.map((c) => c.label).join(';');
  const lines = rows.map((r) => columns.map((c) => {
    let v = r[c.key];
    if (v === null || v === undefined) v = '';
    v = String(v).replace(/;/g, ',').replace(/\n/g, ' ');
    return v;
  }).join(';'));
  return [header, ...lines].join('\n');
}

async function sendReport(req, res, rows, columns, filenameBase) {
  const format = (req.query.format || 'csv').toLowerCase();
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('REPORTE');
    ws.columns = columns.map((c) => ({ header: c.label, key: c.key, width: 22 }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF001E4F' } };
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    rows.forEach((r) => ws.addRow(r));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } else {
    const csv = toCSV(rows, columns);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
    res.send('\uFEFF' + csv);
  }
}

// STOCK ACTUAL (general o por deposito)
reportsRouter.get('/stock-actual', async (req, res, next) => {
  try {
    const { warehouseId } = req.query;
    const params = [];
    let where = 'WHERE s.quantity > 0';
    if (warehouseId) { params.push(warehouseId); where += ` AND s.warehouse_id = $${params.length}`; }
    const { rows } = await pool.query(`
      SELECT p.name AS producto, w.name AS deposito, pl.lot_code AS lote, pl.expiry_date AS vencimiento,
             s.quantity AS cantidad, p.unit AS unidad, p.min_stock AS stock_minimo
      FROM stock s
      JOIN products p ON p.id = s.product_id
      JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN product_lots pl ON pl.id = s.lot_id
      ${where}
      ORDER BY p.name, w.name`, params);
    await sendReport(req, res, rows, [
      { key: 'producto', label: 'PRODUCTO' }, { key: 'deposito', label: 'DEPOSITO' },
      { key: 'lote', label: 'LOTE' }, { key: 'vencimiento', label: 'VENCIMIENTO' },
      { key: 'cantidad', label: 'CANTIDAD' }, { key: 'unidad', label: 'UNIDAD' },
      { key: 'stock_minimo', label: 'STOCK MINIMO' }
    ], 'stock_actual');
  } catch (err) { next(err); }
});

// MOVIMIENTOS (por fecha / producto / deposito / tipo)
reportsRouter.get('/movimientos', async (req, res, next) => {
  try {
    const { dateFrom, dateTo, productId, warehouseId, type } = req.query;
    const clauses = [];
    const params = [];
    if (dateFrom) { params.push(dateFrom); clauses.push(`sm.movement_date >= $${params.length}`); }
    if (dateTo) { params.push(dateTo); clauses.push(`sm.movement_date <= $${params.length}`); }
    if (warehouseId) { params.push(warehouseId); clauses.push(`(sm.warehouse_origin_id=$${params.length} OR sm.warehouse_destination_id=$${params.length})`); }
    if (type) { params.push(type); clauses.push(`sm.type = $${params.length}`); }
    if (productId) { params.push(productId); clauses.push(`smi.product_id = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT sm.movement_number AS numero, sm.type AS tipo, sm.movement_date AS fecha,
             p.name AS producto, smi.quantity AS cantidad, smi.unit AS unidad,
             wo.name AS deposito_origen, wd.name AS deposito_destino,
             sm.delivered_by AS entrego, sm.received_by AS recibio, sm.reason AS motivo,
             sm.document_number AS documento, sm.created_by AS registrado_por
      FROM stock_movement_items smi
      JOIN stock_movements sm ON sm.id = smi.movement_id
      JOIN products p ON p.id = smi.product_id
      LEFT JOIN warehouses wo ON wo.id = sm.warehouse_origin_id
      LEFT JOIN warehouses wd ON wd.id = sm.warehouse_destination_id
      ${where}
      ORDER BY sm.created_at DESC LIMIT 5000`, params);

    await sendReport(req, res, rows, [
      { key: 'numero', label: 'NUMERO' }, { key: 'tipo', label: 'TIPO' }, { key: 'fecha', label: 'FECHA' },
      { key: 'producto', label: 'PRODUCTO' }, { key: 'cantidad', label: 'CANTIDAD' }, { key: 'unidad', label: 'UNIDAD' },
      { key: 'deposito_origen', label: 'DEPOSITO ORIGEN' }, { key: 'deposito_destino', label: 'DEPOSITO DESTINO' },
      { key: 'entrego', label: 'ENTREGO' }, { key: 'recibio', label: 'RECIBIO' }, { key: 'motivo', label: 'MOTIVO' },
      { key: 'documento', label: 'DOCUMENTO' }, { key: 'registrado_por', label: 'REGISTRADO POR' }
    ], 'movimientos');
  } catch (err) { next(err); }
});

// STOCK BAJO / PROXIMOS A VENCER
reportsRouter.get('/stock-bajo', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.name AS producto, p.min_stock AS stock_minimo, COALESCE(SUM(s.quantity),0) AS stock_actual
      FROM products p LEFT JOIN stock s ON s.product_id = p.id
      WHERE p.active = TRUE GROUP BY p.id, p.name, p.min_stock
      HAVING COALESCE(SUM(s.quantity),0) <= p.min_stock ORDER BY p.name`);
    await sendReport(req, res, rows, [
      { key: 'producto', label: 'PRODUCTO' }, { key: 'stock_minimo', label: 'STOCK MINIMO' }, { key: 'stock_actual', label: 'STOCK ACTUAL' }
    ], 'stock_bajo');
  } catch (err) { next(err); }
});

reportsRouter.get('/vencimientos', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days || '60', 10);
    const { rows } = await pool.query(`
      SELECT p.name AS producto, pl.lot_code AS lote, pl.expiry_date AS vencimiento,
             w.name AS deposito, s.quantity AS cantidad
      FROM stock s
      JOIN products p ON p.id = s.product_id
      JOIN product_lots pl ON pl.id = s.lot_id
      JOIN warehouses w ON w.id = s.warehouse_id
      WHERE s.quantity > 0 AND pl.expiry_date IS NOT NULL AND pl.expiry_date <= CURRENT_DATE + ($1 || ' days')::INTERVAL
      ORDER BY pl.expiry_date ASC`, [days]);
    await sendReport(req, res, rows, [
      { key: 'producto', label: 'PRODUCTO' }, { key: 'lote', label: 'LOTE' }, { key: 'vencimiento', label: 'VENCIMIENTO' },
      { key: 'deposito', label: 'DEPOSITO' }, { key: 'cantidad', label: 'CANTIDAD' }
    ], 'proximos_a_vencer');
  } catch (err) { next(err); }
});

// ENTREGADO / RETIRADO POR PERSONA
reportsRouter.get('/por-persona', async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const params = [];
    let where = '';
    if (dateFrom) { params.push(dateFrom); where += ` AND sm.movement_date >= $${params.length}`; }
    if (dateTo) { params.push(dateTo); where += ` AND sm.movement_date <= $${params.length}`; }
    const { rows } = await pool.query(`
      SELECT sm.type AS tipo, sm.delivered_by AS entrego, sm.received_by AS recibio,
             p.name AS producto, smi.quantity AS cantidad, sm.movement_date AS fecha
      FROM stock_movement_items smi
      JOIN stock_movements sm ON sm.id = smi.movement_id
      JOIN products p ON p.id = smi.product_id
      WHERE sm.type IN ('ENTRADA','SALIDA') ${where}
      ORDER BY sm.movement_date DESC`, params);
    await sendReport(req, res, rows, [
      { key: 'tipo', label: 'TIPO' }, { key: 'entrego', label: 'ENTREGO' }, { key: 'recibio', label: 'RECIBIO' },
      { key: 'producto', label: 'PRODUCTO' }, { key: 'cantidad', label: 'CANTIDAD' }, { key: 'fecha', label: 'FECHA' }
    ], 'movimientos_por_persona');
  } catch (err) { next(err); }
});


const configRouter = express.Router();
configRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM configuration ORDER BY key`);
    res.json(rows);
  } catch (err) { next(err); }
});

configRouter.put('/:key', async (req, res, next) => {
  try {
    const { value } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO configuration (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=$2 RETURNING *`,
      [req.params.key, value]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------
// SERVIDOR
// ---------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '5mb' }));

app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true, tableName: 'user_sessions' }),
  secret: process.env.SESSION_SECRET || 'cambiar-este-secreto',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// ---- RUTAS PUBLICAS ----
app.use('/api/auth', authRouter);
app.get('/api/responsibles/public', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id, first_name, last_name, warehouse_id FROM responsibles WHERE active=TRUE ORDER BY first_name`);
    res.json(rows);
  } catch (err) { next(err); }
});

// ---- RUTAS PROTEGIDAS ----
app.use('/api/dashboard', requireAuth, dashboardRouter);
app.use('/api/warehouses', requireAuth, warehousesRouter);
app.use('/api/products', requireAuth, productsRouter);
app.use('/api/stock', requireAuth, stockRouter);
app.use('/api/movements', requireAuth, movementsRouter);
app.use('/api/transfers', requireAuth, transfersRouter);
app.use('/api/responsibles', requireAuth, responsiblesRouter);
app.use('/api/destinations', requireAuth, destinationsRouter);
app.use('/api/inventory-counts', requireAuth, inventoryCountsRouter);
app.use('/api/audit', requireAuth, auditRouter);
app.use('/api/reports', requireAuth, reportsRouter);
app.use('/api/config', requireAuth, configRouter);

// ---- FRONTEND (archivos sueltos en la raiz del proyecto) ----
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'styles.css')));
// cualquier otra ruta que no sea /api/... devuelve index.html (para que ande el menu lateral)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---- MANEJO DE ERRORES ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.friendly || 'ERROR_INTERNO_DEL_SERVIDOR' });
});

// ---------------------------------------------------------------------
// ARRANQUE: crea las tablas solas si no existen y despues prende el servidor
// ---------------------------------------------------------------------
async function start() {
  try {
    console.log('>> VERIFICANDO / CREANDO TABLAS EN POSTGRESQL...');
    await pool.query(SCHEMA_SQL);
    await pool.query(SEED_SQL);
    console.log('>> BASE DE DATOS LISTA.');
  } catch (err) {
    console.error('ERROR AL PREPARAR LA BASE DE DATOS:', err);
    process.exit(1);
  }
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`AGROFORCE + TAMPA CONTROL DE STOCK corriendo en puerto ${PORT}`));
}
start();
