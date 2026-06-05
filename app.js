// ===== STATE =====
let currentView = 'date';
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth(); // 0-indexed
let viewYear = currentYear;
let editingRecordId = null;
let currentDayKey = null;
let currentRegType = null;
let numpadStr = '';
let pendingRecordType = 'expense';

// ===== DATA STRUCTURE =====
// records[YYYY-MM-DD]   = [{id, amount, note, type:'expense'|'income', ts}]
// regular[YYYY-MM]      = { expense:{name:amount}, incomePresets:[{name,amount}], invest:[...] }
// manualYears[year]     = { income, expense, balance, investTotal, asset }
//                         any field can be null/undefined = "not set"
//                         if manualYears[year] exists, getYearData/getAsset use it directly (no calculation)
// presets / incomePresets / interestPresets / dividendPresets = global preset name arrays
// dayColors[YYYY-MM-DD] = 'green'|'blue'|'yellow'
// sheetUrl / portfolioCache

function loadData() {
  // Load raw data
  const raw = {
    records:          JSON.parse(localStorage.getItem('records')          || '{}'),
    regular:          JSON.parse(localStorage.getItem('regular')          || '{}'),
    dayColors:        JSON.parse(localStorage.getItem('dayColors')        || '{}'),
    presets:          JSON.parse(localStorage.getItem('presets')          || '["聯邦信用卡","富邦信用卡","玉山房貸繳款","自來水費"]'),
    incomePresets:    JSON.parse(localStorage.getItem('incomePresets')    || '["薪資"]'),
    interestPresets:  JSON.parse(localStorage.getItem('interestPresets')  || '[]'),
    dividendPresets:  JSON.parse(localStorage.getItem('dividendPresets')  || '[]'),
    manualYears:      JSON.parse(localStorage.getItem('manualYears')      || '{}'),
    sheetUrl:         localStorage.getItem('sheetUrl')                    || '',
    portfolioCache:   JSON.parse(localStorage.getItem('portfolioCache')   || '{"rows":[],"updatedAt":""}'),
  };
  // ── Migrate old DB.assets → manualYears (one-time, non-destructive) ──
  const oldAssets = JSON.parse(localStorage.getItem('assets') || '{}');
  for (const [y, v] of Object.entries(oldAssets)) {
    const yr = parseInt(y);
    if (!raw.manualYears[yr]) raw.manualYears[yr] = {};
    // Only migrate asset value if not already set by manualYears
    if (raw.manualYears[yr].asset === undefined) raw.manualYears[yr].asset = v;
  }
  return raw;
}
function saveData(data) {
  localStorage.setItem('records',         JSON.stringify(data.records));
  localStorage.setItem('regular',         JSON.stringify(data.regular));
  localStorage.setItem('dayColors',       JSON.stringify(data.dayColors));
  localStorage.setItem('presets',         JSON.stringify(data.presets));
  localStorage.setItem('incomePresets',   JSON.stringify(data.incomePresets));
  localStorage.setItem('interestPresets', JSON.stringify(data.interestPresets));
  localStorage.setItem('dividendPresets', JSON.stringify(data.dividendPresets));
  localStorage.setItem('manualYears',     JSON.stringify(data.manualYears));
  localStorage.setItem('sheetUrl',        data.sheetUrl || '');
  localStorage.setItem('portfolioCache',  JSON.stringify(data.portfolioCache || {rows:[],updatedAt:''}));
  // Keep old assets key in sync for backward compat (other devices not yet updated)
  const assetCompat = {};
  for (const [y, d] of Object.entries(data.manualYears)) {
    if (d.asset !== undefined && d.asset !== null) assetCompat[y] = d.asset;
  }
  localStorage.setItem('assets', JSON.stringify(assetCompat));
}
let DB = loadData();

