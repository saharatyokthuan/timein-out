// ---- STORAGE ----
const STORAGE_KEY = 'attendanceData_v1';
const SHIFTS_KEY = 'attendanceShifts_v1';
window.entries = [];
let editingId = null;
let detailId = null;

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    window.entries = raw ? JSON.parse(raw) : [];
  } catch (e) {
    window.entries = [];
  }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(window.entries));
}

function loadShifts() {
  try {
    const raw = localStorage.getItem(SHIFTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveShifts(shifts) {
  localStorage.setItem(SHIFTS_KEY, JSON.stringify(shifts));
}

function seedDefaultShiftsIfEmpty() {
  if (localStorage.getItem(SHIFTS_KEY)) return;
  saveShifts([
    { code: 'T10', name: 'กะ 10:00-19:00', start: '10:00', end: '19:00', isOff: false, otEligible: true, otEnd: '22:30' },
    { code: 'T13', name: 'กะ 13:00-22:00', start: '13:00', end: '22:00', isOff: false, otEligible: false, otEnd: '' },
    { code: 'OFF', name: 'วันหยุด', start: '', end: '', isOff: true, otEligible: false, otEnd: '' }
  ]);
}

// เติมค่า otEligible/otEnd ให้กะเก่าที่ยังไม่มีฟิลด์นี้ (ตั้งค่าเริ่มต้นตามกะที่ใช้จริง)
function migrateShiftOtFields() {
  const shifts = loadShifts();
  const otDefaults = { T10: '22:30', T3: '10:00' };
  let changed = false;
  shifts.forEach(s => {
    if (s.otEligible === undefined) {
      if (otDefaults[s.code] && !s.isOff) {
        s.otEligible = true;
        s.otEnd = otDefaults[s.code];
      } else {
        s.otEligible = false;
        s.otEnd = '';
      }
      changed = true;
    }
  });
  if (changed) saveShifts(shifts);
}

function getShift(code) {
  return loadShifts().find(s => s.code === code);
}

// ---- HELPER ----
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function showConfirmModal(message) {
  return new Promise(resolve => {
    document.getElementById('confirmMessage').textContent = message;
    const bg = document.getElementById('confirmModalBg');
    bg.classList.add('active');
    const yes = document.getElementById('confirmYesBtn');
    const no = document.getElementById('confirmNoBtn');
    const cleanup = (result) => {
      bg.classList.remove('active');
      yes.onclick = null;
      no.onclick = null;
      resolve(result);
    };
    yes.onclick = () => cleanup(true);
    no.onclick = () => cleanup(false);
  });
}

// ---- TIME MATH ----
function toMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesToText(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h > 0 && m > 0) return `${h} ชม. ${m} นาที`;
  if (h > 0) return `${h} ชม.`;
  return `${m} นาที`;
}

// คำนวณสถานะจากกะ + เวลาเข้า-ออกจริง
function calcStatus(shiftCode, clockIn, clockOut) {
  const shift = getShift(shiftCode);
  if (!shift) return { label: 'ไม่พบข้อมูลกะ', cls: 'off', lateMin: 0, earlyMin: 0, otMin: 0 };
  if (shift.isOff) return { label: '🟦 วันหยุด', cls: 'off', lateMin: 0, earlyMin: 0, otMin: 0 };
  if (!clockIn) return { label: '🔴 ขาดงานเต็มวัน', cls: 'absent', lateMin: 0, earlyMin: 0, otMin: 0 };

  const shiftStart = toMinutes(shift.start);
  let shiftEnd = toMinutes(shift.end);
  if (shiftEnd <= shiftStart) shiftEnd += 24 * 60; // กะข้ามเที่ยงคืน เช่น 22:00-07:00
  const inMin = toMinutes(clockIn);
  let outMin = clockOut ? toMinutes(clockOut) : null;
  if (outMin !== null && outMin < shiftStart) outMin += 24 * 60; // เวลาออกข้ามเที่ยงคืน

  const lateMin = Math.max(0, inMin - shiftStart);
  const earlyMin = outMin !== null ? Math.max(0, shiftEnd - outMin) : 0;
  let otMin = 0;
  if (shift.otEligible && outMin !== null) {
    const otStart = Math.max(inMin, shiftStart) + 9 * 60; // OT เริ่มนับหลังทำงานครบ 9 ชม. จากเวลาเข้า (ถ้าเข้าก่อนเวลากะ ให้นับจากเวลาเริ่มกะแทน)
    let otCap = toMinutes(shift.otEnd || '22:30'); // เวลาสิ้นสุด OT ตายตัวต่อกะ ไม่นับเลยเวลานี้
    if (otCap <= shiftStart) otCap += 24 * 60;
    otMin = Math.max(0, Math.min(outMin, otCap) - otStart);
  }
  const deficit = lateMin + earlyMin;

  const otSuffix = otMin > 0 ? ` (OT ${minutesToText(otMin)})` : '';
  const isLateAbsent = lateMin > 30; // สาย > 30 นาที ให้นับเป็นขาดงาน

  if (!clockOut) {
    const label = isLateAbsent ? `🔴 ขาดงาน ${minutesToText(lateMin)} (ยังไม่ลงเวลาออก)` : `🟡 สาย ${minutesToText(lateMin)} (ยังไม่ลงเวลาออก)`;
    return { label, cls: isLateAbsent ? 'absent' : 'late', lateMin, earlyMin: 0, otMin: 0 };
  }
  if (deficit === 0 && otMin > 0) return { label: `🟢 ตรงเวลา (ทำงานเกิน ${minutesToText(otMin)})`, cls: 'ontime', lateMin, earlyMin, otMin };
  if (deficit === 0) return { label: '🟢 ตรงเวลา', cls: 'ontime', lateMin: 0, earlyMin: 0, otMin };
  if (isLateAbsent) return { label: `🔴 ขาดงาน ${minutesToText(lateMin + earlyMin)}${otSuffix}`, cls: 'absent', lateMin, earlyMin, otMin };
  if (lateMin > 0 && earlyMin > 0) return { label: `🔴 ขาดงาน ${minutesToText(deficit)}${otSuffix}`, cls: 'absent', lateMin, earlyMin, otMin };
  if (lateMin > 0) return { label: `🟡 สาย ${minutesToText(lateMin)}${otSuffix}`, cls: 'late', lateMin, earlyMin, otMin };
  return { label: `🟠 ออกก่อนเวลา ${minutesToText(earlyMin)}${otSuffix}`, cls: 'late', lateMin, earlyMin, otMin };
}

// ---- TABS ----
function showTab(tab) {
  document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add('active');
  if (tab === 'history') renderHistory();
  if (tab === 'trend') renderTrend();
  if (tab === 'settings') renderShiftList();
}

// ---- SHIFT DROPDOWN (record form) ----
function populateShiftSelect(selected) {
  const sel = document.getElementById('shiftSelect');
  const shifts = loadShifts();
  sel.innerHTML = shifts.map(s => `<option value="${escapeHtml(s.code)}"${s.code === selected ? ' selected' : ''}>${escapeHtml(s.code)} - ${escapeHtml(s.name)}</option>`).join('');
}

function onShiftChange() {
  const shift = getShift(document.getElementById('shiftSelect').value);
  const inInput = document.getElementById('clockInInput');
  const outInput = document.getElementById('clockOutInput');
  if (shift && shift.isOff) {
    inInput.value = '';
    outInput.value = '';
    inInput.disabled = true;
    outInput.disabled = true;
  } else {
    inInput.disabled = false;
    outInput.disabled = false;
  }
  updateStatusPreview();
}

function updateStatusPreview() {
  const shiftCode = document.getElementById('shiftSelect').value;
  const clockIn = document.getElementById('clockInInput').value;
  const clockOut = document.getElementById('clockOutInput').value;
  const badge = document.getElementById('statusPreview');
  if (!shiftCode) { badge.textContent = '- ยังไม่กรอกข้อมูล -'; badge.className = 'status-badge'; return; }
  const status = calcStatus(shiftCode, clockIn, clockOut);
  badge.textContent = status.label;
  badge.className = 'status-badge ' + status.cls;
}

// ---- SAVE / EDIT / CANCEL ----
function clearForm() {
  document.getElementById('dateInput').valueAsDate = new Date();
  populateShiftSelect('');
  document.getElementById('clockInInput').value = '';
  document.getElementById('clockOutInput').value = '';
  document.getElementById('clockInInput').disabled = false;
  document.getElementById('clockOutInput').disabled = false;
  document.getElementById('noteInput').value = '';
  editingId = null;
  document.getElementById('editingBanner').style.display = 'none';
  updateStatusPreview();
}

function cancelEdit() {
  clearForm();
  showToast('ยกเลิกการแก้ไข');
}

function saveEntry() {
  const date = document.getElementById('dateInput').value;
  const shiftCode = document.getElementById('shiftSelect').value;
  const clockIn = document.getElementById('clockInInput').value;
  const clockOut = document.getElementById('clockOutInput').value;
  const note = document.getElementById('noteInput').value.trim();

  if (!date) { showToast('⚠️ กรุณาระบุวันที่'); return; }
  if (!shiftCode) { showToast('⚠️ กรุณาเลือกกะ'); return; }

  const entry = { id: editingId || Date.now(), date, shiftCode, clockIn, clockOut, note };

  if (editingId) {
    const idx = window.entries.findIndex(e => e.id === editingId);
    if (idx !== -1) window.entries[idx] = entry;
  } else {
    window.entries.push(entry);
  }
  saveData();
  showToast(editingId ? '✅ แก้ไขรายการแล้ว' : '✅ บันทึกแล้ว');
  clearForm();
  showTab('history');
}

// ---- HISTORY ----
function renderHistory() {
  const list = document.getElementById('historyList');
  document.getElementById('historyCount').textContent = window.entries.length;
  if (!window.entries.length) {
    list.innerHTML = '<div class="empty-hint">ยังไม่มีรายการที่บันทึกไว้</div>';
    return;
  }
  const sorted = [...window.entries].sort((a, b) => b.date.localeCompare(a.date));
  list.innerHTML = sorted.map(e => {
    const status = calcStatus(e.shiftCode, e.clockIn, e.clockOut);
    const timesText = status.cls === 'off' ? 'วันหยุด' : `${e.clockIn || '-'} - ${e.clockOut || '-'}`;
    return `
    <div class="hist-card" onclick="openDetail(${e.id})">
      <div class="hist-top">
        <span class="hist-date">${escapeHtml(e.date)}</span>
        <span class="hist-shift">${escapeHtml(e.shiftCode)}</span>
      </div>
      <div class="hist-bottom">
        <span class="hist-times">${timesText}</span>
        <span class="hist-status ${status.cls}">${status.label}</span>
      </div>
    </div>`;
  }).join('');
}

function openDetail(id) {
  const e = window.entries.find(x => x.id === id);
  if (!e) return;
  detailId = id;
  const shift = getShift(e.shiftCode);
  const status = calcStatus(e.shiftCode, e.clockIn, e.clockOut);
  document.getElementById('detailTitle').textContent = `รายการวันที่ ${e.date}`;
  document.getElementById('detailBody').innerHTML = `
    <div class="detail-row"><span>กะ</span><span>${escapeHtml(e.shiftCode)} (${escapeHtml(shift ? shift.name : '-')})</span></div>
    <div class="detail-row"><span>เวลาเข้า</span><span>${escapeHtml(e.clockIn || '-')}</span></div>
    <div class="detail-row"><span>เวลาออก</span><span>${escapeHtml(e.clockOut || '-')}</span></div>
    ${e.note ? `<div class="detail-row"><span>หมายเหตุ</span><span>${escapeHtml(e.note)}</span></div>` : ''}
    <div class="detail-row total"><span>สถานะ</span><span>${status.label}</span></div>
  `;
  document.getElementById('detailModalBg').classList.add('active');
}

function closeDetail() {
  document.getElementById('detailModalBg').classList.remove('active');
  detailId = null;
}

function editEntryFromDetail() {
  const e = window.entries.find(x => x.id === detailId);
  if (!e) return;
  closeDetail();
  document.getElementById('dateInput').value = e.date;
  populateShiftSelect(e.shiftCode);
  onShiftChange();
  document.getElementById('clockInInput').value = e.clockIn || '';
  document.getElementById('clockOutInput').value = e.clockOut || '';
  document.getElementById('noteInput').value = e.note || '';
  editingId = e.id;
  document.getElementById('editingBanner').style.display = 'flex';
  updateStatusPreview();
  showTab('record');
}

async function deleteEntryFromDetail() {
  if (!detailId) return;
  const ok = await showConfirmModal('ต้องการลบรายการนี้หรือไม่?');
  if (!ok) return;
  window.entries = window.entries.filter(e => e.id !== detailId);
  saveData();
  closeDetail();
  renderHistory();
  showToast('🗑️ ลบรายการแล้ว');
}

// ---- TREND ----
function monthKey(dateStr) {
  return (dateStr || '').slice(0, 7); // YYYY-MM
}

function monthShortLabel(mk) {
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const [y, m] = mk.split('-');
  return months[parseInt(m, 10) - 1] + ' ' + (parseInt(y, 10) + 543).toString().slice(2);
}

function monthlyBuckets() {
  const map = {};
  window.entries.forEach(e => {
    const status = calcStatus(e.shiftCode, e.clockIn, e.clockOut);
    const mk = monthKey(e.date);
    if (!map[mk]) map[mk] = { lateMin: 0, present: 0, absent: 0 };
    map[mk].lateMin += status.lateMin + status.earlyMin;
    if (status.cls === 'off') { /* ไม่นับ */ }
    else if (status.cls === 'absent') map[mk].absent += 1;
    else map[mk].present += 1;
  });
  return Object.keys(map).sort().map(mk => ({ month: mk, ...map[mk] }));
}

function computeAttendanceSummary() {
  let ontimeDays = 0, lateDays = 0, absentDays = 0;
  let totalLateMin = 0, totalAbsentMin = 0, totalOtMin = 0;
  const items = [];
  window.entries.forEach(e => {
    const status = calcStatus(e.shiftCode, e.clockIn, e.clockOut);
    if (status.cls === 'off') return;
    totalOtMin += status.otMin || 0;
    if (status.cls === 'ontime') ontimeDays++;
    else if (status.cls === 'absent') {
      absentDays++;
      totalAbsentMin += status.lateMin + status.earlyMin;
      items.push({ date: e.date, label: status.label });
    } else if (status.cls === 'late' && status.lateMin > 0) {
      lateDays++;
      totalLateMin += status.lateMin;
      items.push({ date: e.date, label: status.label });
    }
  });
  items.sort((a, b) => b.date.localeCompare(a.date));
  return { ontimeDays, lateDays, absentDays, totalLateMin, totalAbsentMin, totalOtMin, items };
}

function renderAttendanceSummary() {
  const s = computeAttendanceSummary();
  document.getElementById('ontimeDays').textContent = s.ontimeDays;
  document.getElementById('lateDays').textContent = s.lateDays;
  document.getElementById('absentDays').textContent = s.absentDays;
  document.getElementById('totalLateMin').textContent = s.totalLateMin;
  document.getElementById('totalAbsentMin').textContent = s.totalAbsentMin;
  document.getElementById('totalOtHours').textContent = (s.totalOtMin / 60).toFixed(1);

  const list = document.getElementById('lateAbsentList');
  const empty = document.getElementById('lateAbsentEmpty');
  if (!s.items.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = s.items.slice(0, 20).map(it => `
    <div class="cat-row">
      <div>
        <div class="cat-name">${escapeHtml(it.date)}</div>
        <div class="cat-sub">${it.label}</div>
      </div>
    </div>
  `).join('');
}

function renderTrend() {
  renderAttendanceSummary();
  const buckets = monthlyBuckets();

  if (buckets.length) {
    const avg = buckets.reduce((s, b) => s + b.lateMin, 0) / buckets.length;
    const maxB = buckets.reduce((a, b) => b.lateMin > a.lateMin ? b : a);
    const minB = buckets.reduce((a, b) => b.lateMin < a.lateMin ? b : a);
    document.getElementById('avgLate').textContent = Math.round(avg);
    document.getElementById('maxLate').textContent = `${monthShortLabel(maxB.month)} (${maxB.lateMin} น.)`;
    document.getElementById('minLate').textContent = `${monthShortLabel(minB.month)} (${minB.lateMin} น.)`;
  } else {
    document.getElementById('avgLate').textContent = '0';
    document.getElementById('maxLate').textContent = '-';
    document.getElementById('minLate').textContent = '-';
  }

  drawLineChart(buckets);
  drawBarChart(buckets);
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 180 * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: 180 };
}

function drawLineChart(buckets) {
  const canvas = document.getElementById('trendChart');
  const emptyEl = document.getElementById('trendEmpty');
  if (buckets.length < 2) { canvas.style.display = 'none'; emptyEl.style.display = 'block'; return; }
  canvas.style.display = 'block'; emptyEl.style.display = 'none';

  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 44, r: 12, t: 12, b: 24 };
  const values = buckets.map(b => b.lateMin);
  const max = Math.max(...values, 1);
  const stepX = (w - pad.l - pad.r) / (buckets.length - 1);

  ctx.strokeStyle = '#223140'; ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + (h - pad.t - pad.b) * (i / 3);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    const val = max - (max * i / 3);
    ctx.fillStyle = '#7f93a3'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(Math.round(val).toLocaleString(), pad.l - 6, y + 3);
  }

  ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2; ctx.beginPath();
  values.forEach((v, i) => {
    const x = pad.l + i * stepX;
    const y = pad.t + (h - pad.t - pad.b) * (1 - v / max);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = '#fbbf24';
  values.forEach((v, i) => {
    const x = pad.l + i * stepX;
    const y = pad.t + (h - pad.t - pad.b) * (1 - v / max);
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  });

  ctx.fillStyle = '#7f93a3'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
  [0, Math.floor(buckets.length / 2), buckets.length - 1].forEach(i => {
    const x = pad.l + i * stepX;
    ctx.fillText(monthShortLabel(buckets[i].month), x, h - 6);
  });
}

function drawBarChart(buckets) {
  const canvas = document.getElementById('barChart');
  const emptyEl = document.getElementById('barEmpty');
  if (!buckets.length) { canvas.style.display = 'none'; emptyEl.style.display = 'block'; return; }
  canvas.style.display = 'block'; emptyEl.style.display = 'none';

  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 30, r: 12, t: 12, b: 24 };
  const recent = buckets.slice(-6);
  const max = Math.max(...recent.map(b => Math.max(b.present, b.absent)), 1);
  const groupW = (w - pad.l - pad.r) / recent.length;
  const barW = Math.min(16, groupW / 3);

  recent.forEach((b, i) => {
    const cx = pad.l + groupW * i + groupW / 2;
    const presH = (h - pad.t - pad.b) * (b.present / max);
    const absH = (h - pad.t - pad.b) * (b.absent / max);
    ctx.fillStyle = '#34d399';
    ctx.fillRect(cx - barW - 2, h - pad.b - presH, barW, presH);
    ctx.fillStyle = '#f87171';
    ctx.fillRect(cx + 2, h - pad.b - absH, barW, absH);
    ctx.fillStyle = '#7f93a3'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(monthShortLabel(b.month), cx, h - 6);
  });

  ctx.strokeStyle = '#223140'; ctx.beginPath();
  ctx.moveTo(pad.l, h - pad.b); ctx.lineTo(w - pad.r, h - pad.b); ctx.stroke();
}

// ---- SHIFT MANAGEMENT (settings tab) ----
function addShiftFromInput() {
  const code = document.getElementById('newShiftCode').value.trim();
  const name = document.getElementById('newShiftName').value.trim();
  const start = document.getElementById('newShiftStart').value;
  const end = document.getElementById('newShiftEnd').value;
  const isOff = document.getElementById('newShiftIsOff').checked;
  const otEligible = document.getElementById('newShiftOtEligible').checked;
  const otEnd = document.getElementById('newShiftOtEnd').value || '22:30';

  if (!code) { showToast('⚠️ กรุณาระบุรหัสกะ'); return; }
  const shifts = loadShifts();
  if (shifts.some(s => s.code === code)) { showToast('⚠️ มีรหัสกะนี้อยู่แล้ว'); return; }
  if (!isOff && (!start || !end)) { showToast('⚠️ กรุณาระบุเวลาเริ่ม-เลิก'); return; }

  shifts.push({ code, name: name || code, start: isOff ? '' : start, end: isOff ? '' : end, isOff, otEligible: isOff ? false : otEligible, otEnd: otEligible ? otEnd : '' });
  saveShifts(shifts);

  document.getElementById('newShiftCode').value = '';
  document.getElementById('newShiftName').value = '';
  document.getElementById('newShiftStart').value = '';
  document.getElementById('newShiftEnd').value = '';
  document.getElementById('newShiftIsOff').checked = false;
  document.getElementById('newShiftOtEligible').checked = false;
  document.getElementById('newShiftOtEnd').value = '22:30';
  document.getElementById('newShiftOtEndRow').style.display = 'none';
  renderShiftList();
  populateShiftSelect(document.getElementById('shiftSelect').value);
  showToast('✅ เพิ่มกะแล้ว');
}

function renderShiftList() {
  const list = document.getElementById('shiftList');
  const shifts = loadShifts();
  if (!shifts.length) {
    list.innerHTML = '<div class="empty-hint">ยังไม่มีกะที่ตั้งค่าไว้</div>';
    return;
  }
  list.innerHTML = shifts.map(s => `
    <div class="cat-row" data-code="${escapeHtml(s.code)}">
      <div>
        <div class="cat-name">${escapeHtml(s.code)} - ${escapeHtml(s.name)}</div>
        <div class="cat-sub">${s.isOff ? 'วันหยุด' : escapeHtml(s.start) + ' - ' + escapeHtml(s.end)}${s.otEligible ? ` · OT ถึง ${escapeHtml(s.otEnd)}` : ' · ไม่นับ OT'}</div>
      </div>
      <div class="cat-actions">
        <button type="button" data-action="rename">✏️</button>
        <button type="button" data-action="delete">🗑️</button>
      </div>
    </div>
  `).join('');
}

function startRenameShift(row) {
  const code = row.dataset.code;
  const shifts = loadShifts();
  const s = shifts.find(x => x.code === code);
  if (!s) return;
  row.innerHTML = `
    <div class="cat-rename-form">
      <div class="form-row">
        <input type="text" class="shift-edit-name" value="${escapeHtml(s.name)}" placeholder="ชื่อกะ">
        <input type="text" class="shift-edit-start" value="${escapeHtml(s.start)}" placeholder="เริ่ม HH:MM" ${s.isOff ? 'disabled' : ''}>
      </div>
      <div class="form-row">
        <input type="text" class="shift-edit-end" value="${escapeHtml(s.end)}" placeholder="เลิก HH:MM" ${s.isOff ? 'disabled' : ''}>
      </div>
      <label class="checkbox-row"><input type="checkbox" class="shift-edit-ot" ${s.otEligible ? 'checked' : ''} ${s.isOff ? 'disabled' : ''}> เป็นกะ OT</label>
      <div class="form-row">
        <input type="text" class="shift-edit-otend" value="${escapeHtml(s.otEnd || '22:30')}" placeholder="สิ้นสุด OT HH:MM" ${s.isOff ? 'disabled' : ''}>
        <div class="cat-actions">
          <button type="button" class="btn-cat-save" data-action="save-rename">✔️ บันทึก</button>
          <button type="button" class="btn-cat-cancel" data-action="cancel-rename">✕ ยกเลิก</button>
        </div>
      </div>
    </div>
  `;
}

function saveRenameShift(row) {
  const code = row.dataset.code;
  const shifts = loadShifts();
  const idx = shifts.findIndex(x => x.code === code);
  if (idx === -1) return;
  const name = row.querySelector('.shift-edit-name').value.trim();
  const start = row.querySelector('.shift-edit-start').value.trim();
  const end = row.querySelector('.shift-edit-end').value.trim();
  const otEligible = row.querySelector('.shift-edit-ot').checked;
  const otEnd = row.querySelector('.shift-edit-otend').value.trim() || '22:30';
  if (!name) { showToast('⚠️ กรุณาระบุชื่อกะ'); return; }
  shifts[idx].name = name;
  if (!shifts[idx].isOff) {
    shifts[idx].start = start;
    shifts[idx].end = end;
    shifts[idx].otEligible = otEligible;
    shifts[idx].otEnd = otEligible ? otEnd : '';
  }
  saveShifts(shifts);
  renderShiftList();
  populateShiftSelect(document.getElementById('shiftSelect').value);
  showToast('✅ แก้ไขกะแล้ว');
}

async function deleteShiftRow(row) {
  const code = row.dataset.code;
  const usedCount = window.entries.filter(e => e.shiftCode === code).length;
  const msg = usedCount
    ? `กะ "${code}" ถูกใช้ใน ${usedCount} รายการเก่า ข้อมูลเก่ายังอยู่แต่จะเลือกกะนี้ในรายการใหม่ไม่ได้อีก ยืนยันหรือไม่?`
    : `ลบกะ "${code}" หรือไม่?`;
  const ok = await showConfirmModal(msg);
  if (!ok) return;
  const shifts = loadShifts().filter(s => s.code !== code);
  saveShifts(shifts);
  renderShiftList();
  populateShiftSelect(document.getElementById('shiftSelect').value);
  showToast('🗑️ ลบกะแล้ว');
}

document.addEventListener('DOMContentLoaded', () => {
  const list = document.getElementById('shiftList');
  if (!list) return;
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('.cat-row');
    if (!row) return;
    const action = btn.dataset.action;
    if (action === 'rename') startRenameShift(row);
    else if (action === 'delete') deleteShiftRow(row);
    else if (action === 'save-rename') saveRenameShift(row);
    else if (action === 'cancel-rename') renderShiftList();
  });
});

