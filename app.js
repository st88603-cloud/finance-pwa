// ===== STATE =====
let currentView = 'date';
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth(); // 0-indexed
let viewYear = currentYear; // for month view nav
let editingRecordId = null;
let currentDayKey = null;
let currentRegType = null;
let numpadTarget = null; // 'amount' or 'reg-amount'
let numpadStr = '';
let pendingRecordType = 'expense'; // for record form

// ===== DATA STRUCTURE =====
// records[YYYY-MM-DD] = [{id, amount, note, type:'expense'|'income', ts}]
// regular[YYYY-MM] = { expense:{presetName: amount}, income:{amount}, invest:[{type,direction,amount}] }
// dayColors[YYYY-MM-DD] = 'green'|'blue'|'yellow'|null
// presets = ['聯邦信用卡','富邦信用卡','玉山房貸繳款','自來水費']
// assets = { [year]: number } -- manually stored starting asset

function loadData() {
  return {
    records: JSON.parse(localStorage.getItem('records') || '{}'),
    regular: JSON.parse(localStorage.getItem('regular') || '{}'),
    dayColors: JSON.parse(localStorage.getItem('dayColors') || '{}'),
    presets: JSON.parse(localStorage.getItem('presets') || '["聯邦信用卡","富邦信用卡","玉山房貸繳款","自來水費"]'),
    assets: JSON.parse(localStorage.getItem('assets') || '{}'),
  };
}
function saveData(data) {
  localStorage.setItem('records', JSON.stringify(data.records));
  localStorage.setItem('regular', JSON.stringify(data.regular));
  localStorage.setItem('dayColors', JSON.stringify(data.dayColors));
  localStorage.setItem('presets', JSON.stringify(data.presets));
  localStorage.setItem('assets', JSON.stringify(data.assets));
}
let DB = loadData();

// ===== UTILS =====
function fmtMoney(n, showSign=false) {
  const abs = Math.abs(n).toLocaleString('zh-TW');
  if (showSign) return (n >= 0 ? '+' : '-') + 'NT$' + abs;
  return 'NT$' + abs;
}
function fmtShort(n) {
  if (n === 0) return '';
  const s = Math.abs(n) >= 10000 ? (Math.abs(n)/1000).toFixed(0)+'k' : Math.abs(n).toLocaleString('zh-TW');
  return (n >= 0 ? '+' : '-') + s;
}
function dayKey(y, m, d) { return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
function monthKey(y, m) { return `${y}-${String(m+1).padStart(2,'0')}`; }
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ===== MONTH CALCULATIONS =====
function getMonthData(year, month) {
  // Returns {income, expense, balance, interest, dividend, stockGain, investTotal}
  let income = 0, expense = 0, interest = 0, dividend = 0, stockGain = 0;

  // Daily records
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const k = dayKey(year, month, d);
    const recs = DB.records[k] || [];
    for (const r of recs) {
      if (r.type === 'income') income += r.amount;
      else expense += r.amount;
    }
  }

  // Regular
  const mk = monthKey(year, month);
  const reg = DB.regular[mk] || {};

  // Regular expense
  if (reg.expense) {
    for (const v of Object.values(reg.expense)) expense += Number(v) || 0;
  }
  // Regular income
  if (reg.income) income += Number(reg.income) || 0;
  // Invest
  if (reg.invest) {
    for (const inv of reg.invest) {
      const amt = Number(inv.amount) || 0;
      if (inv.type === 'interest') interest += amt;
      else if (inv.type === 'dividend') dividend += amt;
      else if (inv.type === 'stock') {
        if (inv.direction === 'gain') stockGain += amt;
        else stockGain -= amt;
      }
    }
  }

  const investTotal = interest + dividend + stockGain;
  const balance = income + investTotal - expense;
  return { income, expense, balance, interest, dividend, stockGain, investTotal };
}

function getYearData(year) {
  let totIncome = 0, totExpense = 0, totInterest = 0, totDividend = 0, totStock = 0;
  for (let m = 0; m < 12; m++) {
    const md = getMonthData(year, m);
    totIncome += md.income;
    totExpense += md.expense;
    totInterest += md.interest;
    totDividend += md.dividend;
    totStock += md.stockGain;
  }
  const investTotal = totInterest + totDividend + totStock;
  const totalIncome = totIncome + investTotal;
  const balance = totalIncome - totExpense;
  return { income: totIncome, expense: totExpense, balance, interest: totInterest, dividend: totDividend, stockGain: totStock, investTotal, totalIncome };
}