// ===== UTILS =====
// Change 1: negative → -NT$xxx  (positive → NT$xxx, no + prefix)
function fmtMoney(n) {
  const abs = Math.abs(n).toLocaleString('zh-TW');
  return (n < 0 ? '-' : '') + 'NT$' + abs;
}
function fmtShort(n) {
  if (n === 0) return '';
  const s = Math.abs(n) >= 10000 ? (Math.abs(n)/1000).toFixed(0)+'k' : Math.abs(n).toLocaleString('zh-TW');
  return (n >= 0 ? '+' : '-') + s;
}
function dayKey(y, m, d)  { return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
function monthKey(y, m)   { return `${y}-${String(m+1).padStart(2,'0')}`; }
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ===== MONTH CALCULATIONS =====
function getMonthData(year, month) {
  let income = 0, expense = 0, interest = 0, dividend = 0, stockGain = 0;

  const daysInMonth = new Date(year, month+1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    for (const r of (DB.records[dayKey(year, month, d)] || [])) {
      if (r.type === 'income') income += r.amount;
      else expense += r.amount;
    }
  }

  const mk  = monthKey(year, month);
  const reg = DB.regular[mk] || {};

  if (reg.expense) {
    for (const v of Object.values(reg.expense)) expense += Number(v) || 0;
  }
  // New income model: list of {name, amount}
  if (reg.incomePresets) {
    for (const item of reg.incomePresets) income += Number(item.amount) || 0;
  } else if (reg.income) {
    income += Number(reg.income) || 0; // backward compat
  }
  if (reg.invest) {
    for (const inv of reg.invest) {
      const amt = Number(inv.amount) || 0;
      if      (inv.type === 'interest')  interest  += amt;
      else if (inv.type === 'dividend')  dividend  += amt;
      else if (inv.type === 'stock') {
        if (inv.direction === 'gain') stockGain += amt;
        else                          stockGain -= amt;
      }
    }
  }
  // New global-preset model for interest/dividend (amounts stored per month)
  if (reg.interestAmounts) {
    for (const v of Object.values(reg.interestAmounts)) interest += Number(v) || 0;
  }
  if (reg.dividendAmounts) {
    for (const v of Object.values(reg.dividendAmounts)) dividend += Number(v) || 0;
  }

  const investTotal = interest + dividend + stockGain;
  const balance     = income + investTotal - expense;
  return { income, expense, balance, interest, dividend, stockGain, investTotal };
}

function getYearData(year) {
  // ── Method A: manual override ──────────────────────────────────
  const m = DB.manualYears[year];
  if (m && (m.income!==undefined||m.expense!==undefined||m.balance!==undefined||m.investTotal!==undefined)) {
    // Fill any missing fields with 0; reconstruct totalIncome
    const income      = Number(m.income)      || 0;
    const expense     = Number(m.expense)     || 0;
    const investTotal = Number(m.investTotal) || 0;
    const balance     = m.balance !== undefined ? Number(m.balance) : (income + investTotal - expense);
    const totalIncome = income + investTotal;
    return { income, expense, balance, investTotal, totalIncome,
             interest:0, dividend:0, stockGain:0, _manual:true };
  }
  // ── Method B: calculate from daily/monthly records ─────────────
  let totIncome=0, totExpense=0, totInterest=0, totDividend=0, totStock=0;
  for (let mo=0; mo<12; mo++) {
    const md = getMonthData(year, mo);
    totIncome   += md.income;
    totExpense  += md.expense;
    totInterest += md.interest;
    totDividend += md.dividend;
    totStock    += md.stockGain;
  }
  const investTotal = totInterest + totDividend + totStock;
  const totalIncome = totIncome + investTotal;
  return { income:totIncome, expense:totExpense, balance:totalIncome-totExpense,
           interest:totInterest, dividend:totDividend, stockGain:totStock, investTotal, totalIncome };
}

function getAsset(year) {
  // If manualYears[year] has an explicit asset value, use it directly
  if (DB.manualYears[year]?.asset !== undefined && DB.manualYears[year].asset !== null)
    return Number(DB.manualYears[year].asset);

  // Otherwise find the nearest anchor year ≤ target year
  // An anchor is any year in manualYears that has an explicit asset value
  const anchorYears = Object.keys(DB.manualYears)
    .map(Number)
    .filter(y => DB.manualYears[y]?.asset !== undefined && DB.manualYears[y].asset !== null)
    .sort((a,b) => a-b);

  const bases = anchorYears.filter(y => y <= year);

  if (!bases.length) {
    // No anchor at all — sum from earliest known year
    const min = Math.min(...getAllRecordYears(), year);
    let a = 0;
    for (let y = min; y <= year; y++) a += getYearData(y).balance;
    return a;
  }

  // Start from the nearest anchor and accumulate non-manual balance years
  const baseYear = Math.max(...bases);
  let a = Number(DB.manualYears[baseYear].asset);
  for (let y = baseYear + 1; y <= year; y++) {
    // If this year also has an explicit asset, jump to it
    if (DB.manualYears[y]?.asset !== undefined && DB.manualYears[y].asset !== null) {
      a = Number(DB.manualYears[y].asset);
    } else {
      a += getYearData(y).balance;
    }
  }
  return a;
}

function getAllRecordYears() {
  const s = new Set();
  for (const k of Object.keys(DB.records))     s.add(parseInt(k.split('-')[0]));
  for (const k of Object.keys(DB.regular))     s.add(parseInt(k.split('-')[0]));
  for (const k of Object.keys(DB.manualYears)) s.add(parseInt(k));
  if (!s.size) s.add(currentYear);
  return [...s].sort();
}

// ===== VIEW SWITCHING =====
function switchView(v) {
  currentView = v;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById('view-'+v).classList.add('active');
  document.querySelectorAll('.top-tabs button').forEach((btn,i) =>
    btn.classList.toggle('active', ['date','month','year','portfolio'][i]===v));
  if (v==='date')            renderCalendar();
  else if (v==='month')      renderMonthView();
  else if (v==='year')       renderYearView();
  else if (v==='portfolio')  renderPortfolioView();
}

// ===== CALENDAR =====
function renderCalendar() {
  const y = currentYear, m = currentMonth;
  // Change 2: year in dark-green via .cal-year class
  document.getElementById('cal-title').innerHTML = `<span class="cal-year">${y}</span> ${m+1}月`;

  const firstDay    = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const today       = new Date();
  const grid        = document.getElementById('cal-grid');
  grid.innerHTML    = '';

  for (let i=0; i<firstDay; i++) {
    const c = document.createElement('div'); c.className='cal-day empty'; grid.appendChild(c);
  }

  for (let d=1; d<=daysInMonth; d++) {
    const dow       = new Date(y,m,d).getDay();
    const isWeekend = dow===0 || dow===6;
    const isToday   = y===today.getFullYear() && m===today.getMonth() && d===today.getDate();
    const k         = dayKey(y,m,d);
    const cell      = document.createElement('div');
    cell.className  = `cal-day${isWeekend?' weekend':''}${isToday?' today':''}${DB.dayColors[k]?' color-'+DB.dayColors[k]:''}`;

    let dayTotal = 0;
    for (const r of (DB.records[k]||[])) dayTotal += r.type==='income' ? r.amount : -r.amount;
    const amountHtml = dayTotal!==0
      ? `<div class="day-amount ${dayTotal>=0?'pos':'neg'}">${fmtShort(dayTotal)}</div>`
      : '';
    cell.innerHTML = `<div class="day-num">${d}</div>${amountHtml}`;
    cell.onclick   = () => openDayModal(y, m, d);
    grid.appendChild(cell);
  }

  const md = getMonthData(y, m);
  document.getElementById('month-stats').innerHTML = `
    <div class="stat-item">
      <div class="stat-label">總收入</div>
      <div class="stat-value" style="color:var(--green)">${fmtMoney(md.income+md.investTotal)}</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">總支出</div>
      <div class="stat-value" style="color:var(--red)">${fmtMoney(md.expense)}</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">結餘</div>
      <div class="stat-value" style="color:${md.balance<0?'var(--red)':'var(--text)'}">${fmtMoney(md.balance)}</div>
    </div>`;
}

function prevMonth() { currentMonth--; if (currentMonth<0)  { currentMonth=11; currentYear--;  } renderCalendar(); }
function nextMonth() { currentMonth++; if (currentMonth>11) { currentMonth=0;  currentYear++;  } renderCalendar(); }
function prevYear()  { viewYear--; renderMonthView(); }
function nextYear()  { viewYear++; renderMonthView(); }

// ===== DAY MODAL =====
function openDayModal(y, m, d) {
  currentDayKey = dayKey(y, m, d);
  document.getElementById('day-modal-title').textContent = `${y}年${m+1}月${d}日`;
  renderDayModalBody();
  document.getElementById('day-modal').style.display = 'flex';
}
function renderDayModalBody() {
  const k        = currentDayKey;
  const recs     = DB.records[k] || [];
  const curColor = DB.dayColors[k] || 'none';
  const body     = document.getElementById('day-modal-body');

  let html = `
    <div class="form-group">
      <div class="form-label">日期標色</div>
      <div class="color-picker">
        <div class="color-opt none   ${curColor==='none'  ?'selected':''}" onclick="setDayColor('none')"   title="無"></div>
        <div class="color-opt green  ${curColor==='green' ?'selected':''}" onclick="setDayColor('green')"  title="淺綠"></div>
        <div class="color-opt blue   ${curColor==='blue'  ?'selected':''}" onclick="setDayColor('blue')"   title="淺藍"></div>
        <div class="color-opt yellow ${curColor==='yellow'?'selected':''}" onclick="setDayColor('yellow')" title="淺黃"></div>
      </div>
    </div>
    <div class="divider"></div>`;

  if (recs.length) {
    html += '<div class="record-list">';
    for (const r of recs) {
      // Change 1: expense shows -NT$xxx in orange, income +NT$xxx in green
      const amtStr = r.type==='income' ? `+${fmtMoney(r.amount)}` : `-${fmtMoney(r.amount)}`;
      html += `
        <div class="record-item">
          <div class="record-item-left">
            <div class="record-item-cat">
              <span class="tag tag-${r.type}">${r.type==='income'?'收入':'支出'}</span>
              ${r.note||'（無備註）'}
            </div>
            <div class="record-item-edit">
              <button class="edit-btn" onclick="editRecord('${r.id}')">編輯</button>
              <button class="del-btn"  onclick="deleteRecord('${r.id}')">刪除</button>
            </div>
          </div>
          <div class="record-item-amount ${r.type}">${amtStr}</div>
        </div>`;
    }
    html += '</div>';
  }
  html += `<button class="add-record-btn" onclick="openRecordForm(null)">＋ 新增記錄</button>`;
  body.innerHTML = html;
}
function closeDayModal(e) {
  if (!e || e.target===document.getElementById('day-modal')) {
    document.getElementById('day-modal').style.display='none';
    renderCalendar();
  }
}
function setDayColor(color) {
  if (color==='none') delete DB.dayColors[currentDayKey];
  else DB.dayColors[currentDayKey]=color;
  saveData(DB); renderDayModalBody();
}
function deleteRecord(id) {
  const k=currentDayKey;
  DB.records[k]=(DB.records[k]||[]).filter(r=>r.id!==id);
  if (!DB.records[k].length) delete DB.records[k];
  saveData(DB); renderDayModalBody(); showToast('已刪除');
}
function editRecord(id) {
  const rec=(DB.records[currentDayKey]||[]).find(r=>r.id===id);
  if (rec) openRecordForm(rec);
}

// ===== RECORD FORM =====
function openRecordForm(rec) {
  editingRecordId   = rec ? rec.id   : null;
  pendingRecordType = rec ? rec.type : 'expense';
  numpadStr         = rec ? String(rec.amount) : '';
  document.getElementById('record-modal-title').textContent = rec ? '編輯記錄' : '新增記錄';
  renderRecordForm(rec);
  document.getElementById('record-modal').style.display='flex';
}
function renderRecordForm(rec) {
  const noteVal = rec ? (rec.note||'') : '';
  document.getElementById('record-modal-body').innerHTML = `
    <div class="form-group">
      <div class="form-label">類型</div>
      <div class="type-toggle">
        <button class="type-btn ${pendingRecordType==='expense'?'active-expense':''}" onclick="setRecordType('expense')">支出</button>
        <button class="type-btn ${pendingRecordType==='income' ?'active-income' :''}" onclick="setRecordType('income')">收入</button>
      </div>
    </div>
    <div class="form-group">
      <div class="form-label">金額</div>
      <div class="amount-display" id="numpad-display">${numpadStr||''}</div>
      <div class="numpad">
        ${[1,2,3,4,5,6,7,8,9,'.',0,'⌫'].map(k=>{
          if (k==='⌫') return `<button class="numpad-btn del" onclick="numpadInput('del')">⌫</button>`;
          return `<button class="numpad-btn" onclick="numpadInput('${k}')">${k}</button>`;
        }).join('')}
      </div>
    </div>
    <div class="form-group">
      <div class="form-label">備註（可空白）</div>
      <input class="form-input" type="text" id="record-note" placeholder="項目名稱..." value="${noteVal}" />
    </div>
    <button class="btn-primary" onclick="saveRecord()">儲存</button>`;
}
function setRecordType(t) { pendingRecordType=t; renderRecordForm(null); }
function numpadInput(k) {
  if (k==='del') numpadStr=numpadStr.slice(0,-1);
  else if (k==='.') { if (!numpadStr.includes('.')) numpadStr+='.'; }
  else { if (numpadStr.length<10) numpadStr+=k; }
  const d=document.getElementById('numpad-display');
  if (d) d.textContent=numpadStr||'';
}
function saveRecord() {
  const amt=parseFloat(numpadStr);
  if (!amt||amt<=0) { showToast('請輸入金額'); return; }
  const note=document.getElementById('record-note')?.value.trim()||'';
  const k=currentDayKey;
  if (!DB.records[k]) DB.records[k]=[];
  if (editingRecordId) {
    const idx=DB.records[k].findIndex(r=>r.id===editingRecordId);
    if (idx>=0) DB.records[k][idx]={...DB.records[k][idx],amount:amt,note,type:pendingRecordType};
  } else {
    DB.records[k].push({id:Date.now().toString(),amount:amt,note,type:pendingRecordType,ts:Date.now()});
  }
  saveData(DB); closeRecordModal(); renderDayModalBody(); showToast('已儲存');
}
function closeRecordModal(e) {
  if (!e||e.target===document.getElementById('record-modal')) {
    document.getElementById('record-modal').style.display='none';
    numpadStr=''; editingRecordId=null;
  }
}

// ===== REGULAR MODAL =====
function openRegModal(type) {
  currentRegType=type;
  const titles={expense:'💳 常態支出', income:'💰 常態收入', invest:'📈 投資項目'};
  document.getElementById('reg-modal-title').textContent=titles[type];
  renderRegModal();
  document.getElementById('reg-modal').style.display='flex';
}

function renderRegModal() {
  const mk   = monthKey(currentYear, currentMonth);
  const reg  = DB.regular[mk] || {};
  const body = document.getElementById('reg-modal-body');

  // ── EXPENSE ──────────────────────────────────────────────────
  if (currentRegType==='expense') {
    let html=`<div class="section-note">管理每月固定支出項目，設定後每月填入金額即可</div>
      <div class="reg-preset-manage">
        <input class="reg-preset-input" type="text" id="new-preset-name" placeholder="新增項目名稱..." />
        <button class="btn-sm add" onclick="addPreset('expense')">新增</button>
      </div>
      <div class="reg-list">`;
    for (const p of DB.presets) {
      const val=reg.expense?(reg.expense[p]||''):'';
      html+=`<div class="reg-item">
        <span class="reg-item-name">${p}</span>
        <input class="reg-item-input" type="number" inputmode="numeric" placeholder="0" value="${val}"
               data-preset="${p}" onchange="updateRegExpense(this)" />
        <button class="btn-sm danger" onclick="removePreset('expense','${p}')">✕</button>
      </div>`;
    }
    html+=`</div><button class="btn-primary" onclick="closeRegModal()">完成</button>`;
    body.innerHTML=html;

  // ── INCOME (Change 4: same list style as expense) ─────────
  } else if (currentRegType==='income') {
    const monthItems=reg.incomePresets||[];
    const getAmt=(name)=>{ const f=monthItems.find(i=>i.name===name); return f?f.amount:''; };

    let html=`<div class="section-note">管理每月常態收入，設定後每月填入金額即可</div>
      <div class="reg-preset-manage">
        <input class="reg-preset-input" type="text" id="new-income-preset-name" placeholder="新增收入項目..." />
        <button class="btn-sm add" onclick="addPreset('income')">新增</button>
      </div>
      <div class="reg-list">`;
    for (const p of DB.incomePresets) {
      const val=getAmt(p);
      html+=`<div class="reg-item">
        <span class="reg-item-name">${p}</span>
        <input class="reg-item-input" type="number" inputmode="numeric" placeholder="0" value="${val}"
               data-preset="${p}" onchange="updateRegIncome(this)" />
        <button class="btn-sm danger" onclick="removePreset('income','${p}')">✕</button>
      </div>`;
    }
    html+=`</div><button class="btn-primary" onclick="closeRegModal()">完成</button>`;
    body.innerHTML=html;

  // ── INVEST: interest & dividend = global preset names + per-month amounts
  //            stock = per-record as before
  } else if (currentRegType==='invest') {
    const invests = reg.invest || [];
    const stockItems = invests.map((inv,i)=>({inv,i})).filter(({inv})=>inv.type==='stock');

    // Per-month amount lookup helpers
    const getIntAmt = (name) => (reg.interestAmounts && reg.interestAmounts[name]) || '';
    const getDivAmt = (name) => (reg.dividendAmounts && reg.dividendAmounts[name]) || '';

    let html = `<div class="section-note">利息＆股利項目全域共用，切換月份仍保留；每月只需填金額</div>`;

    // ── Interest (global presets) ──────────────────────────────
    html += `<div class="invest-group-label">💵 存款利息</div>
      <div class="reg-preset-manage" style="margin-bottom:6px">
        <input class="reg-preset-input" type="text" id="new-interest-name" placeholder="新增利息項目（如：玉山銀行定存）" />
        <button class="btn-sm add" onclick="addInvestPreset('interest')">新增</button>
      </div>
      <div class="reg-list">`;
    for (const name of DB.interestPresets) {
      const val = getIntAmt(name);
      html += `<div class="reg-item">
        <span class="reg-item-name">${name}</span>
        <input class="reg-item-input" type="number" inputmode="numeric" placeholder="0" value="${val}"
               data-name="${name}" data-itype="interest" onchange="updateInvestPresetAmt(this)" />
        <button class="btn-sm danger" onclick="removeInvestPreset('interest','${name}')">✕</button>
      </div>`;
    }
    html += `</div>`;

    // ── Dividend (global presets) ──────────────────────────────
    html += `<div class="invest-group-label" style="margin-top:8px">📊 被動股息</div>
      <div class="reg-preset-manage" style="margin-bottom:6px">
        <input class="reg-preset-input" type="text" id="new-dividend-name" placeholder="新增股息項目（如：台積電2330）" />
        <button class="btn-sm add" onclick="addInvestPreset('dividend')">新增</button>
      </div>
      <div class="reg-list">`;
    for (const name of DB.dividendPresets) {
      const val = getDivAmt(name);
      html += `<div class="reg-item">
        <span class="reg-item-name">${name}</span>
        <input class="reg-item-input" type="number" inputmode="numeric" placeholder="0" value="${val}"
               data-name="${name}" data-itype="dividend" onchange="updateInvestPresetAmt(this)" />
        <button class="btn-sm danger" onclick="removeInvestPreset('dividend','${name}')">✕</button>
      </div>`;
    }
    html += `</div>`;

    // ── Stock (per-record) ──────────────────────────────────────
    html += `<div class="invest-group-label" style="margin-top:8px">📈 股票交易</div>
      <div class="reg-list">`;
    for (const {inv,i} of stockItems) html += renderInvestItem(inv, i);
    html += `</div>
      <div class="invest-add-panel">
        <div class="form-label" style="margin-bottom:8px">新增股票交易</div>
        <div style="margin-bottom:10px">
          <div class="form-label">報酬方向</div>
          <div class="type-toggle">
            <button class="type-btn active-income" id="inv-dir-gain" onclick="selectInvestDir('gain')">正報酬</button>
            <button class="type-btn"               id="inv-dir-loss" onclick="selectInvestDir('loss')">負報酬</button>
          </div>
        </div>
        <div class="form-group">
          <input class="form-input" type="number" inputmode="numeric" id="invest-amount-input" placeholder="金額 NT$" />
        </div>
        <div class="form-group">
          <input class="form-input" type="text" id="invest-note-input" placeholder="備註（可空白，如：台積電2330）" />
        </div>
        <button class="btn-primary" onclick="addStockRecord()">新增交易</button>
      </div>`;
    body.innerHTML = html;
    window._investDir = 'gain';
  } // end invest
} // end renderRegModal

// ── Invest item renderer ─────────────────────────────────────────
function renderInvestItem(inv, i) {
  const typeLabel={interest:'利息',dividend:'股利',stock:'股票交易'}[inv.type]||inv.type;
  const isLoss  = inv.type==='stock' && inv.direction==='loss';
  const dirLabel= inv.type==='stock' ? (inv.direction==='gain'?'正報酬':'負報酬') : '';
  // Change 1: loss shows -NT$xxx
  const amtStr  = isLoss ? `-${fmtMoney(inv.amount)}` : `+${fmtMoney(inv.amount)}`;
  const color   = isLoss ? 'var(--red)' : 'var(--invest-blue)';
  const noteStr = inv.note ? `<div style="font-size:11px;color:var(--text2);margin-top:2px">${inv.note}</div>` : '';
  return `<div class="reg-item">
    <div style="flex:1">
      <div style="font-size:12px;color:var(--text3)">${typeLabel}${dirLabel?' · '+dirLabel:''}</div>
      ${noteStr}
    </div>
    <div class="reg-item-amount" style="color:${color};font-family:var(--mono)">${amtStr}</div>
    <button class="btn-sm danger" onclick="removeInvest(${i})">✕</button>
  </div>`;
}
function selectInvestType(t) {
  window._investType=t;
  document.querySelectorAll('.invest-type-btn').forEach(b=>b.classList.remove('selected'));
  document.getElementById('it-'+t)?.classList.add('selected');
  document.getElementById('invest-direction-row').style.display=t==='stock'?'block':'none';
}
function selectInvestDir(d) {
  window._investDir=d;
  document.getElementById('inv-dir-gain').className='type-btn '+(d==='gain'?'active-income':'');
  document.getElementById('inv-dir-loss').className='type-btn '+(d==='loss'?'active-expense':'');
}
function removeInvest(i) {
  const mk=monthKey(currentYear,currentMonth);
  DB.regular[mk].invest.splice(i,1);
  saveData(DB); renderRegModal();
}
// ── Interest / Dividend global preset helpers ────────────────────
// Add name to global list (persists across all months)
function addInvestPreset(itype) {
  const inputId = itype==='interest' ? 'new-interest-name' : 'new-dividend-name';
  const name    = document.getElementById(inputId)?.value.trim();
  if (!name) { showToast('請輸入項目名稱'); return; }
  const list = itype==='interest' ? DB.interestPresets : DB.dividendPresets;
  if (list.includes(name)) { showToast('項目已存在'); return; }
  list.push(name);
  saveData(DB); renderRegModal(); showToast('已新增');
}
// Remove name from global list
function removeInvestPreset(itype, name) {
  if (itype==='interest') DB.interestPresets = DB.interestPresets.filter(n=>n!==name);
  else                    DB.dividendPresets  = DB.dividendPresets.filter(n=>n!==name);
  saveData(DB); renderRegModal();
}
// Save per-month amount for a named interest/dividend item
function updateInvestPresetAmt(el) {
  const name  = el.getAttribute('data-name');
  const itype = el.getAttribute('data-itype'); // 'interest' or 'dividend'
  const mk    = monthKey(currentYear, currentMonth);
  const val   = parseFloat(el.value);
  if (!DB.regular[mk]) DB.regular[mk] = {};
  const key = itype==='interest' ? 'interestAmounts' : 'dividendAmounts';
  if (!DB.regular[mk][key]) DB.regular[mk][key] = {};
  if (val > 0) DB.regular[mk][key][name] = val;
  else         delete DB.regular[mk][key][name];
  saveData(DB);
}
// Add a stock trade record
function addStockRecord() {
  const amt = parseFloat(document.getElementById('invest-amount-input')?.value);
  if (!amt||amt<=0) { showToast('請輸入金額'); return; }
  const note = document.getElementById('invest-note-input')?.value.trim()||'';
  const mk = monthKey(currentYear, currentMonth);
  if (!DB.regular[mk])        DB.regular[mk]={};
  if (!DB.regular[mk].invest) DB.regular[mk].invest=[];
  DB.regular[mk].invest.push({type:'stock', direction:window._investDir, amount:amt, note});
  saveData(DB); renderRegModal(); showToast('已新增');
}

// ── Expense preset helpers ────────────────────────────────────────
function updateRegExpense(el) {
  const preset=el.getAttribute('data-preset');
  const mk=monthKey(currentYear,currentMonth);
  if (!DB.regular[mk])         DB.regular[mk]={};
  if (!DB.regular[mk].expense) DB.regular[mk].expense={};
  const val=parseFloat(el.value);
  if (val>0) DB.regular[mk].expense[preset]=val;
  else       delete DB.regular[mk].expense[preset];
  saveData(DB);
}

// ── Income preset helpers (Change 4) ────────────────────────────
function updateRegIncome(el) {
  const preset=el.getAttribute('data-preset');
  const mk=monthKey(currentYear,currentMonth);
  if (!DB.regular[mk])               DB.regular[mk]={};
  if (!DB.regular[mk].incomePresets) DB.regular[mk].incomePresets=[];
  const val=parseFloat(el.value);
  const idx=DB.regular[mk].incomePresets.findIndex(i=>i.name===preset);
  if (val>0) {
    if (idx>=0) DB.regular[mk].incomePresets[idx].amount=val;
    else        DB.regular[mk].incomePresets.push({name:preset,amount:val});
  } else {
    if (idx>=0) DB.regular[mk].incomePresets.splice(idx,1);
  }
  saveData(DB);
}

// ── Unified preset management ────────────────────────────────────
function addPreset(kind) {
  const id   = kind==='income'?'new-income-preset-name':'new-preset-name';
  const name = document.getElementById(id)?.value.trim();
  if (!name) return;
  if (kind==='income') {
    if (DB.incomePresets.includes(name)) { showToast('項目已存在'); return; }
    DB.incomePresets.push(name);
  } else {
    if (DB.presets.includes(name)) { showToast('項目已存在'); return; }
    DB.presets.push(name);
  }
  saveData(DB); renderRegModal(); showToast('已新增');
}
function removePreset(kind, name) {
  if (kind==='income') DB.incomePresets=DB.incomePresets.filter(p=>p!==name);
  else                 DB.presets=DB.presets.filter(p=>p!==name);
  saveData(DB); renderRegModal();
}

function closeRegModal(e) {
  if (!e||e.target===document.getElementById('reg-modal')) {
    document.getElementById('reg-modal').style.display='none';
    renderCalendar();
  }
}

// ===== MONTH VIEW =====
// SVG icons (inline, reused across cards)
const ICON_EXPENSE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12,9.256c-1.654,0-3,1.346-3,3s1.346,3,3,3,3-1.346,3-3-1.346-3-3-3Zm0,5c-1.103,0-2-.897-2-2s.897-2,2-2,2,.897,2,2-.897,2-2,2Zm10.11,.609c-.304-.094-1.315-.433-2.48-1.065,.988-.948,1.898-2.176,2.635-3.958,.525-1.269,.158-2.698-.915-3.557l-4.622-3.701c-.641-.512-1.471-.7-2.276-.518-.789,.179-1.438,.689-1.781,1.401-.462,.957-.984,1.708-1.544,2.343-.893-1.244-1.57-2.558-1.992-3.921-.355-1.148-1.346-1.89-2.523-1.89H2C.897,0,0,.897,0,2c0,.872,.564,1.607,1.344,1.88-.217,.32-.344,.705-.344,1.12,0,.872,.564,1.607,1.344,1.88-.217,.32-.344,.705-.344,1.12,0,1.103,.897,2,2,2h1.332c-1.204,.885-2.376,2.014-3.419,3.775-.767,1.296-.453,2.934,.746,3.894l4.671,3.74c.481,.386,1.08,.591,1.692,.591,.157,0,.314-.014,.471-.041,.734-.128,1.372-.554,1.75-1.168,.84-1.367,1.782-2.31,2.756-3.069v2.278c0,1.103,.897,2,2,2,.414,0,.8-.127,1.12-.344,.273,.78,1.009,1.344,1.88,1.344,.414,0,.8-.127,1.12-.344,.273,.78,1.009,1.344,1.88,1.344,1.103,0,2-.897,2-2v-4.611c0-1.178-.742-2.168-1.89-2.523ZM4,9c-.551,0-1-.449-1-1s.449-1,1-1h1.5c.276,0,.5-.224,.5-.5s-.224-.5-.5-.5H3c-.551,0-1-.449-1-1s.449-1,1-1h1.5c.276,0,.5-.224,.5-.5s-.224-.5-.5-.5H2c-.551,0-1-.449-1-1s.449-1,1-1H6.611c.741,0,1.342,.455,1.568,1.186,.471,1.52,1.23,2.98,2.238,4.354-.911,.835-1.904,1.443-2.929,2.063-.217,.131-.434,.263-.652,.397h-2.836Zm6.392,11.268c-.231,.376-.611,.627-1.069,.707-.489,.084-.986-.042-1.367-.346l-4.671-3.74c-.807-.646-1.021-1.741-.511-2.604,1.533-2.59,3.414-3.728,5.232-4.827,2.002-1.211,4.073-2.463,5.565-5.555,.21-.436,.611-.749,1.102-.86,.508-.115,1.03,.002,1.431,.322l4.622,3.701c.722,.579,.97,1.541,.616,2.394-1.386,3.35-3.382,4.557-5.495,5.834-1.877,1.135-3.817,2.308-5.455,4.973Zm12.608,1.732c0,.551-.448,1-1,1s-1-.449-1-1v-2.5c0-.276-.224-.5-.5-.5s-.5,.224-.5,.5v1.5c0,.551-.448,1-1,1s-1-.449-1-1v-2.5c0-.276-.224-.5-.5-.5s-.5,.224-.5,.5v1.5c0,.551-.448,1-1,1s-1-.449-1-1v-2.999c.454-.3,.911-.578,1.364-.851,.827-.5,1.664-1.01,2.469-1.65,1.377,.792,2.626,1.21,2.982,1.32,.731,.227,1.186,.827,1.186,1.568v4.611Z"/></svg>`;
const ICON_INCOME  = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="m23.181,9.655c-.496-.452-1.141-.674-1.809-.652-.67.032-1.288.322-1.739.818l-3.732,4.102c-.314-1.108-1.335-1.922-2.543-1.922h-.261c.559-.582.903-1.37.903-2.237,0-2.777-2.082-5.598-4.487-6.481.467-.317.958-.749,1.3-1.312.243-.4.25-.884.019-1.296-.233-.416-.673-.673-1.146-.673h-3.371c-.474,0-.913.258-1.146.673-.231.412-.225.896.019,1.296.342.563.833.995,1.3,1.312-2.405.883-4.487,3.704-4.487,6.481,0,.889.362,1.696.946,2.281-1.668.266-2.946,1.715-2.946,3.456v5c0,1.93,1.57,3.5,3.5,3.5h5.965c2.707,0,5.292-1.159,7.093-3.181l6.806-7.639c.911-1.022.829-2.604-.183-3.526ZM6.04,1.45c-.073-.121-.031-.231,0-.287.021-.039.105-.164.275-.164h3.371c.17,0,.254.125.275.164.03.055.072.166,0,.287-.521.855-1.562,1.35-1.96,1.514-.398-.165-1.439-.659-1.96-1.514Zm1.96,2.55c2.43,0,5,2.962,5,5.763,0,1.234-1.01,2.237-2.25,2.237h-5.5c-1.24,0-2.25-1.003-2.25-2.237,0-2.801,2.57-5.763,5-5.763Zm14.617,8.516l-6.806,7.639c-1.611,1.809-3.925,2.846-6.347,2.846H3.5c-1.379,0-2.5-1.122-2.5-2.5v-5c0-1.378,1.121-2.5,2.5-2.5h9.857c.905,0,1.643.737,1.643,1.642,0,.812-.606,1.511-1.398,1.624l-6.161.737c-.274.033-.47.282-.437.556.032.274.282.464.556.437l6.173-.739c1.021-.146,1.844-.878,2.145-1.824l4.496-4.94c.271-.298.643-.473,1.046-.492.398-.018.789.12,1.088.393.609.555.658,1.506.11,2.122Z"/></svg>`;
const ICON_BALANCE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M19,12c0,.552-.448,1-1,1s-1-.448-1-1,.448-1,1-1,1,.448,1,1Zm5,.5v3c0,.827-.673,1.5-1.5,1.5h-.213c-.853,1.846-2.389,3.278-4.287,3.997v.503c0,1.379-1.122,2.5-2.5,2.5-1.208,0-2.217-.86-2.45-2h-3.101c-.232,1.14-1.242,2-2.45,2-1.378,0-2.5-1.121-2.5-2.5v-.502C1.688,19.748-.336,16.469,.046,12.897c.134-1.248,.589-2.408,1.279-3.408-.819-.551-1.325-1.479-1.325-2.489,0-1.654,1.346-3,3-3,.276,0,.5,.224,.5,.5s-.224,.5-.5,.5c-1.103,0-2,.897-2,2,0,.7,.364,1.341,.948,1.702,1.486-1.652,3.679-2.702,6.065-2.702h7.118c.343-1.285,1.326-2.303,2.811-2.893,.465-.184,.99-.127,1.402,.153,.411,.279,.657,.743,.657,1.241v3.124c1.121,.873,1.994,2.054,2.497,3.374h.003c.603,0,1.5,.399,1.5,1.5Zm-1,0c0-.401-.273-.494-.504-.5h-.353c-.216,0-.408-.14-.476-.345-.437-1.342-1.312-2.54-2.461-3.375-.13-.094-.207-.244-.207-.404v-3.374c0-.169-.08-.319-.219-.414-.141-.096-.314-.112-.471-.051-.923,.366-2.068,1.107-2.282,2.551-.038,.251-.248,.427-.51,.427l-7.505-.015c-3.549,0-6.612,2.637-6.973,6.003-.344,3.22,1.553,6.166,4.615,7.165,.206,.067,.345,.259,.345,.476v.856c0,.827,.673,1.5,1.5,1.5s1.5-.673,1.5-1.5c0-.276,.224-.5,.5-.5h4c.276,0,.5,.224,.5,.5,0,.827,.673,1.5,1.5,1.5s1.5-.673,1.5-1.5v-.856c0-.217,.139-.408,.345-.476,1.885-.614,3.398-2.021,4.152-3.857,.077-.188,.26-.311,.462-.311h.541c.276,0,.5-.225,.5-.5v-3ZM6.5,4.5c.276,0,.5-.224,.5-.5,0-1.654,1.346-3,3-3s3,1.346,3,3c0,.276,.224,.5,.5,.5s.5-.224,.5-.5c0-2.206-1.794-4-4-4S6,1.794,6,4c0,.276,.224,.5,.5,.5Z"/></svg>`;
const ICON_INVEST  = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M13.83,5.268c1.11-.592,2.461-1.581,3.06-3.087,.193-.486,.133-1.018-.166-1.458-.307-.453-.815-.724-1.36-.724h-6.728c-.544,0-1.053,.271-1.36,.724-.299,.44-.359,.972-.167,1.458,.599,1.506,1.95,2.495,3.06,3.087C5.238,6.62,1,13.094,1,18.25c0,3.17,2.58,5.75,5.75,5.75h10.5c3.17,0,5.75-2.58,5.75-5.75,0-5.156-4.238-11.63-9.17-12.982ZM8.039,1.812c-.094-.236,0-.432,.064-.526,.121-.179,.32-.285,.533-.285h6.728c.212,0,.412,.106,.533,.285,.064,.095,.158,.29,.064,.527-.788,1.982-3.337,2.952-3.961,3.163-.625-.21-3.169-1.174-3.96-3.164Zm9.211,21.188H6.75c-2.619,0-4.75-2.131-4.75-4.75,0-5.349,4.849-12.25,10-12.25s10,6.901,10,12.25c0,2.619-2.131,4.75-4.75,4.75Zm-1.25-5.626c0,1.448-1.178,2.626-2.626,2.626h-.874v1.5c0,.276-.224,.5-.5,.5s-.5-.224-.5-.5v-1.5h-.926c-.979,0-1.891-.526-2.381-1.374-.139-.239-.057-.545,.182-.683,.239-.14,.544-.057,.683,.182,.312,.54,.894,.875,1.516,.875h2.8c.896,0,1.626-.729,1.626-1.626,0-.803-.575-1.478-1.368-1.605l-3.422-.55c-1.28-.206-2.209-1.296-2.209-2.593,0-1.448,1.178-2.626,2.626-2.626h.874v-1.5c0-.276,.224-.5,.5-.5s.5,.224,.5,.5v1.5h.926c.978,0,1.891,.527,2.381,1.375,.139,.239,.057,.545-.182,.683-.241,.138-.544,.056-.683-.182-.312-.54-.894-.875-1.516-.875h-2.8c-.896,0-1.626,.729-1.626,1.626,0,.803,.575,1.478,1.368,1.605l3.422,.55c1.28,.206,2.209,1.296,2.209,2.593Z"/></svg>`;
const ICON_INTEREST= `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="m17.477 6c-3.72 0-6.524 1.29-6.524 3v6.294c-1.053-.792-2.851-1.294-4.976-1.294-3.407 0-5.977 1.29-5.977 3v4c0 1.71 2.569 3 5.977 3 2.534 0 4.603-.715 5.497-1.785.976 1.07 3.235 1.785 6.003 1.785 3.719 0 6.523-1.29 6.523-3v-12c0-1.71-2.805-3-6.523-3zm5.523 11c0 .944-2.362 2-5.523 2s-5.524-1.056-5.524-2v-2.364c1.134.832 3.139 1.364 5.524 1.364s4.389-.532 5.523-1.364zm0-4c0 .944-2.362 2-5.523 2s-5.524-1.056-5.524-2v-2.364c1.134.832 3.139 1.364 5.524 1.364s4.389-.532 5.523-1.364zm-5.523-6c3.161 0 5.523 1.056 5.523 2s-2.362 2-5.523 2-5.524-1.056-5.524-2 2.362-2 5.524-2zm-11.5 8c2.933 0 4.976 1.054 4.976 2s-2.043 2-4.976 2c-2.849 0-4.977-1.056-4.977-2s2.128-2 4.977-2zm0 8c-2.849 0-4.977-1.056-4.977-2v-2.294c1.053.792 2.852 1.294 4.977 1.294s3.922-.502 4.976-1.294v2.294c0 .946-2.043 2-4.976 2zm11.5 0c-3.162 0-5.524-1.056-5.524-2v-2.364c1.134.832 3.139 1.364 5.524 1.364s4.389-.532 5.523-1.364v2.364c0 .944-2.362 2-5.523 2zm-12.351-16.499c.125 0 .24-.002.344-.006l.03 4.009c.002.275.226.496.5.496h.004c.276-.002.498-.228.496-.504l-.03-4.004c.12.005.252.009.404.009 1.085 0 2.894-.17 3.925-1.202.974-.973 1.19-2.621 1.201-3.832.004-.393-.147-.763-.425-1.041-.278-.278-.659-.425-1.041-.426-1.211.011-2.858.228-3.833 1.201-.303.303-.529.675-.701 1.074-.172-.399-.398-.771-.701-1.074-.975-.973-2.622-1.19-3.833-1.201-.398-.008-.764.148-1.041.426-.277.278-.429.648-.425 1.041.011 1.211.228 2.859 1.201 3.832 1.031 1.031 2.84 1.202 3.925 1.202zm2.282-4.593c.773-.773 2.296-.901 3.134-.908h.004c.122 0 .236.047.321.133.087.086.134.202.133.325-.007.839-.135 2.361-.908 3.134-.832.832-2.603.946-3.587.903-.006-.139-.005-.299-.006-.448.01-1.004.188-2.418.909-3.139zm-6.275-.775c.085-.086.199-.133.321-.133h.004c.838.007 2.36.135 3.134.908.725.725.902 2.164.909 3.171-.001.139 0 .29-.006.415-.982.043-2.754-.07-3.586-.903-.773-.773-.901-2.295-.908-3.134 0-.123.046-.239.133-.325z"/></svg>`;
const ICON_STOCK   = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M13.83,5.268c1.11-.592,2.461-1.581,3.06-3.087,.193-.486,.133-1.018-.166-1.458-.307-.453-.815-.724-1.36-.724h-6.728c-.544,0-1.053,.271-1.36,.724-.299,.44-.359,.972-.167,1.458,.599,1.506,1.95,2.495,3.06,3.087C5.238,6.62,1,13.094,1,18.25c0,3.17,2.58,5.75,5.75,5.75h10.5c3.17,0,5.75-2.58,5.75-5.75,0-5.156-4.238-11.63-9.17-12.982ZM8.039,1.812c-.094-.236,0-.432,.064-.526,.121-.179,.32-.285,.533-.285h6.728c.212,0,.412,.106,.533,.285,.064,.095,.158,.29,.064,.527-.788,1.982-3.337,2.952-3.961,3.163-.625-.21-3.169-1.174-3.96-3.164Zm9.211,21.188H6.75c-2.619,0-4.75-2.131-4.75-4.75,0-5.349,4.849-12.25,10-12.25s10,6.901,10,12.25c0,2.619-2.131,4.75-4.75,4.75Zm-1.25-5.626c0,1.448-1.178,2.626-2.626,2.626h-.874v1.5c0,.276-.224,.5-.5,.5s-.5-.224-.5-.5v-1.5h-.926c-.979,0-1.891-.526-2.381-1.374-.139-.239-.057-.545,.182-.683,.239-.14,.544-.057,.683,.182,.312,.54,.894,.875,1.516,.875h2.8c.896,0,1.626-.729,1.626-1.626,0-.803-.575-1.478-1.368-1.605l-3.422-.55c-1.28-.206-2.209-1.296-2.209-2.593,0-1.448,1.178-2.626,2.626-2.626h.874v-1.5c0-.276,.224-.5,.5-.5s.5,.224,.5,.5v1.5h.926c.978,0,1.891,.527,2.381,1.375,.139,.239,.057,.545-.182,.683-.241,.138-.544,.056-.683-.182-.312-.54-.894-.875-1.516-.875h-2.8c-.896,0-1.626,.729-1.626,1.626,0,.803,.575,1.478,1.368,1.605l3.422,.55c1.28,.206,2.209,1.296,2.209,2.593Z"/></svg>`;

// Calendar SVG with month number embedded
function calIconSvg(monthNum) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#c8bfb5" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 2v4"/><path d="M16 2v4"/>
    <rect width="18" height="18" x="3" y="4" rx="2"/>
    <path d="M3 10h18"/>
    <text x="12" y="19.5" font-size="7" font-family="'Noto Sans TC',sans-serif" font-weight="700" fill="#a09488" stroke="none" text-anchor="middle">${monthNum}</text>
  </svg>`;
}

// Donut chart — correct formula: income/(income+expense), expense/(income+expense)
// Green=收入, Orange=支出; no centre text, icon-sized by default
function donutSvg(incomePct, expensePct, size=36) {
  const r      = size * 0.36, cx = size/2, cy = size/2;
  const circ   = 2 * Math.PI * r;
  const strokeW = size * 0.18;
  const iDash  = (incomePct  / 100) * circ;
  const eDash  = (expensePct / 100) * circ;
  const eOffset = circ/4 - iDash;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e8e2da" stroke-width="${strokeW}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#2d8a3e"
      stroke-width="${strokeW}" stroke-dasharray="${iDash} ${circ-iDash}"
      stroke-dashoffset="${circ/4}" stroke-linecap="butt"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#c96a10"
      stroke-width="${strokeW}" stroke-dasharray="${eDash} ${circ-eDash}"
      stroke-dashoffset="${eOffset}" stroke-linecap="butt"/>
  </svg>`;
}

