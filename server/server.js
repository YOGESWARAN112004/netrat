const dns = require("dns");
const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

// Render's container can fail on IPv6-only resolution paths; prefer IPv4 for Supabase.
dns.setDefaultResultOrder("ipv4first");

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ============================================================
// DB — external PostgreSQL providers use DATABASE_URL with SSL required
// ============================================================
const pool = new Pool(
    process.env.DATABASE_URL
        ? {
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }  // required on Render
          }
        : {
            // Local fallback
            host:     process.env.DB_HOST     || "localhost",
            port:     process.env.DB_PORT     || 5432,
            user:     process.env.DB_USER     || "cloth",
            password: process.env.DB_PASSWORD || "cloth123",
            database: process.env.DB_NAME     || "clothdb"
          }
);

// ============================================================
// DB init — wait for Render Postgres, then run the SQL schema file
// ============================================================
async function initDB() {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  for (let i = 0; i < 60; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("[DB] Connected");
      break;
    } catch (err) {
      console.log(`[DB] Waiting... (${i + 1}/60)`);
      if (i === 59) {
        throw err;
      }
      await sleep(5000);
    }
  }

  const schemaPath = path.join(__dirname, "..", "init.sql");
  const schemaSql = await fs.readFile(schemaPath, "utf8");
  const statements = schemaSql
    .split(/;\s*(?:\r?\n|$)/)
    .map(stmt => stmt.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await pool.query(statement);
  }

  console.log("[DB] Tables ready");
}

// ============================================================
// POST /api/machines/sync  — ESP32 calls this
// ============================================================
app.post("/api/machines/sync", async (req, res) => {
    const {
        machineId, factoryId, lineId, machineType,
        countAB=0, count27=0, countCur=0, countOutput=0, currentAmps=0
    } = req.body;

    if (!machineId || !lineId || !machineType)
        return res.status(400).json({ error: "machineId, lineId, machineType required" });

    try {
        await pool.query(`
            INSERT INTO machines (machine_id,factory_id,line_id,machine_type,last_seen)
            VALUES ($1,$2,$3,$4,NOW())
            ON CONFLICT (machine_id) DO UPDATE
            SET last_seen=NOW(), line_id=$3, machine_type=$4
        `, [machineId, factoryId, lineId, machineType]);

        await pool.query(`
            INSERT INTO sync_events
                (machine_id,line_id,machine_type,count_ab,count_27,count_cur,count_output,current_amps)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [machineId, lineId, machineType, countAB, count27, countCur, countOutput, currentAmps]);

        console.log(`[SYNC] ${machineId} AB:${countAB} 27:${count27} CUR:${countCur} OUT:${countOutput}`);
        res.json({ ok: true });
    } catch(err) {
        console.error("[SYNC]", err.message);
        res.status(500).json({ error: "db error" });
    }
});

// ============================================================
// GET /api/lines
// ============================================================
app.get("/api/lines", async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT m.line_id, m.machine_id, m.machine_type, m.last_seen,
                   s.count_ab, s.count_27, s.count_cur, s.count_output, s.current_amps
            FROM machines m
            LEFT JOIN LATERAL (
                SELECT count_ab,count_27,count_cur,count_output,current_amps
                FROM sync_events WHERE machine_id=m.machine_id
                ORDER BY synced_at DESC LIMIT 1
            ) s ON true
            ORDER BY m.line_id, m.machine_type DESC
        `);
        const lines = {};
        for (const row of rows) {
            if (!lines[row.line_id])
                lines[row.line_id] = { lineId:row.line_id, input:null, output:null };
            const online = row.last_seen && (Date.now()-new Date(row.last_seen)) < 60000;
            const m = {
                machineId:   row.machine_id,
                online,
                lastSeen:    row.last_seen,
                countAB:     row.count_ab     || 0,
                count27:     row.count_27     || 0,
                countCur:    row.count_cur    || 0,
                countOutput: row.count_output || 0,
                currentAmps: row.current_amps || 0
            };
            if (row.machine_type === "input")  lines[row.line_id].input  = m;
            if (row.machine_type === "output") lines[row.line_id].output = m;
        }
        res.json(Object.values(lines));
    } catch(err) { res.status(500).json({ error:"db error" }); }
});