function getAsset(year) {
  // Asset = prev year asset + this year balance
  // Use stored assets as base, or compute chain
  const years = Object.keys(DB.assets).map(Number).sort();
  if (years.length === 0) {
    // Compute from scratch - sum all years up to this year
    let asset = 0;
    const minYear = Math.min(...getAllRecordYears(), year);
    for (let y = minYear; y <= year; y++) {
      asset += getYearData(y).balance;
    }
    return asset;
  }
  // Find closest base year <= year
  const baseYears = years.filter(y => y <= year);
  if (baseYears.length === 0) {
    // All bases are after, compute from scratch
    let asset = 0;
    const minYear = Math.min(years[0], year);
    for (let y = minYear; y <= year; y++) {
      if (DB.assets[y] !== undefined) { asset = DB.assets[y]; continue; }
      asset += getYearData(y).balance;
    }
    return asset;
  }
  const base = Math.max(...baseYears);
  let asset = DB.assets[base];
  for (let y = base + 1; y <= year; y++) {
    asset += getYearData(y).balance;
  }
  return asset;
}

function getAllRecordYears() {
  const years = new Set();
  for (const k of Object.keys(DB.records)) years.add(parseInt(k.split('-')[0]));
  for (const k of Object.keys(DB.regular)) years.add(parseInt(k.split('-')[0]));
  if (years.size === 0) years.add(currentYear);
  return [...years].sort();
}

// ===== VIEW SWITCHING =====
function switchView(v) {
  currentView = v;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById('view-' + v).classList.add('active');
  document.querySelectorAll('.top-tabs button').forEach((btn, i) => {
    btn.classList.toggle('active', ['date','month','year'][i] === v);
  });
  if (v === 'date') renderCalendar();
  else if (v === 'month') renderMonthView();
  else if (v === 'year') renderYearView();
}