function summaryIconCell(iconSvg, bgColor, iconColor) {
  return `<div class="sum-icon-circle" style="background:${bgColor}">
    <div class="sum-icon-svg" style="color:${iconColor}">${iconSvg}</div>
  </div>`;
}

function renderMonthView() {
  document.getElementById('month-year-title').innerHTML=`<span class="cal-year">${viewYear}</span>年`;
  const grid  = document.getElementById('months-grid');
  const today = new Date();
  grid.innerHTML = '';

  for (let m = 0; m < 12; m++) {
    const md        = getMonthData(viewYear, m);
    const isCurrent = viewYear===today.getFullYear() && m===today.getMonth();
    const balColor  = md.balance < 0 ? '#b03020' : '#1e6e2e';
    const balStr    = md.balance < 0 ? `-${fmtMoney(Math.abs(md.balance))}` : fmtMoney(md.balance);
    const hasData   = md.balance !== 0 || md.income !== 0 || md.expense !== 0;
    const card      = document.createElement('div');
    card.className  = `month-card${isCurrent?' current-month':''}`;
    card.innerHTML  = `
      <div class="mc-icon">${calIconSvg(m+1)}</div>
      <div class="mc-balance" style="color:${balColor}">${hasData ? balStr : '—'}</div>
      ${md.investTotal ? `<div class="mc-invest">${md.investTotal>=0?'+':''}${fmtShort(md.investTotal)}</div>` : ''}`;
    card.onclick = () => openMonthDetail(viewYear, m);
    grid.appendChild(card);
  }

  // ── Year summary ──────────────────────────────────────────────
  const yd          = getYearData(viewYear);
  const base        = yd.income + yd.expense;   // denominator for donut
  const incomeRatio = yd.totalIncome > 0 ? (yd.expense / yd.totalIncome * 100).toFixed(1) : 0;
  const saveRatio   = yd.totalIncome > 0 ? (yd.balance / yd.totalIncome * 100).toFixed(1) : 0;
  // Corrected %: income/(income+expense), expense/(income+expense)
  const incPct      = base > 0 ? Math.min(yd.income  / base * 100, 100) : 0;
  const expPct      = base > 0 ? Math.min(yd.expense / base * 100, 100) : 0;

  // colour helpers
  const DEEP_BLUE = '#213971';
  const DARK      = '#4a4a4a';

  document.getElementById('year-summary').innerHTML = `
    <div class="summary-title">${viewYear} 年度總計</div>
    <div class="sum-grid">

      <!-- 年度總開銷 -->
      <div class="sum-card">
        <div class="sum-card-inner">
          ${summaryIconCell(ICON_EXPENSE,'#fef3e6','#c96a10')}
          <div class="sum-card-content">
            <div class="sum-card-label">年度總開銷 <span class="ratio-badge">${incomeRatio}%</span></div>
            <div class="sum-card-val red">${fmtMoney(yd.expense)}</div>
          </div>
        </div>
      </div>

      <!-- 年收入 (綠色圖示, 深黑數字) -->
      <div class="sum-card">
        <div class="sum-card-inner">
          ${summaryIconCell(ICON_INCOME,'#eaf6ec','#2d8a3e')}
          <div class="sum-card-content">
            <div class="sum-card-label">年收入（含投資）</div>
            <div class="sum-card-val" style="color:${DARK}">${fmtMoney(yd.totalIncome)}</div>
          </div>
        </div>
      </div>

      <!-- 年度剩餘 (綠色圖示, 深黑數字) -->
      <div class="sum-card">
        <div class="sum-card-inner">
          ${summaryIconCell(ICON_BALANCE,'#eaf6ec','#2d8a3e')}
          <div class="sum-card-content">
            <div class="sum-card-label">年度剩餘存款 <span class="ratio-badge">${saveRatio}%</span></div>
            <div class="sum-card-val ${yd.balance<0?'red':''}" style="${yd.balance>=0?'color:'+DARK:''}">${fmtMoney(yd.balance)}</div>
          </div>
        </div>
      </div>

      <!-- 收支圓餅圖 -->
      <div class="sum-card">
        <div class="sum-card-inner" style="gap:10px;align-items:center">
          ${donutSvg(parseFloat(incPct.toFixed(0)), parseFloat(expPct.toFixed(0)))}
          <div style="display:flex;flex-direction:column;gap:6px;justify-content:center">
            <div style="display:flex;align-items:center;gap:5px;font-size:10px;color:var(--text2)">
              <span style="width:8px;height:8px;border-radius:50%;background:#2d8a3e;flex-shrink:0"></span>
              收入 <b style="font-family:var(--mono);margin-left:3px">${incPct.toFixed(0)}%</b>
            </div>
            <div style="display:flex;align-items:center;gap:5px;font-size:10px;color:var(--text2)">
              <span style="width:8px;height:8px;border-radius:50%;background:#c96a10;flex-shrink:0"></span>
              支出 <b style="font-family:var(--mono);margin-left:3px">${expPct.toFixed(0)}%</b>
            </div>
          </div>
        </div>
      </div>

      <!-- 年總投資報酬 -->
      <div class="sum-card">
        <div class="sum-card-inner">
          ${summaryIconCell(ICON_INVEST,'#eef2fb','#213971')}
          <div class="sum-card-content">
            <div class="sum-card-label">年總投資報酬</div>
            <div class="sum-card-val" style="color:${DEEP_BLUE}">${fmtMoney(yd.investTotal)}</div>
          </div>
        </div>
      </div>

      <!-- 年利息 -->
      <div class="sum-card">
        <div class="sum-card-inner">
          ${summaryIconCell(ICON_INTEREST,'#eef2fb','#213971')}
          <div class="sum-card-content">
            <div class="sum-card-label">年利息</div>
            <div class="sum-card-val" style="color:${DEEP_BLUE}">${fmtMoney(yd.interest)}</div>
          </div>
        </div>
      </div>

      <!-- 年股息 -->
      <div class="sum-card">
        <div class="sum-card-inner">
          ${summaryIconCell(ICON_INTEREST,'#eef2fb','#213971')}
          <div class="sum-card-content">
            <div class="sum-card-label">年股息</div>
            <div class="sum-card-val" style="color:${DEEP_BLUE}">${fmtMoney(yd.dividend)}</div>
          </div>
        </div>
      </div>

      <!-- 年獲利(股票) -->
      <div class="sum-card">
        <div class="sum-card-inner">
          ${summaryIconCell(ICON_STOCK,'#eef2fb','#213971')}
          <div class="sum-card-content">
            <div class="sum-card-label">年獲利（股票）</div>
            <div class="sum-card-val ${yd.stockGain<0?'red':''}" style="${yd.stockGain>=0?'color:'+DEEP_BLUE:''}">${fmtMoney(yd.stockGain)}</div>
          </div>
        </div>
      </div>

    </div>`;
}