// ---- BACKUP / RESTORE ----
function exportBackup() {
  const data = JSON.stringify({ entries: window.entries, shifts: loadShifts(), exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  a.href = url;
  a.download = `attendance-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📥 ส่งออกข้อมูลแล้ว');
}

async function importBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const incomingEntries = Array.isArray(parsed.entries) ? parsed.entries : null;
    if (!incomingEntries) { showToast('⚠️ ไฟล์ไม่ถูกต้อง'); return; }
    const ok = await showConfirmModal(`นำเข้า ${incomingEntries.length} รายการ จะรวมกับข้อมูลเดิม ยืนยันหรือไม่?`);
    if (!ok) return;
    const existingIds = new Set(window.entries.map(e => e.id));
    incomingEntries.forEach(e => {
      if (existingIds.has(e.id)) e.id = Date.now() + Math.floor(Math.random() * 1000);
      window.entries.push(e);
    });
    saveData();
    if (Array.isArray(parsed.shifts)) {
      const shifts = loadShifts();
      const codes = new Set(shifts.map(s => s.code));
      parsed.shifts.forEach(s => { if (!codes.has(s.code)) shifts.push(s); });
      saveShifts(shifts);
    }
    renderHistory();
    showToast('✅ นำเข้าข้อมูลสำเร็จ');
  } catch (e) {
    showToast('⚠️ อ่านไฟล์ไม่สำเร็จ');
  }
  event.target.value = '';
}

// ---- EXCEL EXPORT / IMPORT ----
function openExportModal() {
  const dates = window.entries.map(e => e.date).sort();
  document.getElementById('exportFromDate').value = dates[0] || '';
  document.getElementById('exportToDate').value = dates[dates.length - 1] || '';
  document.getElementById('exportModalBg').classList.add('active');
}

function closeExportModal() {
  document.getElementById('exportModalBg').classList.remove('active');
}

function confirmExportXlsx() {
  const from = document.getElementById('exportFromDate').value;
  const to = document.getElementById('exportToDate').value;
  if (from && to && from > to) { showToast('⚠️ ช่วงวันที่ไม่ถูกต้อง'); return; }
  closeExportModal();
  exportXlsx(from, to);
}

function exportXlsx(from, to) {
  const filtered = window.entries.filter(e => {
    if (from && e.date < from) return false;
    if (to && e.date > to) return false;
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date));

  if (!filtered.length) { showToast('⚠️ ไม่มีข้อมูลในช่วงที่เลือก'); return; }

  const rows = filtered.map(e => {
    const shift = getShift(e.shiftCode);
    const status = calcStatus(e.shiftCode, e.clockIn, e.clockOut);
    return {
      'วันที่': e.date,
      'รหัสกะ': e.shiftCode,
      'ชื่อกะ': shift ? shift.name : '',
      'เวลาเข้า': e.clockIn || '',
      'เวลาออก': e.clockOut || '',
      'สถานะ': status.label.replace(/^\S+\s/, ''),
      'หมายเหตุ': e.note || ''
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 20 }, { wch: 24 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ลงเวลา');
  const stamp = (from || filtered[0].date).replace(/-/g, '') + '_' + (to || filtered[filtered.length - 1].date).replace(/-/g, '');
  XLSX.writeFile(wb, `attendance-${stamp}.xlsx`);
  showToast('📊 ส่งออก Excel แล้ว');
}

function excelDateToStr(val) {
  if (val instanceof Date) {
    return `${val.getFullYear()}-${String(val.getMonth() + 1).padStart(2, '0')}-${String(val.getDate()).padStart(2, '0')}`;
  }
  return String(val || '').trim();
}

function excelTimeToStr(val) {
  if (val === undefined || val === null || val === '') return '';
  if (val instanceof Date) {
    return `${String(val.getHours()).padStart(2, '0')}:${String(val.getMinutes()).padStart(2, '0')}`;
  }
  if (typeof val === 'number') {
    const totalMin = Math.round(val * 24 * 60);
    return `${String(Math.floor(totalMin / 60) % 24).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
  }
  return String(val).trim();
}

async function importXlsx(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) { showToast('⚠️ ไม่พบข้อมูลในไฟล์'); return; }

    const incomingEntries = rows.map(r => ({
      id: Date.now() + Math.floor(Math.random() * 100000),
      date: excelDateToStr(r['วันที่'] ?? r['date'] ?? r['Date']),
      shiftCode: String(r['รหัสกะ'] ?? r['shiftCode'] ?? r['Shift'] ?? '').trim(),
      clockIn: excelTimeToStr(r['เวลาเข้า'] ?? r['clockIn']),
      clockOut: excelTimeToStr(r['เวลาออก'] ?? r['clockOut']),
      note: String(r['หมายเหตุ'] ?? r['note'] ?? '').trim()
    })).filter(e => e.date && e.shiftCode);

    if (!incomingEntries.length) { showToast('⚠️ ไฟล์ไม่ถูกต้อง'); return; }

    const ok = await showConfirmModal(`นำเข้า ${incomingEntries.length} รายการ จะรวมกับข้อมูลเดิม ยืนยันหรือไม่?`);
    if (!ok) return;

    incomingEntries.forEach(e => window.entries.push(e));
    saveData();
    renderHistory();
    showToast('✅ นำเข้า Excel สำเร็จ');
  } catch (e) {
    showToast('⚠️ อ่านไฟล์ Excel ไม่สำเร็จ');
  }
  event.target.value = '';
}

// ---- INIT ----
function initApp() {
  seedDefaultShiftsIfEmpty();
  migrateShiftOtFields();
  loadData();
  clearForm();
  renderHistory();
  window.addEventListener('resize', () => {
    if (document.getElementById('tab-trend').classList.contains('active')) renderTrend();
  });
}

initApp();