// ============================================================
// BATCHES
// ============================================================
app.get("/api/batches", async (req, res) => {
    const { status, lineId } = req.query;
    try {
        let q = `
            SELECT b.*,
                COALESCE(s.pieces_ab,0)  AS pieces_ab,
                COALESCE(s.pieces_27,0)  AS pieces_27,
                COALESCE(s.pieces_cur,0) AS pieces_cur,
                COALESCE(s.pieces_out,0) AS pieces_out
            FROM batches b
            LEFT JOIN LATERAL (
                SELECT
                    GREATEST(MAX(count_ab)    -MIN(count_ab),0)    AS pieces_ab,
                    GREATEST(MAX(count_27)    -MIN(count_27),0)    AS pieces_27,
                    GREATEST(MAX(count_cur)   -MIN(count_cur),0)   AS pieces_cur,
                    GREATEST(MAX(count_output)-MIN(count_output),0) AS pieces_out
                FROM sync_events
                WHERE line_id=b.line_id AND synced_at >= b.started_at
            ) s ON true
            WHERE 1=1
        `;
        const params = [];
        if (status) { params.push(status); q += ` AND b.status=$${params.length}`; }
        if (lineId) { params.push(lineId); q += ` AND b.line_id=$${params.length}`; }
        q += " ORDER BY b.started_at DESC";
        const { rows } = await pool.query(q, params);
        res.json(rows);
    } catch(err) { console.error(err); res.status(500).json({ error:"db error" }); }
});

app.post("/api/batches", async (req, res) => {
    const { batchCode, lineId, productName, operatorName, targetCount, notes="" } = req.body;
    if (!batchCode||!lineId||!productName||!operatorName||!targetCount)
        return res.status(400).json({ error:"All fields required" });
    try {
        const { rows } = await pool.query(`
            INSERT INTO batches (batch_code,line_id,product_name,operator_name,target_count,notes)
            VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
        `, [batchCode, lineId, productName, operatorName, targetCount, notes]);
        res.json(rows[0]);
    } catch(err) {
        if (err.code==="23505") return res.status(400).json({ error:"Batch code already exists" });
        res.status(500).json({ error:"db error" });
    }
});

app.put("/api/batches/:id", async (req, res) => {
    const { id } = req.params;
    const { status, productName, operatorName, targetCount, notes } = req.body;
    try {
        const { rows } = await pool.query(`
            UPDATE batches SET
                status        = COALESCE($1, status),
                product_name  = COALESCE($2, product_name),
                operator_name = COALESCE($3, operator_name),
                target_count  = COALESCE($4::int, target_count),
                notes         = COALESCE($5, notes),
                completed_at  = CASE WHEN $1='completed' THEN NOW() ELSE completed_at END
            WHERE id=$6 RETURNING *
        `, [status||null, productName||null, operatorName||null, targetCount||null, notes||null, id]);
        if (!rows.length) return res.status(404).json({ error:"Not found" });
        res.json(rows[0]);
    } catch(err) { res.status(500).json({ error:"db error" }); }
});

app.delete("/api/batches/:id", async (req, res) => {
    try {
        await pool.query("DELETE FROM batches WHERE id=$1", [req.params.id]);
        res.json({ ok:true });
    } catch(err) { res.status(500).json({ error:"db error" }); }
});

// ============================================================
// COUNTS + EVENTS
// ============================================================
app.get("/api/counts", async (req, res) => {
    const { lineId, start, end } = req.query;
    if (!lineId||!start||!end) return res.status(400).json({ error:"lineId,start,end required" });
    try {
        const { rows } = await pool.query(`
            SELECT machine_id, machine_type, COUNT(*) AS syncs,
                GREATEST(MAX(count_ab)    -MIN(count_ab),0)     AS pieces_ab,
                GREATEST(MAX(count_27)    -MIN(count_27),0)     AS pieces_27,
                GREATEST(MAX(count_cur)   -MIN(count_cur),0)    AS pieces_cur,
                GREATEST(MAX(count_output)-MIN(count_output),0) AS pieces_output,
                ROUND(AVG(current_amps)::numeric,3)             AS avg_amps,
                MIN(synced_at) AS from_time, MAX(synced_at) AS to_time
            FROM sync_events
            WHERE line_id=$1 AND synced_at BETWEEN $2 AND $3
            GROUP BY machine_id, machine_type ORDER BY machine_type DESC
        `, [lineId, start, end]);
        res.json(rows);
    } catch(err) { res.status(500).json({ error:"db error" }); }
});

app.get("/api/events", async (req, res) => {
    const { lineId, start, end, limit=200 } = req.query;
    if (!lineId||!start||!end) return res.status(400).json({ error:"lineId,start,end required" });
    try {
        const { rows } = await pool.query(`
            SELECT synced_at,machine_id,machine_type,
                   count_ab,count_27,count_cur,count_output,current_amps
            FROM sync_events
            WHERE line_id=$1 AND synced_at BETWEEN $2 AND $3
            ORDER BY synced_at DESC LIMIT $4
        `, [lineId, start, end, parseInt(limit)]);
        res.json(rows);
    } catch(err) { res.status(500).json({ error:"db error" }); }
});