// Change 3: Month detail – renamed labels + colour per spec
function openMonthDetail(y, m) {
  const md=getMonthData(y,m);
  document.getElementById('month-detail-title').textContent=`${y}年${m+1}月 詳細`;
  const body=document.getElementById('month-detail-body');

  // [label, value, colorVar]
  const rows=[
    ['每月常態收入',   md.income,      'var(--green)'],
    ['每月支出總和',   md.expense,     'var(--red)'],
    ['每月存款利息',   md.interest,    'var(--invest-blue)'],
    ['每月被動股息',   md.dividend,    'var(--invest-blue)'],
    ['每月市場獲利',   md.stockGain,   md.stockGain<0?'var(--red)':'var(--invest-blue)'],
    ['每月投資總獲利', md.investTotal, md.investTotal<0?'var(--red)':'var(--invest-blue)'],
    ['每月總餘額',     md.balance,     md.balance<0?'var(--red)':'var(--text)'],
  ];

  body.innerHTML=rows.map(([label,val,colorVar])=>`
    <div class="month-detail-row">
      <span class="month-detail-label">${label}</span>
      <span class="month-detail-value" style="color:${colorVar}">${fmtMoney(val)}</span>
    </div>`).join('');

  document.getElementById('month-detail-modal').style.display='flex';
}
function closeMonthDetailModal(e) {
  if (!e||e.target===document.getElementById('month-detail-modal'))
    document.getElementById('month-detail-modal').style.display='none';
}

