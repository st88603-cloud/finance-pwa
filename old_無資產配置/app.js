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
// regular[YYYY-MM]      = { expense:{name:amount}, incomePresets:[{name,amount}], invest:[{type,direction,amount,note}] }
// presets               = ['聯邦信用卡',...]   global expense preset names
// incomePresets         = ['薪資',...]          global income preset names
// dayColors[YYYY-MM-DD] = 'green'|'blue'|'yellow'
// assets[year]          = number

function loadData() {
  return {
    records:          JSON.parse(localStorage.getItem('records')          || '{}'),
    regular:          JSON.parse(localStorage.getItem('regular')          || '{}'),
    dayColors:        JSON.parse(localStorage.getItem('dayColors')        || '{}'),
    presets:          JSON.parse(localStorage.getItem('presets')          || '["聯邦信用卡","富邦信用卡","玉山房貸繳款","自來水費"]'),
    incomePresets:    JSON.parse(localStorage.getItem('incomePresets')    || '["薪資"]'),
    interestPresets:  JSON.parse(localStorage.getItem('interestPresets')  || '[]'),
    dividendPresets:  JSON.parse(localStorage.getItem('dividendPresets')  || '[]'),
    assets:           JSON.parse(localStorage.getItem('assets')           || '{}'),
  };
}
function saveData(data) {
  localStorage.setItem('records',         JSON.stringify(data.records));
  localStorage.setItem('regular',         JSON.stringify(data.regular));
  localStorage.setItem('dayColors',       JSON.stringify(data.dayColors));
  localStorage.setItem('presets',         JSON.stringify(data.presets));
  localStorage.setItem('incomePresets',   JSON.stringify(data.incomePresets));
  localStorage.setItem('interestPresets', JSON.stringify(data.interestPresets));
  localStorage.setItem('dividendPresets', JSON.stringify(data.dividendPresets));
  localStorage.setItem('assets',          JSON.stringify(data.assets));
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
  let totIncome=0, totExpense=0, totInterest=0, totDividend=0, totStock=0;
  for (let m=0; m<12; m++) {
    const md = getMonthData(year, m);
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
  const years = Object.keys(DB.assets).map(Number).sort();
  if (!years.length) {
    let a=0, min=Math.min(...getAllRecordYears(), year);
    for (let y=min; y<=year; y++) a += getYearData(y).balance;
    return a;
  }
  const bases = years.filter(y => y<=year);
  if (!bases.length) {
    let a=0, min=Math.min(years[0], year);
    for (let y=min; y<=year; y++) {
      if (DB.assets[y]!==undefined) { a=DB.assets[y]; continue; }
      a += getYearData(y).balance;
    }
    return a;
  }
  let a = DB.assets[Math.max(...bases)];
  for (let y=Math.max(...bases)+1; y<=year; y++) a += getYearData(y).balance;
  return a;
}

function getAllRecordYears() {
  const s = new Set();
  for (const k of Object.keys(DB.records))  s.add(parseInt(k.split('-')[0]));
  for (const k of Object.keys(DB.regular))  s.add(parseInt(k.split('-')[0]));
  if (!s.size) s.add(currentYear);
  return [...s].sort();
}

// ===== VIEW SWITCHING =====
function switchView(v) {
  currentView = v;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById('view-'+v).classList.add('active');
  document.querySelectorAll('.top-tabs button').forEach((btn,i) =>
    btn.classList.toggle('active', ['date','month','year'][i]===v));
  if (v==='date')       renderCalendar();
  else if (v==='month') renderMonthView();
  else if (v==='year')  renderYearView();
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

// ===== MONTH VIEW (Change 6: beautified layout + colours) =====
function renderMonthView() {
  // Change 2: year in dark-green
  document.getElementById('month-year-title').innerHTML=`<span class="cal-year">${viewYear}</span>年`;
  const grid=document.getElementById('months-grid');
  const today=new Date();
  grid.innerHTML='';

  for (let m=0; m<12; m++) {
    const md=getMonthData(viewYear,m);
    const isCurrent=viewYear===today.getFullYear()&&m===today.getMonth();
    const card=document.createElement('div');
    card.className=`month-card${isCurrent?' current-month':''}`;

    // Change 1: negative balance → -NT$xxx in red
    const balColor=md.balance<0?'var(--red)':'var(--green)';
    // Small invest indicator
    const investBadge=md.investTotal!==0
      ? `<div class="month-invest-badge">${md.investTotal>=0?'+':''}${fmtShort(md.investTotal)}</div>`
      : '';
    card.innerHTML=`
      <div class="month-card-label">${m+1}月</div>
      <div class="month-card-balance" style="color:${balColor}">${fmtMoney(md.balance)}</div>
      ${investBadge}`;
    card.onclick=()=>openMonthDetail(viewYear,m);
    grid.appendChild(card);
  }

  // Year summary (Change 6: styled sections)
  const yd=getYearData(viewYear);
  const incomeRatio=yd.totalIncome>0?(yd.expense/yd.totalIncome*100).toFixed(1):0;
  const saveRatio  =yd.totalIncome>0?(yd.balance/yd.totalIncome*100).toFixed(1):0;

  document.getElementById('year-summary').innerHTML=`
    <div class="summary-title">${viewYear} 年度總計</div>

    <div class="summary-section-label">💰 收支</div>
    <div class="summary-grid">
      <div class="summary-row">
        <div class="summary-row-label">年度總開銷 <span class="ratio-badge">${incomeRatio}%</span></div>
        <div class="summary-row-val" style="color:var(--red)">${fmtMoney(yd.expense)}</div>
      </div>
      <div class="summary-row">
        <div class="summary-row-label">年收入（含投資）</div>
        <div class="summary-row-val" style="color:var(--green)">${fmtMoney(yd.totalIncome)}</div>
      </div>
      <div class="summary-row">
        <div class="summary-row-label">年度剩餘存款 <span class="ratio-badge">${saveRatio}%</span></div>
        <div class="summary-row-val" style="color:${yd.balance<0?'var(--red)':'var(--green)'}">${fmtMoney(yd.balance)}</div>
      </div>
    </div>

    <div class="summary-section-label" style="margin-top:12px">📈 投資</div>
    <div class="summary-grid">
      <div class="summary-row">
        <div class="summary-row-label">年總投資報酬</div>
        <div class="summary-row-val" style="color:var(--invest-blue)">${fmtMoney(yd.investTotal)}</div>
      </div>
      <div class="summary-row">
        <div class="summary-row-label">年利息</div>
        <div class="summary-row-val" style="color:var(--invest-blue)">${fmtMoney(yd.interest)}</div>
      </div>
      <div class="summary-row">
        <div class="summary-row-label">年股息</div>
        <div class="summary-row-val" style="color:var(--invest-blue)">${fmtMoney(yd.dividend)}</div>
      </div>
      <div class="summary-row">
        <div class="summary-row-label">年獲利（股票）</div>
        <div class="summary-row-val" style="color:${yd.stockGain<0?'var(--red)':'var(--invest-blue)'}">${fmtMoney(yd.stockGain)}</div>
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
  const years=getAllRecordYears();
  document.getElementById('year-table').innerHTML=`
    <thead><tr>
      <th>年份</th><th>年收入</th><th>年度開銷</th><th>年度剩餘</th><th>資產</th><th>年投資報酬</th><th>IRR</th>
    </tr></thead><tbody id="year-table-body"></tbody>`;

  let html='';
  for (const y of years) {
    const yd    =getYearData(y);
    const asset =getAsset(y);
    const base  =asset-yd.investTotal;
    const irr   =base>0?(yd.investTotal/base*100).toFixed(2):0;
    // Change 1: fmtMoney now handles negative prefix
    html+=`<tr>
      <td>${y}</td>
      <td style="color:var(--green)">${fmtMoney(yd.totalIncome)}</td>
      <td>${fmtMoney(yd.expense)}</td>
      <td style="color:${yd.balance<0?'var(--red)':'var(--green)'}">${fmtMoney(yd.balance)}</td>
      <td style="color:var(--invest-blue)">${fmtMoney(asset)}</td>
      <td style="color:${yd.investTotal<0?'var(--red)':'var(--invest-blue)'}">${fmtMoney(yd.investTotal)}</td>
      <td>${irr}%</td>
    </tr>`;
  }
  document.getElementById('year-table-body').innerHTML=html;
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
      <div class="settings-section-title">期初資產設定</div>
      <div class="settings-item" style="flex-direction:column;align-items:flex-start;gap:10px;">
        <div style="font-size:12px;color:var(--text3)">設定某年度的期初資產金額（資產計算基準）</div>
        <div style="display:flex;gap:8px;width:100%">
          <input id="asset-year" class="form-input" type="number" placeholder="年份" style="width:90px;font-size:14px;padding:8px"/>
          <input id="asset-val"  class="form-input" type="number" placeholder="金額" style="flex:1;font-size:14px;padding:8px"/>
          <button class="btn-sm add" onclick="saveAsset()">設定</button>
        </div>
        ${Object.entries(DB.assets).sort().map(([y,v])=>`
          <div style="display:flex;align-items:center;gap:8px;width:100%">
            <div style="flex:1;font-size:13px;color:var(--text2)">${y}年：<span style="font-family:var(--mono);font-weight:600">${fmtMoney(v)}</span></div>
            <button class="btn-sm danger" onclick="deleteAsset(${y})" style="padding:4px 10px;font-size:11px">刪除</button>
          </div>`).join('')}
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
function saveAsset() {
  const y=parseInt(document.getElementById('asset-year')?.value);
  const v=parseFloat(document.getElementById('asset-val')?.value);
  if (!y||!v) { showToast('請輸入年份和金額'); return; }
  DB.assets[y]=v; saveData(DB); renderSettingsBody(); showToast('已設定');
}
function deleteAsset(y) {
  delete DB.assets[y];
  saveData(DB); renderSettingsBody(); showToast('已刪除');
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

  // ── Assets ──
  for (const [y, v] of Object.entries(DB.assets))
    csv += `asset,${y}-01-01,${v},"",asset\n`;

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

      // ── Assets ────────────────────────────────────────────────
      if (cat === 'asset') {
        const y = parseInt(date.substring(0,4));
        if (y && !isNaN(amt) && amt > 0) DB.assets[y] = amt;
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