// ===== CALENDAR =====
function renderCalendar() {
  const y = currentYear, m = currentMonth;
  document.getElementById('cal-title').innerHTML = `<span>${y}</span> ${m+1}月`;
  
  const firstDay = new Date(y, m, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = new Date();
  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  // Empty cells
  for (let i = 0; i < firstDay; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day empty';
    grid.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(y, m, d).getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isToday = y === today.getFullYear() && m === today.getMonth() && d === today.getDate();
    const k = dayKey(y, m, d);
    const colorClass = DB.dayColors[k] ? `color-${DB.dayColors[k]}` : (isWeekend ? 'weekend' : '');

    const cell = document.createElement('div');
    cell.className = `cal-day${isWeekend ? ' weekend' : ''}${isToday ? ' today' : ''}${DB.dayColors[k] ? ' color-' + DB.dayColors[k] : ''}`;
    
    // Day amount
    const recs = DB.records[k] || [];
    let dayTotal = 0;
    for (const r of recs) dayTotal += r.type === 'income' ? r.amount : -r.amount;

    const amountHtml = dayTotal !== 0
      ? `<div class="day-amount ${dayTotal >= 0 ? 'pos' : 'neg'}">${fmtShort(dayTotal)}</div>`
      : '';

    cell.innerHTML = `<div class="day-num">${d}</div>${amountHtml}`;
    cell.onclick = () => openDayModal(y, m, d);
    grid.appendChild(cell);
  }

  // Monthly stats
  const md = getMonthData(y, m);
  const statsEl = document.getElementById('month-stats');
  statsEl.innerHTML = `
    <div class="stat-item"><div class="stat-label">總收入</div><div class="stat-value pos">${fmtMoney(md.income + md.investTotal)}</div></div>
    <div class="stat-item"><div class="stat-label">總支出</div><div class="stat-value">${fmtMoney(md.expense)}</div></div>
    <div class="stat-item"><div class="stat-label">結餘</div><div class="stat-value ${md.balance < 0 ? 'neg' : ''}">${fmtMoney(md.balance)}</div></div>
  `;
}

function prevMonth() { currentMonth--; if (currentMonth < 0) { currentMonth = 11; currentYear--; } renderCalendar(); }
function nextMonth() { currentMonth++; if (currentMonth > 11) { currentMonth = 0; currentYear++; } renderCalendar(); }
function prevYear() { viewYear--; renderMonthView(); }
function nextYear() { viewYear++; renderMonthView(); }

// ===== DAY MODAL =====
function openDayModal(y, m, d) {
  currentDayKey = dayKey(y, m, d);
  const dateStr = `${y}年${m+1}月${d}日`;
  document.getElementById('day-modal-title').textContent = dateStr;
  renderDayModalBody();
  document.getElementById('day-modal').style.display = 'flex';
}
function renderDayModalBody() {
  const k = currentDayKey;
  const recs = DB.records[k] || [];
  const body = document.getElementById('day-modal-body');
  
  // Color picker
  const curColor = DB.dayColors[k] || 'none';
  let recHtml = `
    <div class="form-group">
      <div class="form-label">日期標色</div>
      <div class="color-picker">
        <div class="color-opt none ${curColor==='none'?'selected':''}" onclick="setDayColor('none')" title="無"></div>
        <div class="color-opt green ${curColor==='green'?'selected':''}" onclick="setDayColor('green')" title="淺綠"></div>
        <div class="color-opt blue ${curColor==='blue'?'selected':''}" onclick="setDayColor('blue')" title="淺藍"></div>
        <div class="color-opt yellow ${curColor==='yellow'?'selected':''}" onclick="setDayColor('yellow')" title="淺黃"></div>
      </div>
    </div>
    <div class="divider"></div>
  `;

  if (recs.length > 0) {
    recHtml += '<div class="record-list">';
    for (const r of recs) {
      recHtml += `
        <div class="record-item" id="rec-${r.id}">
          <div class="record-item-left">
            <div class="record-item-cat"><span class="tag tag-${r.type}">${r.type==='income'?'收入':'支出'}</span>${r.note || '（無備註）'}</div>
            <div class="record-item-edit">
              <button class="edit-btn" onclick="editRecord('${r.id}')">編輯</button>
              <button class="del-btn" onclick="deleteRecord('${r.id}')">刪除</button>
            </div>
          </div>
          <div class="record-item-amount ${r.type}">${r.type==='income'?'+':'-'}${fmtMoney(r.amount)}</div>
        </div>`;
    }
    recHtml += '</div>';
  }

  recHtml += `<button class="add-record-btn" onclick="openRecordForm(null)">＋ 新增記錄</button>`;
  body.innerHTML = recHtml;
}
function closeDayModal(e) {
  if (!e || e.target === document.getElementById('day-modal')) {
    document.getElementById('day-modal').style.display = 'none';
    renderCalendar();
  }
}
function setDayColor(color) {
  if (color === 'none') delete DB.dayColors[currentDayKey];
  else DB.dayColors[currentDayKey] = color;
  saveData(DB);
  renderDayModalBody();
}
function deleteRecord(id) {
  const k = currentDayKey;
  DB.records[k] = (DB.records[k] || []).filter(r => r.id !== id);
  if (DB.records[k].length === 0) delete DB.records[k];
  saveData(DB);
  renderDayModalBody();
  showToast('已刪除');
}
function editRecord(id) {
  const k = currentDayKey;
  const rec = (DB.records[k] || []).find(r => r.id === id);
  if (!rec) return;
  openRecordForm(rec);
}

// ===== RECORD FORM =====
function openRecordForm(rec) {
  editingRecordId = rec ? rec.id : null;
  pendingRecordType = rec ? rec.type : 'expense';
  numpadStr = rec ? String(rec.amount) : '';
  document.getElementById('record-modal-title').textContent = rec ? '編輯記錄' : '新增記錄';
  renderRecordForm(rec);
  document.getElementById('record-modal').style.display = 'flex';
}
function renderRecordForm(rec) {
  const body = document.getElementById('record-modal-body');
  const noteVal = rec ? (rec.note || '') : '';
  const amtDisplay = numpadStr || '0';
  
  body.innerHTML = `
    <div class="form-group">
      <div class="form-label">類型</div>
      <div class="type-toggle">
        <button class="type-btn ${pendingRecordType==='expense'?'active-expense':''}" onclick="setRecordType('expense')">支出</button>
        <button class="type-btn ${pendingRecordType==='income'?'active-income':''}" onclick="setRecordType('income')">收入</button>
      </div>
    </div>
    <div class="form-group">
      <div class="form-label">金額</div>
      <div class="amount-display" id="numpad-display">${amtDisplay === '0' && numpadStr==='' ? '' : amtDisplay}</div>
      <div class="numpad">
        ${[1,2,3,4,5,6,7,8,9,'.',0,'⌫'].map((k,i) => {
          if (k === '⌫') return `<button class="numpad-btn del" onclick="numpadInput('del')">⌫</button>`;
          return `<button class="numpad-btn" onclick="numpadInput('${k}')">${k}</button>`;
        }).join('')}
      </div>
    </div>
    <div class="form-group">
      <div class="form-label">備註（可空白）</div>
      <input class="form-input" type="text" id="record-note" placeholder="項目名稱..." value="${noteVal}" />
    </div>
    <button class="btn-primary" onclick="saveRecord()">儲存</button>
  `;
}
function setRecordType(t) {
  pendingRecordType = t;
  renderRecordForm(null);
}
function numpadInput(k) {
  if (k === 'del') { numpadStr = numpadStr.slice(0, -1); }
  else if (k === '.') { if (!numpadStr.includes('.')) numpadStr += '.'; }
  else { if (numpadStr.length < 10) numpadStr += k; }
  const disp = document.getElementById('numpad-display');
  if (disp) disp.textContent = numpadStr || '';
}
function saveRecord() {
  const amt = parseFloat(numpadStr);
  if (!amt || amt <= 0) { showToast('請輸入金額'); return; }
  const note = document.getElementById('record-note')?.value.trim() || '';
  const k = currentDayKey;
  if (!DB.records[k]) DB.records[k] = [];
  if (editingRecordId) {
    const idx = DB.records[k].findIndex(r => r.id === editingRecordId);
    if (idx >= 0) DB.records[k][idx] = { ...DB.records[k][idx], amount: amt, note, type: pendingRecordType };
  } else {
    DB.records[k].push({ id: Date.now().toString(), amount: amt, note, type: pendingRecordType, ts: Date.now() });
  }
  saveData(DB);
  closeRecordModal();
  renderDayModalBody();
  showToast('已儲存');
}
function closeRecordModal(e) {
  if (!e || e.target === document.getElementById('record-modal')) {
    document.getElementById('record-modal').style.display = 'none';
    numpadStr = '';
    editingRecordId = null;
  }
}

// ===== REGULAR MODAL =====
function openRegModal(type) {
  currentRegType = type;
  const titles = { expense: '💳 常態支出', income: '💰 常態收入（薪資）', invest: '📈 投資項目' };
  document.getElementById('reg-modal-title').textContent = titles[type];
  renderRegModal();
  document.getElementById('reg-modal').style.display = 'flex';
}
function renderRegModal() {
  const mk = monthKey(currentYear, currentMonth);
  const reg = DB.regular[mk] || {};
  const body = document.getElementById('reg-modal-body');
  
  if (currentRegType === 'expense') {
    // Preset management + input amounts
    let html = `<div class="section-note">管理每月固定支出項目，設定後每月填入金額即可</div>`;
    html += `<div class="reg-preset-manage">
      <input class="reg-preset-input" type="text" id="new-preset-name" placeholder="新增項目名稱..." />
      <button class="btn-sm add" onclick="addPreset()">新增</button>
    </div>`;
    html += `<div class="reg-list">`;
    for (const p of DB.presets) {
      const val = reg.expense ? (reg.expense[p] || '') : '';
      html += `<div class="reg-item">
        <span class="reg-item-name">${p}</span>
        <input class="reg-item-input" type="number" inputmode="numeric" placeholder="0" value="${val}" data-preset="${p}" onchange="updateRegExpense(this)" />
        <button class="btn-sm danger" onclick="removePreset('${p}')">✕</button>
      </div>`;
    }
    html += `</div>`;
    html += `<button class="btn-primary" onclick="closeRegModal()">完成</button>`;
    body.innerHTML = html;

  } else if (currentRegType === 'income') {
    const salaryVal = reg.income || '';
    body.innerHTML = `
      <div class="form-group">
        <div class="form-label">本月薪資收入（NT$）</div>
        <input class="form-input" type="number" inputmode="numeric" id="salary-input" placeholder="0" value="${salaryVal}" />
      </div>
      <button class="btn-primary" onclick="saveRegIncome()">儲存</button>`;

  } else if (currentRegType === 'invest') {
    const invests = reg.invest || [];
    let html = `<div class="section-note">可新增多筆投資記錄</div>`;
    html += `<div class="reg-list" id="invest-list">`;
    for (let i = 0; i < invests.length; i++) {
      html += renderInvestItem(invests[i], i);
    }
    html += `</div>`;
    html += `<div style="margin-bottom:12px">
      <div class="form-label" style="margin-bottom:8px">新增投資項目</div>
      <div class="invest-type-grid">
        <button class="invest-type-btn" id="it-interest" onclick="selectInvestType('interest')">利息</button>
        <button class="invest-type-btn" id="it-dividend" onclick="selectInvestType('dividend')">股利</button>
        <button class="invest-type-btn" id="it-stock" onclick="selectInvestType('stock')">股票交易</button>
      </div>
      <div id="invest-direction-row" style="display:none;margin-bottom:8px">
        <div class="form-label">報酬方向</div>
        <div class="type-toggle">
          <button class="type-btn active-income" id="inv-dir-gain" onclick="selectInvestDir('gain')">正報酬</button>
          <button class="type-btn" id="inv-dir-loss" onclick="selectInvestDir('loss')">負報酬</button>
        </div>
      </div>
      <div class="form-group">
        <input class="form-input" type="number" inputmode="numeric" id="invest-amount-input" placeholder="金額 NT$" />
      </div>
      <div class="form-group">
        <input class="form-input" type="text" id="invest-note-input" placeholder="備註（可空白）" />
      </div>
      <button class="btn-primary" onclick="addInvestRecord()">新增</button>
    </div>`;
    body.innerHTML = html;
    window._investType = null;
    window._investDir = 'gain';
  }
}
function renderInvestItem(inv, i) {
  const typeLabel = { interest:'利息', dividend:'股利', stock:'股票交易' }[inv.type] || inv.type;
  const dirLabel = inv.type === 'stock' ? (inv.direction === 'gain' ? '正報酬' : '負報酬') : '';
  const sign = inv.type === 'stock' && inv.direction === 'loss' ? '-' : '+';
  const noteStr = inv.note ? `<div style="font-size:11px;color:var(--text2);margin-top:2px">${inv.note}</div>` : '';
  return `<div class="reg-item">
    <div style="flex:1">
      <div style="font-size:12px;color:var(--text3)">${typeLabel}${dirLabel ? ' · ' + dirLabel : ''}</div>
      ${noteStr}
    </div>
    <div class="reg-item-amount" style="color:${sign==='-'?'var(--orange)':'var(--green)'}">${sign}${fmtMoney(inv.amount)}</div>
    <button class="btn-sm danger" onclick="removeInvest(${i})">✕</button>
  </div>`;
}
function selectInvestType(t) {
  window._investType = t;
  document.querySelectorAll('.invest-type-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('it-' + t)?.classList.add('selected');
  document.getElementById('invest-direction-row').style.display = t === 'stock' ? 'block' : 'none';
}
function selectInvestDir(d) {
  window._investDir = d;
  document.getElementById('inv-dir-gain').className = 'type-btn ' + (d === 'gain' ? 'active-income' : '');
  document.getElementById('inv-dir-loss').className = 'type-btn ' + (d === 'loss' ? 'active-expense' : '');
}
function addInvestRecord() {
  if (!window._investType) { showToast('請選擇投資類型'); return; }
  const amt = parseFloat(document.getElementById('invest-amount-input')?.value);
  if (!amt || amt <= 0) { showToast('請輸入金額'); return; }
  const note = document.getElementById('invest-note-input')?.value.trim() || '';
  const mk = monthKey(currentYear, currentMonth);
  if (!DB.regular[mk]) DB.regular[mk] = {};
  if (!DB.regular[mk].invest) DB.regular[mk].invest = [];
  DB.regular[mk].invest.push({ type: window._investType, direction: window._investDir, amount: amt, note });
  saveData(DB);
  renderRegModal();
  showToast('已新增');
}
function removeInvest(i) {
  const mk = monthKey(currentYear, currentMonth);
  DB.regular[mk].invest.splice(i, 1);
  saveData(DB);
  renderRegModal();
}
function updateRegExpense(el) {
  const preset = el.getAttribute('data-preset');
  const mk = monthKey(currentYear, currentMonth);
  if (!DB.regular[mk]) DB.regular[mk] = {};
  if (!DB.regular[mk].expense) DB.regular[mk].expense = {};
  const val = parseFloat(el.value);
  if (val > 0) DB.regular[mk].expense[preset] = val;
  else delete DB.regular[mk].expense[preset];
  saveData(DB);
}
function saveRegIncome() {
  const val = parseFloat(document.getElementById('salary-input')?.value);
  const mk = monthKey(currentYear, currentMonth);
  if (!DB.regular[mk]) DB.regular[mk] = {};
  if (val > 0) DB.regular[mk].income = val;
  else delete DB.regular[mk].income;
  saveData(DB);
  closeRegModal();
  showToast('已儲存');
}
function addPreset() {
  const inp = document.getElementById('new-preset-name');
  const name = inp?.value.trim();
  if (!name) return;
  if (DB.presets.includes(name)) { showToast('項目已存在'); return; }
  DB.presets.push(name);
  saveData(DB);
  renderRegModal();
  showToast('已新增');
}
function removePreset(name) {
  DB.presets = DB.presets.filter(p => p !== name);
  saveData(DB);
  renderRegModal();
}
function closeRegModal(e) {
  if (!e || e.target === document.getElementById('reg-modal')) {
    document.getElementById('reg-modal').style.display = 'none';
    renderCalendar();
  }
}

// ===== MONTH VIEW =====
function renderMonthView() {
  document.getElementById('month-year-title').innerHTML = `<span>${viewYear}</span>年`;
  const grid = document.getElementById('months-grid');
  const today = new Date();
  grid.innerHTML = '';
  for (let m = 0; m < 12; m++) {
    const md = getMonthData(viewYear, m);
    const isCurrentMonth = viewYear === today.getFullYear() && m === today.getMonth();
    const card = document.createElement('div');
    card.className = `month-card${isCurrentMonth ? ' current-month' : ''}`;
    card.innerHTML = `
      <div class="month-card-label">${m+1}月</div>
      <div class="month-card-balance ${md.balance < 0 ? 'neg' : ''}">${fmtMoney(md.balance)}</div>
    `;
    card.onclick = () => openMonthDetail(viewYear, m);
    grid.appendChild(card);
  }
  // Year summary
  const yd = getYearData(viewYear);
  const incomeRatio = yd.totalIncome > 0 ? (yd.expense / yd.totalIncome * 100).toFixed(1) : 0;
  const saveRatio = yd.totalIncome > 0 ? (yd.balance / yd.totalIncome * 100).toFixed(1) : 0;
  document.getElementById('year-summary').innerHTML = `
    <div class="summary-title">${viewYear} 年度總計</div>
    <div class="summary-grid">
      <div class="summary-row">
        <div class="summary-row-label">年度總開銷（佔比）</div>
        <div class="summary-row-val ${yd.expense < 0 ? 'neg' : ''}">${fmtMoney(yd.expense)} <span style="font-size:10px;color:var(--text3)">${incomeRatio}%</span></div>
      </div>
      <div class="summary-row">
        <div class="summary-row-label">年收入（含投資）</div>
        <div class="summary-row-val pos">${fmtMoney(yd.totalIncome)}</div>
      </div>
      <div class="summary-row">
        <div class="summary-row-label">年度剩餘存款（佔比）</div>
        <div class="summary-row-val ${yd.balance < 0 ? 'neg' : 'accent'}">${fmtMoney(yd.balance)} <span style="font-size:10px;color:var(--text3)">${saveRatio}%</span></div>
      </div>
      <div class="summary-row">
        <div class="summary-row-label">年總投資報酬</div>
        <div class="summary-row-val accent">${fmtMoney(yd.investTotal)}</div>
      </div>
      <div class="summary-row">
        <div class="summary-row-label">年利息</div>
        <div class="summary-row-val">${fmtMoney(yd.interest)}</div>
      </div>
      <div class="summary-row">
        <div class="summary-row-label">年股息</div>
        <div class="summary-row-val">${fmtMoney(yd.dividend)}</div>
      </div>
      <div class="summary-row">
        <div class="summary-row-label">年獲利（股票）</div>
        <div class="summary-row-val ${yd.stockGain < 0 ? 'neg' : ''}">${fmtMoney(yd.stockGain)}</div>
      </div>
    </div>
  `;
}

function openMonthDetail(y, m) {
  const md = getMonthData(y, m);
  document.getElementById('month-detail-title').textContent = `${y}年${m+1}月 詳細`;
  const body = document.getElementById('month-detail-body');
  const rows = [
    ['每月總收入', md.income, 'pos'],
    ['每月總支出', md.expense, ''],
    ['每月總餘額', md.balance, md.balance < 0 ? 'neg' : 'pos'],
    ['每月總利息', md.interest, 'accent'],
    ['每月總股利', md.dividend, 'accent'],
    ['每月市場獲利', md.stockGain, md.stockGain < 0 ? 'neg' : 'accent'],
    ['每月投資總獲利', md.investTotal, md.investTotal < 0 ? 'neg' : 'accent'],
  ];
  body.innerHTML = rows.map(([label, val, cls]) => `
    <div class="month-detail-row">
      <span class="month-detail-label">${label}</span>
      <span class="month-detail-value ${cls}">${fmtMoney(val)}</span>
    </div>`).join('');
  document.getElementById('month-detail-modal').style.display = 'flex';
}
function closeMonthDetailModal(e) {
  if (!e || e.target === document.getElementById('month-detail-modal')) {
    document.getElementById('month-detail-modal').style.display = 'none';
  }
}

// ===== YEAR VIEW =====
function renderYearView() {
  const years = getAllRecordYears();
  const table = document.getElementById('year-table');
  table.innerHTML = `<thead><tr>
    <th>年份</th><th>年收入</th><th>年度開銷</th><th>年度剩餘</th><th>資產</th><th>年投資報酬</th><th>IRR</th>
  </tr></thead><tbody id="year-table-body"></tbody>`;
  
  const tbody = document.getElementById('year-table-body');
  let html = '';
  for (const y of years) {
    const yd = getYearData(y);
    const asset = getAsset(y);
    const irrBase = asset - yd.investTotal;
    const irr = irrBase > 0 ? (yd.investTotal / irrBase * 100).toFixed(2) : 0;
    html += `<tr>
      <td>${y}</td>
      <td class="pos">${fmtMoney(yd.totalIncome)}</td>
      <td>${fmtMoney(yd.expense)}</td>
      <td class="${yd.balance < 0 ? 'neg' : 'pos'}">${fmtMoney(yd.balance)}</td>
      <td class="accent">${fmtMoney(asset)}</td>
      <td class="${yd.investTotal < 0 ? 'neg' : ''}">${fmtMoney(yd.investTotal)}</td>
      <td>${irr}%</td>
    </tr>`;
  }
  tbody.innerHTML = html;
}

// ===== SETTINGS & CSV =====
function closeSettingsModal(e) {
  if (!e || e.target === document.getElementById('settings-modal')) {
    document.getElementById('settings-modal').style.display = 'none';
  }
}
function openSettings() {
  renderSettingsBody();
  document.getElementById('settings-modal').style.display = 'flex';
}
function renderSettingsBody() {
  document.getElementById('settings-body').innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">資料管理</div>
      <div class="settings-item" onclick="exportCSV()">
        <span class="settings-item-label">📤 匯出 CSV</span>
        <span class="settings-item-arrow">›</span>
      </div>
      <label class="settings-item" style="cursor:pointer">
        <span class="settings-item-label">📥 匯入 CSV</span>
        <input type="file" accept=".csv" style="display:none" onchange="importCSV(this)" />
        <span class="settings-item-arrow">›</span>
      </label>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">期初資產設定</div>
      <div class="settings-item" style="flex-direction:column;align-items:flex-start;gap:10px;">
        <div style="font-size:12px;color:var(--text3)">設定某年度的期初資產金額（作為資產計算基準）</div>
        <div style="display:flex;gap:8px;width:100%">
          <input id="asset-year" class="form-input" type="number" placeholder="年份" style="width:90px;font-size:14px;padding:8px" />
          <input id="asset-val" class="form-input" type="number" placeholder="金額" style="flex:1;font-size:14px;padding:8px" />
          <button class="btn-sm add" onclick="saveAsset()">設定</button>
        </div>
        ${Object.entries(DB.assets).map(([y,v]) => `<div style="font-size:12px;color:var(--text3)">${y}年: ${fmtMoney(v)}</div>`).join('')}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">危險操作</div>
      <div class="settings-item" onclick="clearAllData()" style="color:var(--red)">
        <span class="settings-item-label" style="color:var(--red)">🗑️ 清除所有資料</span>
        <span class="settings-item-arrow">›</span>
      </div>
    </div>`;
}
function saveAsset() {
  const y = parseInt(document.getElementById('asset-year')?.value);
  const v = parseFloat(document.getElementById('asset-val')?.value);
  if (!y || !v) { showToast('請輸入年份和金額'); return; }
  DB.assets[y] = v;
  saveData(DB);
  renderSettingsBody();
  showToast('已設定');
}
function clearAllData() {
  if (!confirm('確定要清除所有資料？此操作無法復原。')) return;
  localStorage.clear();
  DB = loadData();
  renderCalendar();
  closeSettingsModal();
  showToast('已清除');
}

function exportCSV() {
  let csv = 'type,date,amount,note,category\n';
  // Daily records
  for (const [date, recs] of Object.entries(DB.records)) {
    for (const r of recs) {
      csv += `${r.type},${date},${r.amount},"${r.note || ''}",daily\n`;
    }
  }
  // Regular
  for (const [mk, reg] of Object.entries(DB.regular)) {
    if (reg.expense) {
      for (const [name, amt] of Object.entries(reg.expense)) {
        csv += `expense,${mk}-01,${amt},"${name}",regular_expense\n`;
      }
    }
    if (reg.income) {
      csv += `income,${mk}-01,${reg.income},"薪資",regular_income\n`;
    }
    if (reg.invest) {
      for (const inv of reg.invest) {
        const amt = inv.type === 'stock' && inv.direction === 'loss' ? -inv.amount : inv.amount;
        csv += `invest,${mk}-01,${amt},"${inv.type}",invest\n`;
      }
    }
  }
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `records_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('已匯出 CSV');
}

function importCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const lines = e.target.result.replace(/^\ufeff/, '').split('\n').filter(l => l.trim());
      const headers = lines[0].split(',');
      let count = 0;
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].match(/(".*?"|[^,]+)(?=,|$)/g) || [];
        const clean = cols.map(c => c.replace(/^"|"$/g, '').trim());
        const type = clean[0], date = clean[1], amt = parseFloat(clean[2]), note = clean[3], cat = clean[4];
        if (!date || isNaN(amt)) continue;
        if (cat === 'daily') {
          if (!DB.records[date]) DB.records[date] = [];
          DB.records[date].push({ id: Date.now().toString() + i, amount: Math.abs(amt), note, type, ts: Date.now() });
          count++;
        } else if (cat === 'regular_expense') {
          const mk = date.substring(0,7);
          if (!DB.regular[mk]) DB.regular[mk] = {};
          if (!DB.regular[mk].expense) DB.regular[mk].expense = {};
          DB.regular[mk].expense[note] = Math.abs(amt);
          count++;
        } else if (cat === 'regular_income') {
          const mk = date.substring(0,7);
          if (!DB.regular[mk]) DB.regular[mk] = {};
          DB.regular[mk].income = Math.abs(amt);
          count++;
        } else if (cat === 'invest') {
          const mk = date.substring(0,7);
          if (!DB.regular[mk]) DB.regular[mk] = {};
          if (!DB.regular[mk].invest) DB.regular[mk].invest = [];
          DB.regular[mk].invest.push({ type: note, direction: amt >= 0 ? 'gain' : 'loss', amount: Math.abs(amt) });
          count++;
        }
      }
      saveData(DB);
      renderCalendar();
      closeSettingsModal();
      showToast(`已匯入 ${count} 筆記錄`);
    } catch(err) {
      showToast('匯入失敗，請確認格式');
    }
  };
  reader.readAsText(file, 'UTF-8');
}

// ===== LONG PRESS ON TITLE = SETTINGS =====
let titlePressTimer;
document.addEventListener('DOMContentLoaded', () => {
  const title = document.querySelector('.top-tabs');
  title.addEventListener('contextmenu', (e) => { e.preventDefault(); openSettings(); });
  // Also add a small gear icon area
  addSettingsButton();
  renderCalendar();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(() => {
      console.log('SW registered');
    });
  }
});

function addSettingsButton() {
  const tabs = document.querySelector('.top-tabs');
  const btn = document.createElement('button');
  btn.innerHTML = '⚙';
  btn.style.cssText = 'flex:none;width:44px;font-size:16px;color:var(--text3);background:none;border:none;cursor:pointer;';
  btn.onclick = openSettings;
  tabs.appendChild(btn);
}