// ===== YEAR VIEW =====
function renderYearView() {
  const years  = getAllRecordYears();
  const tableEl = document.getElementById('year-table');
  const irrList = [];

  // Build card list instead of table
  let cardsHtml = '';
  for (const y of years) {
    const yd    = getYearData(y);
    const asset = getAsset(y);
    const base  = asset - yd.investTotal;
    const irr   = base > 0 ? (yd.investTotal / base * 100) : 0;
    irrList.push(irr);

    const assetColor  = '#213971';
    const investColor = yd.investTotal < 0 ? '#b03020' : '#213971';
    const balColor    = yd.balance < 0    ? '#b03020' : '#1e6e2e';
    const irrColor    = irr < 0           ? '#b03020' : '#213971';

    cardsHtml += `
    <div class="yr-card" id="yr-card-${y}">
      <!-- Main row (always visible) -->
      <div class="yr-main" onclick="toggleYrDetail(${y})">
        <div class="yr-main-year">${y}</div>
        <div class="yr-main-col">
          <div class="yr-col-label">資產</div>
          <div class="yr-col-val" style="color:${assetColor}">${fmtMoney(asset)}</div>
        </div>
        <div class="yr-main-col">
          <div class="yr-col-label">年投資報酬</div>
          <div class="yr-col-val" style="color:${investColor}">${fmtMoney(yd.investTotal)}</div>
        </div>
        <div class="yr-main-col">
          <div class="yr-col-label">IRR</div>
          <div class="yr-col-val" style="color:${irrColor}">${irr.toFixed(2)}%</div>
        </div>
        <div class="yr-chevron" id="yr-chev-${y}">▼</div>
      </div>
      <!-- Detail row (hidden by default) -->
      <div class="yr-detail" id="yr-detail-${y}" style="display:none">
        <div class="yr-detail-grid">
          <div class="yr-detail-item">
            <div class="yr-col-label">年收入</div>
            <div class="yr-col-val" style="color:#1e6e2e">${fmtMoney(yd.totalIncome)}</div>
          </div>
          <div class="yr-detail-item">
            <div class="yr-col-label">年度開銷</div>
            <div class="yr-col-val" style="color:#b03020">${fmtMoney(yd.expense)}</div>
          </div>
          <div class="yr-detail-item">
            <div class="yr-col-label">年度剩餘</div>
            <div class="yr-col-val" style="color:${balColor}">${fmtMoney(yd.balance)}</div>
          </div>
        </div>
      </div>
    </div>`;
  }

  // Replace table with card list
  tableEl.innerHTML = '';
  tableEl.style.display = 'none';

  // Remove old card container if exists
  let cardContainer = document.getElementById('yr-card-container');
  if (cardContainer) cardContainer.remove();
  cardContainer = document.createElement('div');
  cardContainer.id = 'yr-card-container';
  cardContainer.style.cssText = 'padding:10px 12px 4px';
  cardContainer.innerHTML = cardsHtml;
  tableEl.parentElement.insertBefore(cardContainer, tableEl);

  // IRR average + buttons bar
  const avgIrr = irrList.length ? (irrList.reduce((s,v)=>s+v,0)/irrList.length).toFixed(2) : 0;
  const existingMeta = document.getElementById('year-meta');
  if (existingMeta) existingMeta.remove();
  const meta = document.createElement('div');
  meta.id = 'year-meta';
  meta.style.cssText = 'padding:8px 12px 16px;font-size:12px;color:var(--text2);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px';
  meta.innerHTML = `
    <span>歷年 IRR 平均：<b style="color:#213971;font-family:var(--mono);font-size:14px">${avgIrr}%</b></span>
    <div style="display:flex;gap:8px">
      <button onclick="openManualYearModal()" style="padding:8px 14px;background:var(--bg3);border:1px solid var(--border);color:var(--text2);border-radius:var(--radius-sm);font-family:var(--font);font-size:12px;font-weight:600;cursor:pointer">✏️ 輸入歷史資料</button>
      <button onclick="openAssetChart()" style="padding:8px 14px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-sm);font-family:var(--font);font-size:12px;font-weight:700;cursor:pointer">📈 資產線圖</button>
    </div>`;
  tableEl.parentElement.appendChild(meta);
}

function toggleYrDetail(y) {
  const detail = document.getElementById(`yr-detail-${y}`);
  const chev   = document.getElementById(`yr-chev-${y}`);
  if (!detail) return;
  const open = detail.style.display === 'none';
  detail.style.display = open ? 'block' : 'none';
  if (chev) chev.style.transform = open ? 'rotate(180deg)' : 'rotate(0deg)';
}