// ============================================================
// DASHBOARD — same UI as before
// ============================================================
app.get("/", (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cloth Counter Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#64748b;
      --blue:#38bdf8;--green:#4ade80;--yellow:#facc15;--purple:#a78bfa;--red:#f87171;--orange:#fb923c}
body{font-family:'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex}
.sidebar{width:220px;background:var(--surface);border-right:1px solid var(--border);
         display:flex;flex-direction:column;position:fixed;height:100vh;z-index:100}
.logo{padding:24px 20px;border-bottom:1px solid var(--border)}
.logo h2{font-size:1rem;color:var(--blue);letter-spacing:.05em}
.logo p{font-size:.7rem;color:var(--muted);margin-top:2px}
.nav{padding:16px 0;flex:1}
.nav-item{display:flex;align-items:center;gap:10px;padding:11px 20px;color:var(--muted);
          cursor:pointer;font-size:.85rem;transition:.15s;border-left:3px solid transparent}
.nav-item:hover{color:var(--text);background:rgba(255,255,255,.04)}
.nav-item.active{color:var(--blue);background:rgba(56,189,248,.08);border-left-color:var(--blue)}
.sidebar-footer{padding:16px 20px;border-top:1px solid var(--border);font-size:.7rem;color:var(--muted)}
.pulse{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);
       margin-right:6px;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.main{margin-left:220px;flex:1;padding:28px;min-height:100vh}
.page{display:none}.page.active{display:block}
.page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
.page-title{font-size:1.2rem;font-weight:700}
.page-title span{color:var(--muted);font-weight:400;font-size:.9rem;margin-left:8px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border:none;
     border-radius:7px;cursor:pointer;font-size:.82rem;font-weight:600;transition:.15s}
.btn-primary{background:var(--blue);color:#0f172a}.btn-primary:hover{background:#7dd3fc}
.btn-success{background:#14532d;color:var(--green);border:1px solid #166534}
.btn-success:hover{background:#166534}
.btn-danger{background:#450a0a;color:var(--red);border:1px solid #7f1d1d}
.btn-danger:hover{background:#7f1d1d}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
.btn-ghost:hover{color:var(--text);border-color:var(--muted)}
.btn-sm{padding:5px 10px;font-size:.75rem}
.stats-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin-bottom:24px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px}
.stat-label{font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.stat-value{font-size:2rem;font-weight:800;line-height:1}
.stat-sub{font-size:.7rem;color:var(--muted);margin-top:4px}
.line-grid{display:grid;gap:16px}
.line-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.line-head{display:flex;justify-content:space-between;align-items:center;
           padding:14px 20px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.02)}
.line-name{font-weight:700;font-size:.95rem}
.machines-row{display:grid;grid-template-columns:1fr 1fr}
.machine-box{padding:18px 20px}
.machine-box:first-child{border-right:1px solid var(--border)}
.m-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
.m-label{font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.m-id{font-size:.82rem;font-weight:600;color:var(--text);margin-top:2px}
.badge{font-size:.62rem;padding:3px 9px;border-radius:999px;font-weight:700;white-space:nowrap}
.badge-on{background:#14532d;color:var(--green)}.badge-off{background:#450a0a;color:var(--red)}
.badge-nc{background:#1e3a5f;color:var(--blue)}
.metrics-mini{display:flex;gap:14px;flex-wrap:wrap}
.met{text-align:center}
.met-v{font-size:1.5rem;font-weight:800;line-height:1}
.met-l{font-size:.6rem;color:var(--muted);text-transform:uppercase;margin-top:3px}
.last-seen{font-size:.65rem;color:var(--muted);margin-top:10px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:20px}
.card-head{display:flex;justify-content:space-between;align-items:center;
           padding:14px 20px;border-bottom:1px solid var(--border)}
.card-title{font-size:.85rem;font-weight:600}
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.8rem}
th{background:#0b1220;color:var(--muted);padding:10px 16px;text-align:left;
   font-size:.67rem;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
td{padding:11px 16px;border-bottom:1px solid rgba(51,65,85,.5);color:var(--text);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}
.empty-row td{text-align:center;color:var(--muted);padding:32px}
.status-active{background:#14532d22;color:var(--green);border:1px solid #14532d;
               font-size:.68rem;padding:2px 9px;border-radius:999px;font-weight:600}
.status-completed{background:#1e3a5f22;color:var(--blue);border:1px solid #1e3a5f;
                  font-size:.68rem;padding:2px 9px;border-radius:999px;font-weight:600}
.status-paused{background:#451a0322;color:var(--orange);border:1px solid #451a03;
               font-size:.68rem;padding:2px 9px;border-radius:999px;font-weight:600}
.prog-wrap{display:flex;align-items:center;gap:8px;min-width:130px}
.prog-bar{flex:1;height:6px;background:#334155;border-radius:999px;overflow:hidden}
.prog-fill{height:100%;border-radius:999px;transition:width .3s}
.prog-pct{font-size:.72rem;color:var(--muted);white-space:nowrap}
.filter-bar{background:var(--surface);border:1px solid var(--border);border-radius:10px;
            padding:16px 20px;margin-bottom:20px}
.filter-row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.field{display:flex;flex-direction:column;gap:5px}
.field label{font-size:.67rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.field input,.field select{background:#0f172a;border:1px solid var(--border);color:var(--text);
    border-radius:6px;padding:7px 11px;font-size:.82rem;outline:none;min-width:140px}
.field input:focus,.field select:focus{border-color:var(--blue)}
.sum-strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.sum-card{background:var(--surface);border:1px solid var(--border);border-radius:9px;
          padding:14px 16px;text-align:center}
.sum-val{font-size:1.8rem;font-weight:800}
.sum-lbl{font-size:.62rem;color:var(--muted);text-transform:uppercase;margin-top:4px}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;
         display:none;align-items:center;justify-content:center}
.overlay.open{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;
       padding:28px;width:100%;max-width:480px;position:relative}
.modal h3{font-size:1rem;font-weight:700;margin-bottom:20px}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.form-full{grid-column:1/-1}
.form-group{display:flex;flex-direction:column;gap:6px}
.form-group label{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.form-group input,.form-group select,.form-group textarea{
    background:#0f172a;border:1px solid var(--border);color:var(--text);
    border-radius:7px;padding:9px 12px;font-size:.85rem;outline:none;font-family:inherit}
.form-group input:focus,.form-group select:focus,.form-group textarea:focus{border-color:var(--blue)}
.form-group textarea{resize:vertical;min-height:70px}
.modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}
.close-btn{position:absolute;top:16px;right:16px;background:none;border:none;
           color:var(--muted);cursor:pointer;font-size:1.2rem;padding:4px}
.close-btn:hover{color:var(--text)}
.toast{position:fixed;bottom:24px;right:24px;background:#1e293b;border:1px solid var(--border);
       color:var(--text);padding:12px 18px;border-radius:9px;font-size:.82rem;
       z-index:999;transform:translateY(80px);opacity:0;transition:.3s}
.toast.show{transform:translateY(0);opacity:1}
.toast.success{border-color:var(--green);color:var(--green)}
.toast.error{border-color:var(--red);color:var(--red)}
</style>
</head>
<body>
<div class="sidebar">
  <div class="logo"><h2>🧵 CLOTH COUNTER</h2><p>Factory Dashboard</p></div>
  <nav class="nav">
    <div class="nav-item active" onclick="showPage('live',this)"><span>📡</span> Live View</div>
    <div class="nav-item" onclick="showPage('batches',this)"><span>📦</span> Batches</div>
    <div class="nav-item" onclick="showPage('reports',this)"><span>📊</span> Reports</div>
    <div class="nav-item" onclick="showPage('events',this)"><span>🗃️</span> Raw Events</div>
  </nav>
  <div class="sidebar-footer">
    <span class="pulse"></span>Auto-refresh 5s<br>
    <span id="last-refresh" style="margin-top:4px;display:block"></span>
  </div>
</div>

<div class="main">

<div class="page active" id="page-live">
  <div class="page-header">
    <div class="page-title">Live View <span id="live-sub"></span></div>
  </div>
  <div class="stats-row" id="live-stats"></div>
  <div class="line-grid" id="live-lines"></div>
</div>

<div class="page" id="page-batches">
  <div class="page-header">
    <div class="page-title">Batches</div>
    <div style="display:flex;gap:8px;align-items:center">
      <select id="batch-filter-status" onchange="loadBatches()"
        style="background:#1e293b;border:1px solid #334155;color:#e2e8f0;
               border-radius:7px;padding:7px 12px;font-size:.82rem;outline:none">
        <option value="">All Status</option>
        <option value="active">Active</option>
        <option value="completed">Completed</option>
        <option value="paused">Paused</option>
      </select>
      <button class="btn btn-primary" onclick="openAddBatch()">＋ New Batch</button>
    </div>
  </div>
  <div class="card">
    <div class="card-head">
      <span class="card-title" id="batch-count-label">Batches</span>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>Batch Code</th><th>Line</th><th>Product</th><th>Operator</th>
          <th>Target</th><th>25+26</th><th>Horse Shoe</th><th>Current</th><th>Output</th>
          <th>Progress</th><th>Status</th><th>Started</th><th>Notes</th><th>Actions</th>
        </tr></thead>
        <tbody id="batch-tbody"><tr class="empty-row"><td colspan="14">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<div class="page" id="page-reports">
  <div class="page-header"><div class="page-title">Reports</div></div>
  <div class="filter-bar">
    <div class="filter-row">
      <div class="field"><label>Line</label><select id="r-line"></select></div>
      <div class="field"><label>From</label><input type="datetime-local" id="r-start"></div>
      <div class="field"><label>To</label><input type="datetime-local" id="r-end"></div>
      <button class="btn btn-primary" onclick="runReport()">Run Report</button>
    </div>
  </div>
  <div class="sum-strip" id="report-summary" style="display:none"></div>
  <div class="card" id="report-card" style="display:none">
    <div class="card-head"><span class="card-title">Machine Breakdown</span></div>
    <div class="tbl-wrap"><table>
      <thead><tr>
        <th>Machine</th><th>Type</th><th>Syncs</th>
        <th>Pieces 25+26</th><th>Horse Shoe</th><th>Current Cnt</th>
        <th>Output</th><th>Avg Amps</th><th>From</th><th>To</th>
      </tr></thead>
      <tbody id="report-tbody"></tbody>
    </table></div>
  </div>
</div>

<div class="page" id="page-events">
  <div class="page-header"><div class="page-title">Raw Events</div></div>
  <div class="filter-bar">
    <div class="filter-row">
      <div class="field"><label>Line</label><select id="e-line"></select></div>
      <div class="field"><label>From</label><input type="datetime-local" id="e-start"></div>
      <div class="field"><label>To</label><input type="datetime-local" id="e-end"></div>
      <div class="field"><label>Limit</label>
        <select id="e-limit"><option>100</option><option selected>200</option><option>500</option><option>1000</option></select>
      </div>
      <button class="btn btn-primary" onclick="runEvents()">Load</button>
    </div>
  </div>
  <div class="card">
    <div class="card-head">
      <span class="card-title">Sync Events</span>
      <span id="e-count" style="font-size:.75rem;color:var(--muted)">—</span>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr>
        <th>Time</th><th>Machine</th><th>Type</th>
        <th>25+26</th><th>HorseShoe</th><th>Cur Cnt</th><th>Output</th><th>Amps</th>
      </tr></thead>
      <tbody id="events-tbody"><tr class="empty-row"><td colspan="8">Apply a filter to load events</td></tr></tbody>
    </table></div>
  </div>
</div>

</div>

<div class="overlay" id="modal-overlay">
  <div class="modal">
    <button class="close-btn" onclick="closeModal()">✕</button>
    <h3 id="modal-title">New Batch</h3>
    <div class="form-grid">
      <div class="form-group"><label>Batch Code *</label><input id="m-batchCode" placeholder="BATCH-001"></div>
      <div class="form-group"><label>Line *</label><select id="m-lineId"></select></div>
      <div class="form-group"><label>Product Name *</label><input id="m-product" placeholder="Shirt Type A"></div>
      <div class="form-group"><label>Operator Name *</label><input id="m-operator" placeholder="Operator name"></div>
      <div class="form-group"><label>Target Count *</label><input id="m-target" type="number" placeholder="500"></div>
      <div class="form-group"><label>Status</label>
        <select id="m-status">
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
        </select>
      </div>
      <div class="form-group form-full"><label>Notes</label>
        <textarea id="m-notes" placeholder="Optional notes..."></textarea>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveBatch()">Save Batch</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
function since(iso){if(!iso)return'Never';const s=Math.floor((Date.now()-new Date(iso))/1000);if(s<5)return'Just now';if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';return Math.floor(s/3600)+'h ago'}
function fmt(dt){if(!dt)return'—';return new Date(dt).toLocaleString()}
function toLocal(d){return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}
function pct(a,t){if(!t)return 0;return Math.min(100,Math.round((a/t)*100))}
function progColor(p){if(p>=100)return'#4ade80';if(p>=60)return'#38bdf8';if(p>=30)return'#facc15';return'#f87171'}
let toastTimer;
function showToast(msg,type='success'){const t=document.getElementById('toast');t.textContent=msg;t.className='toast show '+type;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.className='toast'},3000)}

function showPage(name,el){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  el.classList.add('active');
  if(name==='batches')loadBatches();
  if(name==='reports'||name==='events')loadLineSelects();
}

async function fetchLive(){
  try{
    const data=await fetch('/api/lines').then(r=>r.json());
    const total=data.length;
    const online=data.filter(l=>(l.input?.online||l.output?.online)).length;
    document.getElementById('live-sub').textContent=total+' line'+(total!==1?'s':'')+' · '+online+' online';
    document.getElementById('last-refresh').textContent=new Date().toLocaleTimeString();
    let ab=0,s27=0,cur=0,out=0;
    data.forEach(l=>{ab+=l.input?.countAB||0;s27+=l.input?.count27||0;cur+=l.input?.countCur||0;out+=l.output?.countOutput||0});
    document.getElementById('live-stats').innerHTML=\`
      <div class="stat-card"><div class="stat-label">Active Lines</div><div class="stat-value" style="color:var(--green)">\${online}</div><div class="stat-sub">of \${total} total</div></div>
      <div class="stat-card"><div class="stat-label">Pieces 25+26</div><div class="stat-value" style="color:var(--blue)">\${ab}</div><div class="stat-sub">cumulative</div></div>
      <div class="stat-card"><div class="stat-label">Horse Shoe</div><div class="stat-value" style="color:var(--green)">\${s27}</div><div class="stat-sub">cumulative</div></div>
      <div class="stat-card"><div class="stat-label">Current Cycles</div><div class="stat-value" style="color:var(--yellow)">\${cur}</div><div class="stat-sub">cumulative</div></div>
      <div class="stat-card"><div class="stat-label">Output Pieces</div><div class="stat-value" style="color:var(--purple)">\${out}</div><div class="stat-sub">cumulative</div></div>
    \`;
    if(!data.length){document.getElementById('live-lines').innerHTML='<div style="color:var(--muted);margin-top:32px">No machines synced yet.</div>';return}
    document.getElementById('live-lines').innerHTML=data.map(line=>\`
      <div class="line-card">
        <div class="line-head"><span class="line-name">📦 \${line.lineId}</span>
          <span style="font-size:.72rem;color:var(--muted)">\${[line.input,line.output].filter(Boolean).filter(m=>m.online).length}/2 online</span>
        </div>
        <div class="machines-row">\${mbox(line.input,'INPUT')}\${mbox(line.output,'OUTPUT')}</div>
      </div>
    \`).join('');
  }catch(e){console.error(e)}
}

function mbox(m,label){
  if(!m)return\`<div class="machine-box"><div class="m-top"><div><div class="m-label">\${label} MACHINE</div><div class="m-id" style="color:var(--muted)">Not configured</div></div><span class="badge badge-nc">N/C</span></div></div>\`;
  const isIn=label==='INPUT';
  return\`<div class="machine-box">
    <div class="m-top"><div><div class="m-label">\${label} MACHINE</div><div class="m-id">\${m.machineId}</div></div>
    <span class="badge \${m.online?'badge-on':'badge-off'}">\${m.online?'● ONLINE':'● OFFLINE'}</span></div>
    <div class="metrics-mini">
    \${isIn?\`
      <div class="met"><div class="met-v" style="color:var(--blue)">\${m.countAB}</div><div class="met-l">25+26</div></div>
      <div class="met"><div class="met-v" style="color:var(--green)">\${m.count27}</div><div class="met-l">H.Shoe</div></div>
      <div class="met"><div class="met-v" style="color:var(--yellow)">\${m.countCur}</div><div class="met-l">Current</div></div>
      <div class="met"><div class="met-v" style="color:var(--muted)">\${m.currentAmps.toFixed(2)}A</div><div class="met-l">Amps</div></div>
    \`:\`
      <div class="met"><div class="met-v" style="color:var(--purple)">\${m.countOutput}</div><div class="met-l">Output IR</div></div>
      <div class="met"><div class="met-v" style="color:var(--muted)">\${m.currentAmps.toFixed(2)}A</div><div class="met-l">Amps</div></div>
    \`}
    </div>
    <div class="last-seen">Last seen: \${since(m.lastSeen)}</div>
  </div>\`;
}

let editingBatchId=null;
async function loadBatches(){
  const status=document.getElementById('batch-filter-status').value;
  const data=await fetch('/api/batches'+(status?'?status='+status:'')).then(r=>r.json());
  document.getElementById('batch-count-label').textContent=data.length+' batch'+(data.length!==1?'es':'');
  const tbody=document.getElementById('batch-tbody');
  if(!data.length){tbody.innerHTML='<tr class="empty-row"><td colspan="14">No batches. Click "+ New Batch".</td></tr>';return}
  tbody.innerHTML=data.map(b=>{
    const best=Math.max(b.pieces_ab,b.pieces_27,b.pieces_cur);
    const p=pct(best,b.target_count);
    const col=progColor(p);
    return\`<tr>
      <td><strong>\${b.batch_code}</strong></td>
      <td>\${b.line_id}</td><td>\${b.product_name}</td><td>\${b.operator_name}</td>
      <td>\${b.target_count}</td>
      <td style="color:var(--blue)">\${b.pieces_ab}</td>
      <td style="color:var(--green)">\${b.pieces_27}</td>
      <td style="color:var(--yellow)">\${b.pieces_cur}</td>
      <td style="color:var(--purple)">\${b.pieces_out}</td>
      <td><div class="prog-wrap"><div class="prog-bar"><div class="prog-fill" style="width:\${p}%;background:\${col}"></div></div><span class="prog-pct">\${p}%</span></div></td>
      <td><span class="status-\${b.status}">\${b.status}</span></td>
      <td style="font-size:.72rem;color:var(--muted)">\${fmt(b.started_at)}</td>
      <td style="font-size:.72rem;color:var(--muted);max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${b.notes||''}">\${b.notes||'—'}</td>
      <td><div style="display:flex;gap:4px">
        <button class="btn btn-ghost btn-sm" onclick='openEditBatch(\${JSON.stringify(b)})'>Edit</button>
        \${b.status!=='completed'?\`<button class="btn btn-success btn-sm" onclick="completeBatch(\${b.id})">Done</button>\`:''}
        <button class="btn btn-danger btn-sm" onclick="deleteBatch(\${b.id})">Del</button>
      </div></td>
    </tr>\`;
  }).join('');
}

async function loadLineOptions(selId){
  const data=await fetch('/api/lines').then(r=>r.json());
  const sel=document.getElementById(selId);
  sel.innerHTML=data.length
    ? data.map(l=>\`<option value="\${l.lineId}">\${l.lineId}</option>\`).join('')
    : '<option value="">No lines yet</option>';
}

function openAddBatch(){
  editingBatchId=null;
  document.getElementById('modal-title').textContent='New Batch';
  ['m-batchCode','m-product','m-operator','m-notes'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('m-target').value='';
  document.getElementById('m-status').value='active';
  loadLineOptions('m-lineId');
  document.getElementById('modal-overlay').classList.add('open');
}

function openEditBatch(b){
  editingBatchId=b.id;
  document.getElementById('modal-title').textContent='Edit Batch';
  document.getElementById('m-batchCode').value=b.batch_code;
  document.getElementById('m-product').value=b.product_name;
  document.getElementById('m-operator').value=b.operator_name;
  document.getElementById('m-target').value=b.target_count;
  document.getElementById('m-notes').value=b.notes||'';
  document.getElementById('m-status').value=b.status;
  loadLineOptions('m-lineId').then(()=>document.getElementById('m-lineId').value=b.line_id);
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal(){document.getElementById('modal-overlay').classList.remove('open')}

async function saveBatch(){
  const body={
    batchCode:document.getElementById('m-batchCode').value.trim(),
    lineId:document.getElementById('m-lineId').value,
    productName:document.getElementById('m-product').value.trim(),
    operatorName:document.getElementById('m-operator').value.trim(),
    targetCount:parseInt(document.getElementById('m-target').value),
    status:document.getElementById('m-status').value,
    notes:document.getElementById('m-notes').value.trim()
  };
  if(!body.batchCode||!body.productName||!body.operatorName||!body.targetCount)
    return showToast('Fill all required fields','error');
  const url=editingBatchId?'/api/batches/'+editingBatchId:'/api/batches';
  const method=editingBatchId?'PUT':'POST';
  const res=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await res.json();
  if(!res.ok)return showToast(data.error||'Error','error');
  showToast(editingBatchId?'Batch updated':'Batch created');
  closeModal();loadBatches();
}

async function completeBatch(id){
  if(!confirm('Mark as completed?'))return;
  await fetch('/api/batches/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'completed'})});
  showToast('Batch completed');loadBatches();
}

async function deleteBatch(id){
  if(!confirm('Delete this batch?'))return;
  await fetch('/api/batches/'+id,{method:'DELETE'});
  showToast('Batch deleted');loadBatches();
}

async function loadLineSelects(){
  const data=await fetch('/api/lines').then(r=>r.json());
  const opts=data.map(l=>\`<option value="\${l.lineId}">\${l.lineId}</option>\`).join('');
  ['r-line','e-line'].forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML=opts||'<option>No lines</option>'});
  const now=new Date();const start=new Date(now);start.setHours(0,0,0,0);
  ['r-start','e-start'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=toLocal(start)});
  ['r-end','e-end'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=toLocal(now)});
}

async function runReport(){
  const lineId=document.getElementById('r-line').value;
  const start=document.getElementById('r-start').value;
  const end=document.getElementById('r-end').value;
  if(!lineId||!start||!end)return showToast('Fill all fields','error');
  const data=await fetch(\`/api/counts?lineId=\${lineId}&start=\${start}&end=\${end}\`).then(r=>r.json());
  let ab=0,s27=0,cur=0,out=0,syncs=0;
  data.forEach(r=>{ab+=+r.pieces_ab;s27+=+r.pieces_27;cur+=+r.pieces_cur;out+=+r.pieces_output;syncs+=+r.syncs});
  document.getElementById('report-summary').style.display='';
  document.getElementById('report-card').style.display='';
  document.getElementById('report-summary').innerHTML=\`
    <div class="sum-card"><div class="sum-val" style="color:var(--muted)">\${syncs}</div><div class="sum-lbl">Syncs</div></div>
    <div class="sum-card"><div class="sum-val" style="color:var(--blue)">\${ab}</div><div class="sum-lbl">Pieces 25+26</div></div>
    <div class="sum-card"><div class="sum-val" style="color:var(--green)">\${s27}</div><div class="sum-lbl">Horse Shoe</div></div>
    <div class="sum-card"><div class="sum-val" style="color:var(--yellow)">\${cur}</div><div class="sum-lbl">Current</div></div>
    <div class="sum-card"><div class="sum-val" style="color:var(--purple)">\${out}</div><div class="sum-lbl">Output</div></div>
  \`;
  document.getElementById('report-tbody').innerHTML=data.length
    ?data.map(r=>\`<tr>
        <td>\${r.machine_id}</td>
        <td><span class="status-\${r.machine_type==='input'?'active':'completed'}">\${r.machine_type}</span></td>
        <td>\${r.syncs}</td><td style="color:var(--blue)">\${r.pieces_ab}</td>
        <td style="color:var(--green)">\${r.pieces_27}</td><td style="color:var(--yellow)">\${r.pieces_cur}</td>
        <td style="color:var(--purple)">\${r.pieces_output}</td><td>\${r.avg_amps}A</td>
        <td style="font-size:.72rem;color:var(--muted)">\${fmt(r.from_time)}</td>
        <td style="font-size:.72rem;color:var(--muted)">\${fmt(r.to_time)}</td>
      </tr>\`).join('')
    :'<tr class="empty-row"><td colspan="10">No data in this range</td></tr>';
}

async function runEvents(){
  const lineId=document.getElementById('e-line').value;
  const start=document.getElementById('e-start').value;
  const end=document.getElementById('e-end').value;
  const limit=document.getElementById('e-limit').value;
  if(!lineId||!start||!end)return showToast('Fill all fields','error');
  const data=await fetch(\`/api/events?lineId=\${lineId}&start=\${start}&end=\${end}&limit=\${limit}\`).then(r=>r.json());
  document.getElementById('e-count').textContent=data.length+' records';
  document.getElementById('events-tbody').innerHTML=data.length
    ?data.map(e=>\`<tr>
        <td style="font-size:.72rem;color:var(--muted)">\${fmt(e.synced_at)}</td>
        <td>\${e.machine_id}</td>
        <td><span class="status-\${e.machine_type==='input'?'active':'completed'}">\${e.machine_type}</span></td>
        <td style="color:var(--blue)">\${e.count_ab}</td><td style="color:var(--green)">\${e.count_27}</td>
        <td style="color:var(--yellow)">\${e.count_cur}</td><td style="color:var(--purple)">\${e.count_output}</td>
        <td>\${parseFloat(e.current_amps).toFixed(3)}A</td>
      </tr>\`).join('')
    :'<tr class="empty-row"><td colspan="8">No events found</td></tr>';
}

fetchLive();
setInterval(fetchLive,5000);
document.getElementById('modal-overlay').addEventListener('click',function(e){if(e.target===this)closeModal()});
</script>
</body>
</html>`);
});

initDB().then(() => {
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`\n===== CLOTH COUNTER =====`);
        console.log(`http://localhost:${PORT}`);
        console.log(`=========================\n`);
    });
});