function openManualYearModal() {
  renderManualYearModalBody();
  document.getElementById('manual-year-modal').style.display = 'flex';
}
function closeManualYearModal(e) {
  if (!e || e.target === document.getElementById('manual-year-modal')) {
    document.getElementById('manual-year-modal').style.display = 'none';
    renderYearView(); // refresh table after edits
  }
}
function renderManualYearModalBody() {
  const body = document.getElementById('manual-year-modal-body');
  body.innerHTML = `
    <div style="font-size:11px;color:var(--text3);margin-bottom:12px;line-height:1.6">
      直接輸入過往年度總和，填入的年份優先以此資料為準，不從日期/月份計算
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      <div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:3px">年份 *</div>
        <input id="my-year"    class="form-input" type="number" placeholder="2022" style="padding:8px;font-size:14px"/>
      </div>
      <div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:3px">資產（期末）</div>
        <input id="my-asset"   class="form-input" type="number" placeholder="NT$" style="padding:8px;font-size:14px"/>
      </div>
      <div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:3px">年收入</div>
        <input id="my-income"  class="form-input" type="number" placeholder="NT$" style="padding:8px;font-size:14px"/>
      </div>
      <div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:3px">年度開銷</div>
        <input id="my-expense" class="form-input" type="number" placeholder="NT$" style="padding:8px;font-size:14px"/>
      </div>
      <div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:3px">年度剩餘（可留空）</div>
        <input id="my-balance" class="form-input" type="number" placeholder="空白=自動計算" style="padding:8px;font-size:13px"/>
      </div>
      <div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:3px">年總投資報酬</div>
        <input id="my-invest"  class="form-input" type="number" placeholder="NT$" style="padding:8px;font-size:14px"/>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px">
      <button class="btn-primary" style="margin-top:0;flex:1" onclick="saveManualYear()">儲存</button>
      <button onclick="openDeleteManualYear()" style="padding:10px 14px;background:var(--red-bg);border:1px solid var(--red);color:var(--red);border-radius:var(--radius-sm);font-family:var(--font);font-size:13px;cursor:pointer">刪除年份</button>
    </div>
    <div class="divider"></div>
    <div id="manual-year-list" style="margin-top:10px"></div>`;
  renderManualYearList();
}

function renderManualYearList() {
  const el = document.getElementById('manual-year-list');
  if (!el) return;
  const entries = Object.entries(DB.manualYears)
    .filter(([,d]) => d._manual || d.asset!==undefined || d.income!==undefined)
    .sort(([a],[b]) => a - b);
  if (!entries.length) { el.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:8px 0">尚無手動資料</div>'; return; }
  el.innerHTML = `<div style="font-size:10px;color:var(--text3);margin-bottom:8px;text-transform:uppercase;letter-spacing:.4px">已儲存年份</div>` +
    entries.map(([y, d]) => {
      const parts = [];
      if (d.income      !== undefined) parts.push(`收入 ${fmtMoney(d.income)}`);
      if (d.expense     !== undefined) parts.push(`開銷 ${fmtMoney(d.expense)}`);
      if (d.asset       !== undefined) parts.push(`資產 ${fmtMoney(d.asset)}`);
      if (d.investTotal !== undefined) parts.push(`投資 ${fmtMoney(d.investTotal)}`);
      return `<div style="display:flex;align-items:center;gap:6px;padding:7px 0;border-bottom:1px solid var(--border)">
        <b style="font-size:14px;color:var(--accent);min-width:44px">${y}</b>
        <span style="flex:1;font-size:10px;color:var(--text2);line-height:1.5">${parts.join('<br>')}</span>
        <button class="btn-sm danger" onclick="deleteManualYear(${y})" style="font-size:10px;padding:3px 8px">✕</button>
      </div>`;
    }).join('');
}

function saveManualYear() {
  const y = parseInt(document.getElementById('my-year')?.value);
  if (!y || y < 1900 || y > 2100) { showToast('請輸入有效年份'); return; }
  const income      = parseInput('my-income');
  const expense     = parseInput('my-expense');
  const balance     = parseInput('my-balance');
  const investTotal = parseInput('my-invest');
  const asset       = parseInput('my-asset');
  if (income===null && expense===null && asset===null && investTotal===null) {
    showToast('請至少填入一個欄位'); return;
  }
  if (!DB.manualYears[y]) DB.manualYears[y] = {};
  if (income      !== null) DB.manualYears[y].income      = income;
  if (expense     !== null) DB.manualYears[y].expense     = expense;
  if (balance     !== null) DB.manualYears[y].balance     = balance;
  if (investTotal !== null) DB.manualYears[y].investTotal = investTotal;
  if (asset       !== null) DB.manualYears[y].asset       = asset;
  DB.manualYears[y]._manual = true;
  saveData(DB);
  ['my-year','my-income','my-expense','my-balance','my-invest','my-asset']
    .forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  renderManualYearList();
  showToast(`✅ ${y} 年資料已儲存`);
}

function deleteManualYear(y) {
  if (!confirm(`確定刪除 ${y} 年的手動資料？`)) return;
  delete DB.manualYears[y];
  saveData(DB);
  renderManualYearList();
  showToast('已刪除');
}
function openDeleteManualYear() {
  const y = parseInt(document.getElementById('my-year')?.value);
  if (!y || !DB.manualYears[y]) { showToast('請先輸入要刪除的年份'); return; }
  deleteManualYear(y);
}

// ── Asset line chart ─────────────────────────────────────────────
function openAssetChart() {
  const years = getAllRecordYears();
  const data  = years.map(y => ({ y, asset: getAsset(y), irr: (() => {
    const yd = getYearData(y);
    const base = getAsset(y) - yd.investTotal;
    return base > 0 ? (yd.investTotal / base * 100) : 0;
  })() }));
  const avgIrr = data.length ? (data.reduce((s,d)=>s+d.irr,0)/data.length).toFixed(2) : 0;

  const body = document.getElementById('asset-chart-body');
  body.innerHTML = `
    <div style="font-size:12px;color:var(--text2);margin-bottom:10px;text-align:center">
      歷年 IRR 平均：<b style="color:var(--invest-blue);font-family:var(--mono);font-size:15px">${avgIrr}%</b>
    </div>
    <div style="overflow-x:auto">
      <canvas id="asset-line-canvas" height="220"></canvas>
    </div>
    <div id="asset-chart-legend" style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px;justify-content:center"></div>`;

  document.getElementById('asset-chart-modal').style.display = 'flex';

  requestAnimationFrame(() => {
    const canvas = document.getElementById('asset-line-canvas');
    if (!canvas) return;
    const containerW = canvas.parentElement.clientWidth - 8;
    // Set logical CSS size (drawAssetLine will apply DPR internally)
    const logW = Math.max(containerW, years.length * 52);
    const logH = 220;
    canvas.width  = logW;
    canvas.height = logH;
    drawAssetLine(canvas, data);

    // Legend: each year's IRR
    const legend = document.getElementById('asset-chart-legend');
    legend.innerHTML = data.map(d =>
      `<div style="font-size:10px;color:var(--text3);text-align:center">
        <b style="color:var(--text)">${d.y}</b><br>
        <span style="font-family:var(--mono);color:var(--invest-blue)">${d.irr.toFixed(1)}%</span>
      </div>`
    ).join('');
  });
}

function drawAssetLine(canvas, data) {
  if (!data.length) return;
  const dpr  = window.devicePixelRatio || 1;
  const W    = canvas.width;
  const H    = canvas.height;
  // Scale canvas buffer for retina/high-DPI — keeps CSS size the same
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const PAD    = { top:28, right:18, bottom:38, left:72 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;

  const assets = data.map(d => d.asset);
  const minA   = Math.min(...assets) * 0.92;
  const maxA   = Math.max(...assets) * 1.06;
  const yScale = v => PAD.top + chartH - ((v - minA) / (maxA - minA || 1)) * chartH;
  const xScale = i => PAD.left + (data.length > 1 ? (i / (data.length - 1)) * chartW : chartW / 2);

  ctx.clearRect(0, 0, W, H);

  // Grid lines + Y labels
  const gridCount = 4;
  for (let i = 0; i <= gridCount; i++) {
    const v = minA + (maxA - minA) * (i / gridCount);
    const y = yScale(v);
    ctx.strokeStyle = '#e0dbd4';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
    ctx.fillStyle  = '#a09488';
    ctx.font       = `${10 * 1}px "DM Mono", monospace`;
    ctx.textAlign  = 'right';
    ctx.fillText(formatMillions(v), PAD.left - 5, y + 3.5);
  }

  // X labels
  ctx.fillStyle  = '#6b6259';
  ctx.font       = `${11}px "Noto Sans TC", sans-serif`;
  ctx.textAlign  = 'center';
  data.forEach((d, i) => ctx.fillText(String(d.y), xScale(i), H - 10));

  // Area under line
  ctx.beginPath();
  data.forEach((d, i) => { const x=xScale(i),y=yScale(d.asset); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
  ctx.lineTo(xScale(data.length-1), H - PAD.bottom);
  ctx.lineTo(xScale(0),             H - PAD.bottom);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, PAD.top, 0, H - PAD.bottom);
  grad.addColorStop(0, 'rgba(58,123,213,0.20)');
  grad.addColorStop(1, 'rgba(58,123,213,0.02)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  data.forEach((d, i) => { const x=xScale(i),y=yScale(d.asset); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
  ctx.strokeStyle = '#3a7bd5';
  ctx.lineWidth   = 2.5;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // Data points + value labels
  data.forEach((d, i) => {
    const x = xScale(i), y = yScale(d.asset);
    // Dot
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle   = '#3a7bd5';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
    // Value label above dot
    ctx.fillStyle = '#2c2820';
    ctx.font      = `${10}px "DM Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(formatMillions(d.asset), x, y - 10);
  });
}

function formatMillions(v) {
  if (Math.abs(v) >= 1e6) return (v/1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v/1e3).toFixed(0) + 'k';
  return String(Math.round(v));
}

function closeAssetChartModal(e) {
  if (!e || e.target === document.getElementById('asset-chart-modal'))
    document.getElementById('asset-chart-modal').style.display = 'none';
}

// ===== SETTINGS =====
function closeSettingsModal(e) {
  if (!e||e.target===document.getElementById('settings-modal'))
    document.getElementById('settings-modal').style.display='none';
}
function openSettings() { renderSettingsBody(); document.getElementById('settings-modal').style.display='flex'; }
function renderSettingsBody() {
  document.getElementById('settings-body').innerHTML=`
    <div class="settings-section">
      <div class="settings-section-title">資料管理</div>
      <div class="settings-item" onclick="exportCSV()">
        <span class="settings-item-label">📤 匯出 CSV</span><span class="settings-item-arrow">›</span>
      </div>
      <label class="settings-item" style="cursor:pointer">
        <span class="settings-item-label">📥 匯入 CSV</span>
        <input type="file" accept=".csv" style="display:none" onchange="importCSV(this)" />
        <span class="settings-item-arrow">›</span>
      </label>
      <div style="padding:10px 16px;font-size:11px;color:var(--text3);line-height:1.7;background:var(--bg3);border-bottom:1px solid var(--border)">
        💡 <b>CSV格式說明（用Excel編輯時）</b><br>
        欄位順序：<code>type, date, amount, note, category</code><br>
        • type：<code>expense</code>（支出）/ <code>income</code>（收入）<br>
        • date：<code>2024-01-15</code> 或 <code>2024-01</code><br>
        • category：<code>daily</code> / <code>regular_expense</code> / <code>regular_income</code> / <code>invest</code><br>
        ⚠️ 請用 <b>逗號</b> 分隔（Excel另存為CSV UTF-8）<br>
        或直接匯出程式的CSV再修改回存
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">📊 投資配置 — Google Sheet</div>
      <div class="settings-item" style="flex-direction:column;align-items:flex-start;gap:10px;">
        <div style="font-size:12px;color:var(--text3);line-height:1.6">
          在 Google Sheet 分享設定為「知道連結的人可以查看」，<br>
          再點選 檔案 → 發布到網路 → 選擇分頁 → CSV 格式，複製連結貼到下方
        </div>
        <div style="display:flex;gap:8px;width:100%;align-items:center">
          <input id="sheet-url-input" class="form-input"
            type="url" placeholder="https://docs.google.com/spreadsheets/d/.../pub?gid=...&single=true&output=csv"
            value="${DB.sheetUrl||''}"
            style="flex:1;font-size:12px;padding:8px" />
        </div>
        <button class="btn-primary" style="margin-top:0" onclick="saveSheetUrl()">儲存網址</button>
        ${DB.sheetUrl ? `<div style="font-size:11px;color:var(--green)">✅ 已設定網址</div>` : ''}
      </div>
    </div>
      <div class="settings-item" style="flex-direction:column;align-items:flex-start;gap:6px;cursor:default">
        <div style="font-size:13px;color:var(--text)">📅 手動輸入歷史年份 / 期初資產</div>
        <div style="font-size:11px;color:var(--text3)">請切換到「年份」頁面，在下方表單輸入歷史資料或期初資產設定</div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">危險操作</div>
      <div class="settings-item" onclick="clearAllData()">
        <span class="settings-item-label" style="color:var(--red)">🗑️ 清除所有資料</span>
        <span class="settings-item-arrow">›</span>
      </div>
    </div>`;
}
function normalizeSheetUrl(url) {
  if (!url) return '';
  // Already a CSV export or pub URL — keep as-is
  if (url.includes('/export?') || url.includes('/pub?')) return url;
  // Extract spreadsheet ID and gid from edit/view URLs
  const idMatch  = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const gidMatch = url.match(/[?&#]gid=(\d+)/);
  if (!idMatch) return url; // unknown format, return unchanged
  const id  = idMatch[1];
  const gid = gidMatch ? gidMatch[1] : '0';
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}
function saveSheetUrl() {
  const raw = document.getElementById('sheet-url-input')?.value.trim() || '';
  DB.sheetUrl = normalizeSheetUrl(raw);
  saveData(DB); renderSettingsBody();
  showToast(DB.sheetUrl ? '✅ Google Sheet 網址已儲存' : '已清除網址');
}
function clearAllData() {
  if (!confirm('確定要清除所有資料？此操作無法復原。')) return;
  localStorage.clear(); DB=loadData(); renderCalendar(); closeSettingsModal(); showToast('已清除');
}
function exportCSV() {
  let csv = 'type,date,amount,note,category\n';

  // ── Global preset name lists (so new device restores them) ──
  for (const name of DB.presets)
    csv += `preset,0000-01-01,0,"${name}",preset_expense\n`;
  for (const name of DB.incomePresets)
    csv += `preset,0000-01-01,0,"${name}",preset_income\n`;
  for (const name of DB.interestPresets)
    csv += `preset,0000-01-01,0,"${name}",preset_interest\n`;
  for (const name of DB.dividendPresets)
    csv += `preset,0000-01-01,0,"${name}",preset_dividend\n`;

  // ── Manual year summaries ──
  for (const [y, d] of Object.entries(DB.manualYears)) {
    const fields = [
      d.income      !== undefined ? d.income      : '',
      d.expense     !== undefined ? d.expense     : '',
      d.balance     !== undefined ? d.balance     : '',
      d.investTotal !== undefined ? d.investTotal : '',
      d.asset       !== undefined ? d.asset       : '',
    ];
    csv += `manual_year,${y}-01-01,0,"${fields.join('|')}",manual_year\n`;
  }

  // ── Daily records ──
  for (const [date, recs] of Object.entries(DB.records))
    for (const r of recs)
      csv += `${r.type},${date},${r.amount},"${(r.note||'').replace(/"/g,'""')}",daily\n`;

  // ── Regular monthly data ──
  for (const [mk, reg] of Object.entries(DB.regular)) {
    if (reg.expense)
      for (const [name, amt] of Object.entries(reg.expense))
        csv += `expense,${mk}-01,${amt},"${name.replace(/"/g,'""')}",regular_expense\n`;

    if (reg.incomePresets)
      for (const item of reg.incomePresets)
        csv += `income,${mk}-01,${item.amount},"${item.name.replace(/"/g,'""')}",regular_income\n`;
    else if (reg.income)
      csv += `income,${mk}-01,${reg.income},"薪資",regular_income\n`;

    // interest/dividend amounts (global-preset style)
    if (reg.interestAmounts)
      for (const [name, amt] of Object.entries(reg.interestAmounts))
        csv += `interest,${mk}-01,${amt},"${name.replace(/"/g,'""')}",regular_interest\n`;
    if (reg.dividendAmounts)
      for (const [name, amt] of Object.entries(reg.dividendAmounts))
        csv += `dividend,${mk}-01,${amt},"${name.replace(/"/g,'""')}",regular_dividend\n`;

    // stock records (old invest array — only stock type remains here)
    if (reg.invest)
      for (const inv of reg.invest) {
        const amt = inv.direction === 'loss' ? -inv.amount : inv.amount;
        csv += `stock,${mk}-01,${amt},"${(inv.note||'').replace(/"/g,'""')}",invest_stock\n`;
      }
  }

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `records_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('已匯出 CSV');
}
function importCSV(input) {
  const file = input.files[0]; if (!file) return;

  function parseCSVLine(line, delim) {
    const result = []; let cur = '', inQ = false;
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === '"') {
        if (inQ && line[ci+1] === '"') { cur += '"'; ci++; } // escaped quote
        else inQ = !inQ;
      } else if (ch === delim && !inQ) { result.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    result.push(cur.trim());
    return result;
  }

  const tryParse = (text) => {
    text = text.replace(/^\uFEFF/, '');
    const firstLine = text.split('\n')[0];
    const delim = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return 0;

    const h = lines[0].toLowerCase();
    const start = (h.includes('type') || h.includes('date') || h.includes('類型') || h.includes('日期')) ? 1 : 0;

    let count = 0;
    for (let i = start; i < lines.length; i++) {
      const row = parseCSVLine(lines[i], delim);
      if (row.length < 3) continue;

      let [type, date, amtRaw, note, cat] = row;
      // support date-first format
      if (/^\d{4}-\d{2}/.test(type)) { [date, type, amtRaw, note, cat] = row; }

      type = (type||'').trim().toLowerCase();
      date = (date||'').trim().replace(/\//g, '-');
      note = (note||'').trim();
      cat  = (cat||'').trim().toLowerCase();
      const amt = parseFloat((amtRaw||'').replace(/,/g,''));

      // ── Restore global preset name lists ──────────────────────
      if (cat === 'preset_expense') {
        if (note && !DB.presets.includes(note)) DB.presets.push(note);
        count++; continue;
      }
      if (cat === 'preset_income') {
        if (note && !DB.incomePresets.includes(note)) DB.incomePresets.push(note);
        count++; continue;
      }
      if (cat === 'preset_interest') {
        if (note && !DB.interestPresets.includes(note)) DB.interestPresets.push(note);
        count++; continue;
      }
      if (cat === 'preset_dividend') {
        if (note && !DB.dividendPresets.includes(note)) DB.dividendPresets.push(note);
        count++; continue;
      }

      // ── Manual year summaries (new format) ───────────────────
      if (cat === 'manual_year') {
        const yr = parseInt(date.substring(0,4));
        if (!yr) continue;
        if (!DB.manualYears[yr]) DB.manualYears[yr] = {};
        const parts = note.split('|');
        const setIfVal = (key, v) => { if (v!==''&&v!==undefined&&!isNaN(parseFloat(v))) DB.manualYears[yr][key]=parseFloat(v); };
        setIfVal('income',      parts[0]);
        setIfVal('expense',     parts[1]);
        setIfVal('balance',     parts[2]);
        setIfVal('investTotal', parts[3]);
        setIfVal('asset',       parts[4]);
        DB.manualYears[yr]._manual = true;
        count++; continue;
      }

      // ── Assets (old format, backward compat) ────────────────
      if (cat === 'asset') {
        const yr = parseInt(date.substring(0,4));
        if (yr && !isNaN(amt) && amt > 0) {
          if (!DB.manualYears[yr]) DB.manualYears[yr] = {};
          if (DB.manualYears[yr].asset === undefined) DB.manualYears[yr].asset = amt;
        }
        count++; continue;
      }

      if (!date || isNaN(amt)) continue;
      if (/^\d{4}-\d{2}$/.test(date)) date = date + '-01';

      // ── Daily records ─────────────────────────────────────────
      if (cat === 'daily' || (!cat && (type==='expense'||type==='income'||type==='支出'||type==='收入'))) {
        if (type==='支出') type='expense';
        if (type==='收入') type='income';
        const dk = date.substring(0,10);
        if (!DB.records[dk]) DB.records[dk] = [];
        DB.records[dk].push({ id: Date.now()+'-'+i+'-'+Math.random(), amount: Math.abs(amt), note, type: (type==='income'?'income':'expense'), ts: Date.now() });
        count++; continue;
      }

      // ── Regular expense ───────────────────────────────────────
      if (cat === 'regular_expense') {
        const mk = date.substring(0,7);
        if (!DB.regular[mk])         DB.regular[mk] = {};
        if (!DB.regular[mk].expense) DB.regular[mk].expense = {};
        if (note) DB.regular[mk].expense[note] = Math.abs(amt);
        count++; continue;
      }

      // ── Regular income ────────────────────────────────────────
      if (cat === 'regular_income') {
        const mk = date.substring(0,7);
        if (!DB.regular[mk])               DB.regular[mk] = {};
        if (!DB.regular[mk].incomePresets) DB.regular[mk].incomePresets = [];
        const idx = DB.regular[mk].incomePresets.findIndex(x => x.name === note);
        const a = Math.abs(amt);
        if (idx >= 0) DB.regular[mk].incomePresets[idx].amount = a;
        else          DB.regular[mk].incomePresets.push({ name: note||'薪資', amount: a });
        count++; continue;
      }

      // ── Interest amounts ──────────────────────────────────────
      if (cat === 'regular_interest') {
        const mk = date.substring(0,7);
        if (!DB.regular[mk])                  DB.regular[mk] = {};
        if (!DB.regular[mk].interestAmounts)  DB.regular[mk].interestAmounts = {};
        if (note) DB.regular[mk].interestAmounts[note] = Math.abs(amt);
        // also ensure the name is in global presets
        if (note && !DB.interestPresets.includes(note)) DB.interestPresets.push(note);
        count++; continue;
      }

      // ── Dividend amounts ──────────────────────────────────────
      if (cat === 'regular_dividend') {
        const mk = date.substring(0,7);
        if (!DB.regular[mk])                  DB.regular[mk] = {};
        if (!DB.regular[mk].dividendAmounts)  DB.regular[mk].dividendAmounts = {};
        if (note) DB.regular[mk].dividendAmounts[note] = Math.abs(amt);
        if (note && !DB.dividendPresets.includes(note)) DB.dividendPresets.push(note);
        count++; continue;
      }

      // ── Stock trades ──────────────────────────────────────────
      if (cat === 'invest_stock' || (cat === 'invest' && (type==='stock'||type==='invest'))) {
        const mk = date.substring(0,7);
        if (!DB.regular[mk])        DB.regular[mk] = {};
        if (!DB.regular[mk].invest) DB.regular[mk].invest = [];
        DB.regular[mk].invest.push({ type:'stock', direction: amt>=0?'gain':'loss', amount: Math.abs(amt), note });
        count++; continue;
      }

      // ── Fallback: old-style invest rows ──────────────────────
      if (cat === 'invest') {
        const mk = date.substring(0,7);
        if (!DB.regular[mk])        DB.regular[mk] = {};
        if (!DB.regular[mk].invest) DB.regular[mk].invest = [];
        const invType = ['interest','dividend','stock'].includes(type) ? type : 'stock';
        DB.regular[mk].invest.push({ type: invType, direction: amt>=0?'gain':'loss', amount: Math.abs(amt), note });
        count++; continue;
      }
    }
    return count;
  };

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const count = tryParse(e.target.result);
      if (count === 0) {
        showToast('找不到可匯入的資料，請確認格式');
      } else {
        saveData(DB); renderCalendar(); closeSettingsModal();
        showToast(`✅ 已匯入 ${count} 筆記錄`);
      }
    } catch(err) {
      console.error(err);
      showToast('匯入失敗：' + err.message);
    }
  };
  reader.readAsText(file, 'UTF-8');
}

// ===== PORTFOLIO VIEW =====
// Colour palette for pie charts
const PIE_COLORS = [
  '#3a7bd5','#2d8a3e','#c96a10','#8e44ad','#1565c0',
  '#c0392b','#16a085','#d35400','#2980b9','#7f8c8d',
  '#27ae60','#e67e22','#8e44ad','#2c3e50','#f39c12',
];

function renderPortfolioView() {
  const cache = DB.portfolioCache || { rows:[], updatedAt:'' };
  const body  = document.getElementById('port-body');
  if (!DB.sheetUrl) {
    body.innerHTML = `<div class="port-status">⚙️ 尚未設定 Google Sheet 網址<br><small>請前往設定輸入 CSV 發布連結</small></div>`;
    return;
  }
  if (!cache.rows || !cache.rows.length) {
    body.innerHTML = `<div class="port-status">📭 尚無資料<br><small>點上方「更新資料」按鈕抓取</small></div>`;
    return;
  }
  renderPortfolioContent(cache.rows, cache.updatedAt);
}

function renderPortfolioContent(rows, updatedAt) {
  const body = document.getElementById('port-body');

  const totalCost    = rows.reduce((s, r) => s + (Number(r.cost)    || 0), 0);
  const totalCurrent = rows.reduce((s, r) => s + (Number(r.current) || 0), 0);
  const totalGain    = totalCurrent - totalCost;
  const gainPct      = totalCost > 0 ? (totalGain / totalCost * 100).toFixed(2) : 0;

  // --- 圓餅圖1: 依項目名稱 (current value)
  const byItem = rows.map((r,i) => ({
    label: r.name,
    val:   Number(r.current) || 0,
    color: PIE_COLORS[i % PIE_COLORS.length],
  })).filter(x => x.val > 0);

  // --- 圓餅圖2: 依類別 (current value)
  const catMap = {};
  rows.forEach((r,i) => {
    const cat = r.category || '其他';
    if (!catMap[cat]) catMap[cat] = { val:0, color:'' };
    catMap[cat].val += Number(r.current) || 0;
  });
  let ci = 0;
  const byCategory = Object.entries(catMap).map(([label,obj]) => ({
    label, val: obj.val, color: PIE_COLORS[ci++ % PIE_COLORS.length]
  })).filter(x => x.val > 0);

  body.innerHTML = `
    ${updatedAt ? `<div class="port-last-update">最後更新：${updatedAt}</div>` : ''}
    <div class="port-charts">
      <div class="port-chart-card">
        <div class="port-chart-title">依項目</div>
        <div class="port-chart-wrap">
          <canvas id="chart-item" width="140" height="140"></canvas>
        </div>
        <div class="port-legend" id="legend-item"></div>
      </div>
      <div class="port-chart-card">
        <div class="port-chart-title">依類別</div>
        <div class="port-chart-wrap">
          <canvas id="chart-cat" width="140" height="140"></canvas>
        </div>
        <div class="port-legend" id="legend-cat"></div>
      </div>
    </div>
    <button class="port-detail-btn" onclick="openPortDetail()">📋 查看詳細資料</button>
    <div class="port-summary-bar">
      <div class="port-summary-row">
        <span class="port-summary-label">成本金額合計</span>
        <span class="port-summary-val">${fmtMoney(totalCost)}</span>
      </div>
      <div class="port-summary-row">
        <span class="port-summary-label">現價金額合計</span>
        <span class="port-summary-val">${fmtMoney(totalCurrent)}</span>
      </div>
      <div class="port-summary-row">
        <span class="port-summary-label">損益</span>
        <span class="port-summary-val ${totalGain>=0?'gain':'loss'}">${totalGain>=0?'+':''}${fmtMoney(totalGain)} (${totalGain>=0?'+':''}${gainPct}%)</span>
      </div>
    </div>`;

  // Draw charts after DOM is painted
  requestAnimationFrame(() => {
    drawPie('chart-item', 'legend-item', byItem,    totalCurrent);
    drawPie('chart-cat',  'legend-cat',  byCategory, totalCurrent);
  });
}

// Canvas hollow donut chart for portfolio
function drawPie(canvasId, legendId, slices, total) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const SIZE = 140; // logical px
  canvas.width  = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width  = SIZE + 'px';
  canvas.style.height = SIZE + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const cx = SIZE/2, cy = SIZE/2;
  const outerR = SIZE/2 - 6;
  const innerR = outerR * 0.54; // hollow hole ratio
  ctx.clearRect(0, 0, SIZE, SIZE);

  // Background track
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI*2);
  ctx.arc(cx, cy, innerR, Math.PI*2, 0, true);
  ctx.fillStyle = '#ede9e3';
  ctx.fill();

  // Slices
  let startAngle = -Math.PI / 2;
  slices.forEach(s => {
    const sweep = (s.val / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, startAngle, startAngle + sweep);
    ctx.arc(cx, cy, innerR, startAngle + sweep, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
    // thin white separator
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    startAngle += sweep;
  });

  // Legend
  const legend = document.getElementById(legendId);
  if (!legend) return;
  legend.innerHTML = slices.map(s => {
    const pct = total > 0 ? (s.val/total*100).toFixed(1) : 0;
    return `<div class="port-legend-item">
      <div class="port-legend-dot" style="background:${s.color}"></div>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:66px">${s.label}</span>
      <span class="port-legend-pct">${pct}%</span>
    </div>`;
  }).join('');
}

// Fetch CSV from Google Sheets — use CORS proxy with cache-busting to prevent stale proxy cache
async function fetchPortfolioData() {
  if (!DB.sheetUrl) {
    showToast('請先在設定輸入 Google Sheet 網址');
    return;
  }
  const btn = document.getElementById('port-update-btn');
  if (btn) { btn.classList.add('loading'); btn.innerHTML = '⏳ 抓取中...'; }

  // Add timestamp to bust both browser cache AND proxy cache
  const ts     = Date.now();
  const csvUrl = DB.sheetUrl + (DB.sheetUrl.includes('?') ? '&' : '?') + '_t=' + ts;

  const proxies = [
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}&_t=${ts}`,
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ];

  let lastError = '';
  for (const makeUrl of proxies) {
    try {
      const proxyUrl = makeUrl(csvUrl);
      const res = await fetch(proxyUrl, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache' }
      });
      if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
      const text = await res.text();
      if (!text || text.trim().startsWith('<')) { lastError = '回傳非 CSV 內容'; continue; }
      const rows = parseSheetCSV(text);
      if (!rows.length) { lastError = '找不到資料列，請確認 Sheet 欄位結構'; continue; }
      const now = new Date().toLocaleString('zh-TW');
      DB.portfolioCache = { rows, updatedAt: now };
      saveData(DB);
      renderPortfolioContent(rows, now);
      showToast(`✅ 已更新 ${rows.length} 筆資料`);
      if (btn) { btn.classList.remove('loading'); btn.innerHTML = '🔄 更新資料'; }
      return;
    } catch(e) {
      lastError = e.message;
    }
  }

  // All proxies failed
  if (btn) { btn.classList.remove('loading'); btn.innerHTML = '🔄 更新資料'; }
  showToast('抓取失敗，請確認網路與分享設定');
  document.getElementById('port-body').innerHTML = `
    <div class="port-status">
      ❌ 抓取失敗<br>
      <small style="color:var(--red)">${lastError}</small><br><br>
      <div style="text-align:left;font-size:12px;color:var(--text2);line-height:1.8">
        請確認：<br>
        ① Google Sheet 共用設定為「知道連結的人可以<b>檢視</b>」<br>
        ② 設定中的網址正確（貼上編輯網址即可）<br>
        ③ 手機有網路連線<br>
        ④ 若持續失敗，嘗試重新儲存網址後再更新
      </div>
    </div>`;
}

function clearPortfolioCache() {
  if (!confirm('確定要清空配置資料？清空後需重新按「更新資料」才能顯示。')) return;
  DB.portfolioCache = { rows: [], updatedAt: '' };
  saveData(DB);
  renderPortfolioView();
  showToast('已清空配置資料');
}

// Parse the CSV from Google Sheet
// Expected columns: 項目名稱, 類別, 成本金額, 現價金額
function parseSheetCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  // Parse header to find column indices (flexible)
  function splitCSV(line) {
    const res = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { res.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    res.push(cur.trim());
    return res;
  }

  const headers = splitCSV(lines[0]).map(h => h.replace(/"/g,'').trim());
  const idx = {
    name:     headers.findIndex(h => /項目|名稱|name/i.test(h)),
    category: headers.findIndex(h => /類別|category|分類/i.test(h)),
    cost:     headers.findIndex(h => /成本|cost/i.test(h)),
    current:  headers.findIndex(h => /現價|市值|current|market/i.test(h)),
  };
  // Fallback to positional (col 0,1,2,3)
  if (idx.name     < 0) idx.name     = 0;
  if (idx.category < 0) idx.category = 1;
  if (idx.cost     < 0) idx.cost     = 2;
  if (idx.current  < 0) idx.current  = 3;

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSV(lines[i]).map(c => c.replace(/"/g,'').trim());
    if (!cols[idx.name]) continue; // skip empty rows
    const cost    = parseFloat((cols[idx.cost]    || '0').replace(/[,，]/g,'')) || 0;
    const current = parseFloat((cols[idx.current] || '0').replace(/[,，]/g,'')) || 0;
    rows.push({
      name:     cols[idx.name]     || '',
      category: cols[idx.category] || '其他',
      cost,
      current,
    });
  }
  return rows;
}

function openPortDetail() {
  const cache = DB.portfolioCache || { rows:[] };
  const rows  = cache.rows || [];
  const body  = document.getElementById('port-detail-body');

  const totalCost    = rows.reduce((s,r) => s+(Number(r.cost)||0),    0);
  const totalCurrent = rows.reduce((s,r) => s+(Number(r.current)||0), 0);

  let html = `<div style="overflow-x:auto">
    <table class="port-detail-table">
      <thead><tr>
        <th>項目</th><th>類別</th><th style="text-align:right">成本</th><th style="text-align:right">現價</th><th style="text-align:right">損益%</th>
      </tr></thead><tbody>`;

  for (const r of rows) {
    const costPct    = totalCost    > 0 ? (r.cost    / totalCost    * 100).toFixed(1) : 0;
    const currentPct = totalCurrent > 0 ? (r.current / totalCurrent * 100).toFixed(1) : 0;
    const gain       = r.current - r.cost;
    const gainPct    = r.cost > 0 ? (gain / r.cost * 100).toFixed(1) : 0;
    html += `<tr>
      <td>${r.name}</td>
      <td style="text-align:center"><span class="cat-badge">${r.category}</span></td>
      <td>${fmtMoney(r.cost)}<br><small style="color:var(--text3)">${costPct}%</small></td>
      <td>${fmtMoney(r.current)}<br><small style="color:var(--text3)">${currentPct}%</small></td>
      <td class="${gain>=0?'gain':'loss'}">${gain>=0?'+':''}${gainPct}%</td>
    </tr>`;
  }

  html += `</tbody>
    <tfoot><tr style="font-weight:700">
      <td colspan="2" style="font-family:var(--font);font-size:12px;color:var(--text)">合計</td>
      <td>${fmtMoney(totalCost)}</td>
      <td>${fmtMoney(totalCurrent)}</td>
      <td class="${totalCurrent-totalCost>=0?'gain':'loss'}">${totalCost>0?(((totalCurrent-totalCost)/totalCost)*100).toFixed(1):0}%</td>
    </tr></tfoot>
  </table></div>`;

  body.innerHTML = html;
  document.getElementById('port-detail-modal').style.display = 'flex';
}
function closePortDetailModal(e) {
  if (!e || e.target === document.getElementById('port-detail-modal'))
    document.getElementById('port-detail-modal').style.display = 'none';
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelector('.top-tabs').addEventListener('contextmenu',e=>{e.preventDefault();openSettings();});
  addSettingsButton();
  renderCalendar();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
});
function addSettingsButton() {
  const tabs=document.querySelector('.top-tabs');
  const btn=document.createElement('button');
  btn.innerHTML='⚙';
  btn.style.cssText='flex:none;width:44px;font-size:16px;color:var(--text3);background:none;border:none;cursor:pointer;';
  btn.onclick=openSettings;
  tabs.appendChild(btn);
}
