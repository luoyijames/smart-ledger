'use strict';
/* =====================================================================
 * 智能记账 · app.js —— 界面与业务逻辑（依赖 lib.js）
 * 所有数据只保存在这台设备的浏览器里（IndexedDB），不会上传。币种：人民币 ¥
 * ===================================================================== */
const S = {
  tx: [], cats: [], rules: [], settings: {}, tab: 'home', imp: null, txEdit: null, persisted: null,
  ui: { list: { q: '', type: 'all', month: startOfMonth(Date.now()), shown: 80 }, stats: { range: 'month', from: '', to: '' } },
};
const TITLES = { home: '智能记账', list: '记账', stats: '统计', budget: '预算', settings: '设置' };
const defaultSettings = () => ({ theme: 'auto', budgetStartDay: 1, totalBudget: 0, catBudgets: {}, initialized: false, lastChannel: 'wechat', hideInstall: false });
const catOf = id => S.cats.find(c => c.id === id) || S.cats.find(c => c.id === 'pending') || DEFAULT_CATS[DEFAULT_CATS.length - 1];
const catsFor = type => S.cats.filter(c => c.type === 'both' || c.type === type);
const saveSettings = () => DB.setKV('settings', S.settings);
const saveCats = () => DB.setKV('cats', S.cats);
const saveRules = () => DB.setKV('rules', S.rules);

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}
async function safe(fn, failMsg = '保存失败，请重试') {
  try { return await fn(); } catch (e) { console.error(e); toast(failMsg); return undefined; }
}

/* ---------- 统计工具 ---------- */
const txIn = (a, b) => S.tx.filter(t => t.ts >= a && t.ts < b);
function sums(list) { let inc = 0, exp = 0; for (const t of list) { if (t.type === 'income') inc += t.amount; else if (t.type === 'expense') exp += t.amount; } return { inc, exp }; }
function byCat(list, type = 'expense') {
  const m = new Map();
  for (const t of list) if (t.type === type) { const o = m.get(t.cat) || { id: t.cat, v: 0, n: 0 }; o.v += t.amount; o.n++; m.set(t.cat, o); }
  return [...m.values()].map(o => ({ ...o, c: catOf(o.id) })).sort((a, b) => b.v - a.v);
}
function budgetPeriod(now = Date.now()) {
  const sd = S.settings.budgetStartDay || 1, d = new Date(now);
  let m = d.getMonth(); if (d.getDate() < sd) m--;
  return { start: new Date(d.getFullYear(), m, sd).getTime(), end: new Date(d.getFullYear(), m + 1, sd).getTime() };
}
function budgetStatus() {
  const p = budgetPeriod(); const list = txIn(p.start, p.end).filter(t => t.type === 'expense');
  const spent = list.reduce((s, t) => s + t.amount, 0);
  const total = S.settings.totalBudget || 0;
  const cats = []; const cb = S.settings.catBudgets || {};
  for (const id in cb) {
    if (!(cb[id] > 0) || !S.cats.some(c => c.id === id)) continue;
    const sp = list.filter(t => t.cat === id).reduce((s, t) => s + t.amount, 0);
    cats.push({ id, budget: cb[id], spent: sp, pct: sp / cb[id] * 100 });
  }
  return { p, total: { budget: total, spent, pct: total ? spent / total * 100 : 0 }, cats };
}
function alertList() {
  const b = budgetStatus(); const out = [];
  const add = (name, o) => {
    if (o.pct >= 100) out.push({ level: 'danger', text: `${name}已超出预算 ${fmt(o.spent - o.budget)}（已用 ${Math.round(o.pct)}%）` });
    else if (o.pct >= 80) out.push({ level: 'warn', text: `${name}已用 ${Math.round(o.pct)}%，剩余 ${fmt(o.budget - o.spent)}` });
  };
  if (b.total.budget > 0) add('本期总预算', b.total);
  b.cats.forEach(c => add(`「${catOf(c.id).name}」预算`, c));
  return out.sort((a, b) => (a.level === 'danger' ? 0 : 1) - (b.level === 'danger' ? 0 : 1));
}
const alertsHTML = max => alertList().slice(0, max || 9).map(a => `<div class="banner ${a.level}"><span>${a.level === 'danger' ? '🚨' : '⚠️'}</span><div class="grow">${esc(a.text)}</div></div>`).join('');

/* ---------- 图表（手写 SVG，无需联网） ---------- */
function donut(items, total, label) {
  const r = 46, c = 2 * Math.PI * r; let off = 0;
  const segs = items.map(it => { const len = c * it.v / total; const s = `<circle r="${r}" cx="60" cy="60" fill="none" stroke="${it.color}" stroke-width="16" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 60 60)"><title>${esc(it.name)} ${fmt(it.v)}</title></circle>`; off += len; return s; }).join('');
  return `<svg viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="类别占比"><circle r="${r}" cx="60" cy="60" fill="none" stroke="var(--line)" stroke-width="16"/>${segs}<text x="60" y="58" text-anchor="middle" style="font-size:9px">${esc(label)}</text><text x="60" y="71" text-anchor="middle" style="font-size:10px;font-weight:700;fill:var(--text)">${esc(fmt(total))}</text></svg>`;
}
function groupForDonut(rows, maxN = 6) {
  const items = rows.slice(0, maxN).map(r => ({ v: r.v, color: r.c.color, name: r.c.name }));
  const rest = rows.slice(maxN).reduce((s, r) => s + r.v, 0);
  if (rest > 0) items.push({ v: rest, color: '#9aa4b0', name: '其他合计' });
  return items;
}
function barChart(pts) {
  const W = 320, H = 104, top = 14, n = pts.length; if (!n) return '';
  const max = Math.max(1, ...pts.map(p => p.v)); const gap = n > 40 ? 1 : 2; const bw = Math.max(2, (W - gap * (n - 1)) / n);
  const bars = pts.map((p, i) => { const h = p.v / max * (H - top); return p.v > 0 ? `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, bw / 2).toFixed(1)}" style="fill:var(--accent)"><title>${esc(p.label)} ${fmt(p.v)}</title></rect>` : ''; }).join('');
  const idx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  const labs = idx.map((i, k) => `<text x="${(i * (bw + gap) + bw / 2).toFixed(1)}" y="${H + 12}" text-anchor="${k === 0 ? 'start' : k === idx.length - 1 && idx.length > 1 ? 'end' : 'middle'}">${esc(pts[i].label)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H + 16}" width="100%" role="img" aria-label="每日支出趋势"><line x1="0" x2="${W}" y1="${H}" y2="${H}" style="stroke:var(--line)"/><text x="0" y="9">峰值 ${esc(fmt(max))}</text>${bars}${labs}</svg>`;
}

/* ---------- 弹层 ---------- */
function openSheet(html, { full = false, cls = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap ' + cls;
  wrap.innerHTML = `<div class="backdrop" data-act="sheet-close"></div><div class="sheet ${full ? 'full' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  $('#sheet-root').appendChild(wrap); document.body.classList.add('noscroll');
  return wrap;
}
function closeSheet(wrap) {
  wrap = wrap || $('#sheet-root').lastElementChild; if (!wrap) return;
  if (wrap._resolve) { const r = wrap._resolve; wrap._resolve = null; r(null); }
  wrap.remove();
  if (!$('#sheet-root').children.length) document.body.classList.remove('noscroll');
  if (wrap.dataset.kind === 'import') S.imp = null;
  if (wrap.dataset.kind === 'tx') S.txEdit = null;
}
/* 对话框：返回按钮的 value；点击空白处返回 null */
function dialog({ title, msg = '', buttons, input }) {
  return new Promise(resolve => {
    const bs = buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-act="dlg" data-i="${i}" ${input && b.needInput ? 'disabled' : ''}>${esc(b.label)}</button>`).join('');
    const wrap = openSheet(`<h3>${esc(title)}</h3><p>${esc(msg)}</p>${input ? `<div class="field"><input class="in" id="dlg-in" placeholder="请输入：${esc(input)}" autocomplete="off"></div>` : ''}<div style="display:grid;gap:8px">${bs}</div>`, { cls: 'alert-wrap' });
    wrap._buttons = buttons; wrap._resolve = resolve; wrap._input = input;
    if (input) $('#dlg-in', wrap).addEventListener('input', e => { const ok = e.target.value.trim() === input; $$('[data-act=dlg]', wrap).forEach((b, i) => { if (buttons[i].needInput) b.disabled = !ok; }); });
  });
}
const confirmBox = ({ title, msg, okText = '确定', danger = false }) => dialog({ title, msg, buttons: [{ label: okText, value: true, cls: danger ? 'danger' : '' }, { label: '取消', value: false, cls: 'sec' }] }).then(v => v === true);

/* ---------- 渲染 ---------- */
function render() {
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const showAdd = ['home', 'list'].includes(S.tab);
  $('#top').innerHTML = `<div><h1>${TITLES[S.tab]}</h1>${S.tab === 'home' ? `<div class="sub">${dayLabel(Date.now())} · 币种：人民币 ¥</div>` : ''}</div>${showAdd ? '<button class="btn-ic" data-act="add" data-type="expense" aria-label="记一笔">＋</button>' : ''}`;
  $('#view').innerHTML = ({ home: viewHome, list: viewList, stats: viewStats, budget: viewBudget, settings: viewSettings }[S.tab])();
  if (S.tab === 'list') renderListResults();
}
function setTab(tab) { S.tab = tab; render(); window.scrollTo(0, 0); }

const txRowHTML = (t, showDate = true) => {
  const c = catOf(t.cat), inc = t.type === 'income';
  const sub = [c.name, chName(t.channel), showDate ? fmtDT(t.ts) : fmtTime(t.ts)].concat(t.note ? [t.note] : []).join(' · ');
  return `<button class="tx" data-act="edit" data-id="${esc(t.id)}"><span class="ico" style="background:${c.color}26">${esc(c.icon)}</span><span class="grow"><div class="t1">${esc(t.merchant || c.name)}</div><div class="t2">${esc(sub)}</div></span><span class="amt num ${inc ? 'inc' : 'exp'}">${inc ? '+' : '-'}${fmt(t.amount)}</span></button>`;
};

/* ----- 首页 ----- */
function viewHome() {
  const now = Date.now(), sod = startOfDay(now), sow = startOfWeek(now), som = startOfMonth(now);
  const td = sums(txIn(sod, addDays(sod, 1))), wk = sums(txIn(sow, addDays(sow, 7))), mo = sums(txIn(som, addMonths(som, 1)));
  const b = budgetStatus(), bt = b.total;
  const demo = S.tx.some(t => t.source === 'demo');
  const rows = byCat(txIn(som, addMonths(som, 1)));
  const recent = [...S.tx].sort((a, b) => b.ts - a.ts).slice(0, 5);
  const standalone = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  let h = '';
  if (DB.useMem) h += `<div class="banner danger"><span>⚠️</span><div class="grow"><b>本地存储不可用</b>当前浏览器没有允许保存数据，关闭页面后记录会丢失。请用 Safari 正常（非无痕）模式打开。</div></div>`;
  if (isIOS() && !standalone && !S.settings.hideInstall) h += `<div class="banner"><span>📲</span><div class="grow"><b>安装到主屏幕</b>点 Safari 底部的“分享”按钮 → “添加到主屏幕”。</div><button data-act="hide-install">知道了</button></div>`;
  if (demo) h += `<div class="banner warn"><span>🧪</span><div class="grow"><b>当前包含演示数据</b>这些不是你的真实账单，仅用于体验。</div><button data-act="clear-demo">一键清空</button></div>`;
  h += alertsHTML(3);
  const bpct = Math.min(100, bt.pct);
  h += `<div class="card hero"><div class="lbl">本月支出</div><div class="big num">${fmt(mo.exp)}</div>
    <div class="mini"><div>收入<b class="num">${fmt(mo.inc)}</b></div><div>结余<b class="num">${fmt(mo.inc - mo.exp)}</b></div></div>
    <div style="margin-top:14px">${bt.budget > 0 ? `<div class="row between" style="font-size:13px;margin-bottom:6px"><span>总预算 ${fmt(bt.budget)}</span><span>${bt.budget - bt.spent >= 0 ? '剩余 ' + fmt(bt.budget - bt.spent) : '超支 ' + fmt(bt.spent - bt.budget)}</span></div><div class="bar ${bt.pct >= 100 ? 'over' : bt.pct >= 80 ? 'warn' : ''}"><i style="width:${bpct}%"></i></div><div style="font-size:12px;opacity:.8;margin-top:5px">预算周期 ${fmtDate(b.p.start).slice(5)} ~ ${fmtDate(b.p.end - 1).slice(5)} · 已用 ${Math.round(bt.pct)}%</div>` : `<div class="row between" style="font-size:13px"><span>还没有设置本月预算</span><button data-act="goto" data-tab="budget" style="color:#fff;font-weight:700;text-decoration:underline">去设置</button></div>`}</div></div>`;
  h += `<div class="actions"><button class="act main" data-act="add" data-type="expense"><i>➖</i>记支出</button><button class="act" data-act="add" data-type="income"><i>➕</i>记收入</button><button class="act" data-act="import"><i>📥</i>导入账单</button></div>`;
  h += `<div class="card"><table class="tbl"><thead><tr><th></th><th>支出</th><th>收入</th></tr></thead><tbody>
    <tr><td>今日</td><td class="num exp">${fmt(td.exp)}</td><td class="num inc">${fmt(td.inc)}</td></tr>
    <tr><td>本周</td><td class="num exp">${fmt(wk.exp)}</td><td class="num inc">${fmt(wk.inc)}</td></tr>
    <tr><td>本月</td><td class="num exp">${fmt(mo.exp)}</td><td class="num inc">${fmt(mo.inc)}</td></tr></tbody></table></div>`;
  if (rows.length) {
    const total = rows.reduce((s, r) => s + r.v, 0);
    h += `<div class="card"><h2>本月支出类别 <small>占比</small></h2><div class="donut-row">${donut(groupForDonut(rows), total, '本月支出')}<div class="legend">${rows.slice(0, 6).map(r => `<div><i style="background:${r.c.color}"></i><span class="n">${esc(r.c.name)}</span><span class="num">${fmt(r.v)} · ${(r.v / total * 100).toFixed(0)}%</span></div>`).join('')}</div></div></div>`;
  }
  h += `<div class="card"><div class="row between"><h2 style="margin:0">最近交易</h2>${S.tx.length ? '<button data-act="goto" data-tab="list" style="color:var(--accent);font-weight:600">全部</button>' : ''}</div>${recent.length ? recent.map(t => txRowHTML(t)).join('') : '<div class="empty">还没有记录<br>点上方“记支出”开始，或导入微信/支付宝账单</div>'}</div>`;
  return h;
}

/* ----- 记账（明细）页 ----- */
function viewList() {
  const u = S.ui.list;
  return `<div class="actions" style="grid-template-columns:1fr 1fr 1fr"><button class="act main" data-act="add" data-type="expense"><i>➖</i>记支出</button><button class="act" data-act="add" data-type="income"><i>➕</i>记收入</button><button class="act" data-act="import"><i>📥</i>导入账单</button></div>
  <div class="field search"><input class="in" id="list-q" type="search" placeholder="搜索商家、备注、类别、金额" value="${esc(u.q)}" enterkeyhint="search" autocomplete="off"></div>
  <div class="chips scroll" style="margin-bottom:10px">${[['all', '全部'], ['expense', '支出'], ['income', '收入'], ['pending', '待确认']].map(([k, n]) => `<button class="chip ${u.type === k ? 'on' : ''}" data-act="list-type" data-v="${k}">${n}</button>`).join('')}</div>
  <div class="row between" style="margin-bottom:10px"><button class="btn-ic" data-act="list-month" data-d="-1" aria-label="上个月">‹</button><button class="grow chip on" data-act="list-month" data-d="0" style="text-align:center">${u.month == null ? '全部时间（点此回到本月）' : new Date(u.month).getFullYear() + '年' + (new Date(u.month).getMonth() + 1) + '月（点此切换全部）'}</button><button class="btn-ic" data-act="list-month" data-d="1" aria-label="下个月">›</button></div>
  <div id="list-results"></div>`;
}
function renderListResults() {
  const box = $('#list-results'); if (!box) return;
  const u = S.ui.list; let items = S.tx;
  if (u.month != null) items = items.filter(t => t.ts >= u.month && t.ts < addMonths(u.month, 1));
  if (u.type === 'expense' || u.type === 'income') items = items.filter(t => t.type === u.type);
  else if (u.type === 'pending') items = items.filter(t => t.cat === 'pending');
  const q = u.q.trim().toLowerCase();
  if (q) items = items.filter(t => [t.merchant, t.note, catOf(t.cat).name, yuan(t.amount), chName(t.channel)].join(' ').toLowerCase().includes(q));
  items = [...items].sort((a, b) => b.ts - a.ts);
  const s = sums(items);
  let h = `<div class="card" style="padding:12px 16px"><div class="row between"><span class="muted">共 ${items.length} 笔</span><span class="num"><span class="exp">支 ${fmt(s.exp)}</span> &nbsp; <span class="inc">收 ${fmt(s.inc)}</span></span></div></div>`;
  if (!items.length) h += `<div class="empty">${S.tx.length ? '没有符合条件的记录' : '还没有记录'}</div>`;
  else {
    const shown = items.slice(0, u.shown); let cur = ''; let html = '';
    const dayTotals = {}; items.forEach(t => { const k = fmtDate(t.ts); dayTotals[k] = (dayTotals[k] || 0) + (t.type === 'expense' ? t.amount : 0); });
    for (const t of shown) {
      const k = fmtDate(t.ts);
      if (k !== cur) { if (cur) html += '</div>'; cur = k; html += `<div class="dayh"><span>${dayLabel(t.ts)}</span><span class="num">支出 ${fmt(dayTotals[k])}</span></div><div class="card" style="padding:4px 16px;margin-bottom:6px">`; }
      html += txRowHTML(t, false);
    }
    h += html + '</div>';
    if (items.length > shown.length) h += `<button class="btn sec" data-act="list-more" style="margin-top:10px">显示更多（还有 ${items.length - shown.length} 笔）</button>`;
  }
  box.innerHTML = h;
}

/* ----- 统计页 ----- */
function statsRange() {
  const u = S.ui.stats, now = Date.now(), sod = startOfDay(now); let a, b, label;
  if (u.range === 'today') { a = sod; b = addDays(sod, 1); label = '今日'; }
  else if (u.range === 'week') { a = startOfWeek(now); b = addDays(a, 7); label = '本周'; }
  else if (u.range === 'month') { a = startOfMonth(now); b = addMonths(now, 1); label = '本月'; }
  else if (u.range === 'last') { a = addMonths(now, -1); b = startOfMonth(now); label = '上月'; }
  else if (u.range === '30') { a = addDays(sod, -29); b = addDays(sod, 1); label = '近 30 天'; }
  else { a = fromDateInput(u.from); b = fromDateInput(u.to, true); label = '自定义'; if (isNaN(a) || isNaN(b) || b <= a) return null; }
  return { a, b, label };
}
function viewStats() {
  const u = S.ui.stats;
  if (!u.from) { u.from = fmtDate(startOfMonth(Date.now())); u.to = fmtDate(Date.now()); }
  const chips = [['today', '今日'], ['week', '本周'], ['month', '本月'], ['last', '上月'], ['30', '近30天'], ['custom', '自定义']];
  let h = `<div class="chips scroll" style="margin-bottom:12px">${chips.map(([k, n]) => `<button class="chip ${u.range === k ? 'on' : ''}" data-act="stats-range" data-v="${k}">${n}</button>`).join('')}</div>`;
  if (u.range === 'custom') h += `<div class="card"><div class="row"><div class="grow"><label class="lbl2">开始日期</label><input type="date" class="in" id="st-from" value="${esc(u.from)}"></div><div class="grow"><label class="lbl2">结束日期</label><input type="date" class="in" id="st-to" value="${esc(u.to)}"></div></div></div>`;
  const R = statsRange();
  if (!R) return h + '<div class="empty">请选择有效的日期范围（结束日期不能早于开始日期）</div>';
  const list = txIn(R.a, R.b), s = sums(list), exps = list.filter(t => t.type === 'expense');
  if (!list.length) return h + `<div class="card"><div class="empty">${R.label}范围内没有记录</div></div>` + compareCard() + budgetOverCard();
  const now = Date.now(), last = Math.min(R.b - 1, now);
  const days = last >= R.a ? dayIndex(last) - dayIndex(R.a) + 1 : 0;
  const max = exps.reduce((m, t) => (t.amount > (m ? m.amount : 0) ? t : m), null);
  const fixedV = exps.filter(t => catOf(t.cat).fixed).reduce((x, t) => x + t.amount, 0);
  const mx = Math.max(s.inc, s.exp, 1);
  h += `<div class="card"><h2>收入与支出 <small>${R.label}</small></h2>
    <div class="row between"><span>收入</span><b class="num inc">${fmt(s.inc)}</b></div><div class="bar" style="margin:6px 0 12px"><i style="width:${s.inc / mx * 100}%;background:var(--inc)"></i></div>
    <div class="row between"><span>支出</span><b class="num exp">${fmt(s.exp)}</b></div><div class="bar" style="margin:6px 0 12px"><i style="width:${s.exp / mx * 100}%;background:var(--exp)"></i></div>
    <div class="row between"><span>结余</span><b class="num">${fmt(s.inc - s.exp)}</b></div></div>`;
  h += `<div class="card"><h2>支出概览</h2><div class="kv">
    <div><small>最大单笔支出</small><b class="num">${max ? fmt(max.amount) : '—'}</b>${max ? `<small>${esc(max.merchant || catOf(max.cat).name)} · ${fmtDate(max.ts).slice(5)}</small>` : ''}</div>
    <div><small>平均每日支出</small><b class="num">${days ? fmt(Math.round(s.exp / days)) : '—'}</b><small>按 ${days} 天计算</small></div>
    <div><small>固定支出</small><b class="num">${fmt(fixedV)}</b><small>${s.exp ? Math.round(fixedV / s.exp * 100) : 0}%（类别标记为固定）</small></div>
    <div><small>可变支出</small><b class="num">${fmt(s.exp - fixedV)}</b><small>${s.exp ? Math.round((s.exp - fixedV) / s.exp * 100) : 0}% · 共 ${exps.length} 笔</small></div></div>
    <div class="hint">“固定支出”取决于类别设置：在 设置 → 类别管理 中可修改哪些类别算固定。</div></div>`;
  const rows = byCat(list);
  if (rows.length) {
    const tot = rows.reduce((x, r) => x + r.v, 0);
    h += `<div class="card"><h2>类别排行 <small>占比</small></h2><div class="donut-row" style="margin-bottom:8px">${donut(groupForDonut(rows), tot, '支出')}<div class="legend">${rows.slice(0, 6).map(r => `<div><i style="background:${r.c.color}"></i><span class="n">${esc(r.c.name)}</span><span class="num">${(r.v / tot * 100).toFixed(0)}%</span></div>`).join('')}</div></div>
    ${rows.map((r, i) => `<div class="rank"><span class="ico" style="width:34px;height:34px;font-size:17px;background:${r.c.color}26">${esc(r.c.icon)}</span><span>${i + 1}. ${esc(r.c.name)} <span class="muted">${r.n} 笔</span></span><b class="num">${fmt(r.v)} <span class="muted">${(r.v / tot * 100).toFixed(1)}%</span></b><div class="bar"><i style="width:${r.v / rows[0].v * 100}%;background:${r.c.color}"></i></div></div>`).join('')}</div>`;
  }
  // 趋势：天数 ≤ 62 按天，否则按周
  const endDay = Math.min(R.b, addDays(startOfDay(now), 1)); const pts = [];
  const nDays = dayIndex(endDay - 1) - dayIndex(R.a) + 1;
  if (nDays > 0) {
    if (nDays <= 62) { for (let d = R.a; d < endDay; d = addDays(d, 1)) { const v = sums(txIn(d, addDays(d, 1))).exp; pts.push({ label: fmtDate(d).slice(5), v }); } }
    else { for (let d = R.a; d < endDay; d = addDays(d, 7)) { const v = sums(txIn(d, Math.min(addDays(d, 7), R.b))).exp; pts.push({ label: fmtDate(d).slice(5) + '周', v }); } }
    h += `<div class="card"><h2>${nDays <= 62 ? '每日' : '每周'}支出趋势</h2>${barChart(pts)}</div>`;
  }
  h += compareCard() + budgetOverCard();
  const ins = insights(list, R, days);
  h += `<div class="card"><h2>消费习惯与建议 <small>仅基于你的真实记录</small></h2>${ins.map(i => `<div class="tip ${i.warn ? 'warn' : ''}">${esc(i.t)}</div>`).join('')}</div>`;
  return h;
}
function compareCard() {
  const now = Date.now(), som = startOfMonth(now), pm = addMonths(now, -1);
  const elapsed = dayIndex(now) - dayIndex(som) + 1;
  const prevDays = dayIndex(som) - dayIndex(pm);
  const nd = Math.min(elapsed, prevDays);
  const cur = sums(txIn(som, addDays(startOfDay(now), 1))).exp;
  const prevSame = sums(txIn(pm, addDays(pm, nd))).exp, prevAll = sums(txIn(pm, som)).exp;
  if (!prevAll) return `<div class="card"><h2>本月与上月比较</h2><div class="muted">上月没有支出记录，暂时无法比较。</div></div>`;
  const diff = cur - prevSame, pct = prevSame ? diff / prevSame * 100 : 0;
  return `<div class="card"><h2>本月与上月比较</h2><div class="kv"><div><small>本月至今（${elapsed} 天）</small><b class="num">${fmt(cur)}</b></div><div><small>上月同期（${nd} 天）</small><b class="num">${fmt(prevSame)}</b></div></div>
  <div class="tip">${prevSame ? `本月至今比上月同期${diff >= 0 ? '多' : '少'}花 ${fmt(Math.abs(diff))}（${Math.abs(pct).toFixed(0)}%）。` : '上月同期没有支出。'}上月全月支出共 ${fmt(prevAll)}。</div></div>`;
}
function budgetOverCard() {
  const b = budgetStatus(); const over = b.cats.filter(c => c.pct >= 100);
  if (!(b.total.budget > 0) && !b.cats.length) return '';
  const lines = [];
  if (b.total.budget > 0 && b.total.pct >= 100) lines.push(`总预算超支 ${fmt(b.total.spent - b.total.budget)}`);
  over.forEach(c => lines.push(`「${catOf(c.id).name}」超支 ${fmt(c.spent - c.budget)}（预算 ${fmt(c.budget)}）`));
  return `<div class="card"><h2>超预算类别 <small>当前预算周期</small></h2>${lines.length ? lines.map(l => `<div class="tip warn">${esc(l)}</div>`).join('') : '<div class="muted">目前没有超出预算的项目。</div>'}</div>`;
}
function insights(list, R, days) {
  const exps = list.filter(t => t.type === 'expense'); const out = [];
  const total = exps.reduce((s, t) => s + t.amount, 0);
  const daySet = new Set(exps.map(t => fmtDate(t.ts)));
  if (exps.length < 10 || daySet.size < 5) return [{ t: `样本不足：当前范围只有 ${exps.length} 笔支出、覆盖 ${daySet.size} 天。至少需要约 10 笔支出、5 个有记录的日期才能做可靠分析，所以暂不给出结论。` }];
  const rows = byCat(exps);
  if (rows[0].v / total >= 0.4) out.push({ t: `「${rows[0].c.name}」占总支出 ${(rows[0].v / total * 100).toFixed(0)}%（${fmt(rows[0].v)}），是最大的一项。` });
  else out.push({ t: `支出最多的是「${rows[0].c.name}」，占 ${(rows[0].v / total * 100).toFixed(0)}%，没有明显过度集中在某一类。` });
  const small = exps.filter(t => t.amount < 3000); const sv = small.reduce((s, t) => s + t.amount, 0);
  if (small.length >= 10 && sv / total >= 0.15) out.push({ t: `¥30 以下的小额支出共 ${small.length} 笔，合计 ${fmt(sv)}，占 ${(sv / total * 100).toFixed(0)}%。笔数多、容易被忽略。` });
  const wkd = new Map(), wke = new Map();
  exps.forEach(t => { const d = new Date(t.ts).getDay(); (d === 0 || d === 6 ? wke : wkd).set(fmtDate(t.ts), ((d === 0 || d === 6 ? wke : wkd).get(fmtDate(t.ts)) || 0) + t.amount); });
  if (wkd.size >= 3 && wke.size >= 3) {
    const a = [...wkd.values()].reduce((s, x) => s + x, 0) / wkd.size, b = [...wke.values()].reduce((s, x) => s + x, 0) / wke.size;
    if (b > a * 1.5) out.push({ t: `周末有记录的日子平均每天花 ${fmt(Math.round(b))}，约是工作日（${fmt(Math.round(a))}）的 ${(b / a).toFixed(1)} 倍。` });
    else if (a > b * 1.5) out.push({ t: `工作日有记录的日子平均每天花 ${fmt(Math.round(a))}，高于周末（${fmt(Math.round(b))}）。` });
  }
  const pend = list.filter(t => t.cat === 'pending').length;
  if (pend) out.push({ t: `有 ${pend} 笔记录还在「待确认」类别，分类后统计会更准确。`, warn: true });
  const top = rows.find(r => r.c.id !== 'pending' && !r.c.fixed);
  if (top) out.push({ t: `参考算术：如果把可调整的「${top.c.name}」减少 10%，在这段时间内约可节省 ${fmt(Math.round(top.v * 0.1))}。` });
  if (days > 0 && total) out.push({ t: `这段时间日均支出 ${fmt(Math.round(total / days))}。` });
  return out;
}

/* ----- 预算页 ----- */
function viewBudget() {
  const b = budgetStatus(); const cats = S.cats.filter(c => (c.type === 'expense' || c.type === 'both') && c.id !== 'pending');
  const sd = S.settings.budgetStartDay || 1;
  let h = `<div id="bud-alerts">${alertsHTML()}</div>
  <div class="card"><h2>每月总支出预算</h2><div class="row"><span class="muted">¥</span><input class="in grow num" id="bud-total" inputmode="decimal" placeholder="未设置" value="${S.settings.totalBudget ? yuan(S.settings.totalBudget) : ''}" autocomplete="off"></div>
  <div id="bud-total-bar" style="margin-top:12px"></div>
  <div class="field" style="margin:14px 0 0"><label>预算周期（每月从几号开始）</label><select class="in" id="bud-start">${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${sd === i + 1 ? 'selected' : ''}>每月 ${i + 1} 号</option>`).join('')}</select><div class="hint" id="bud-period"></div></div></div>
  <div class="card"><h2>各类别预算 <small>留空表示不设置</small></h2>${cats.map(c => `<div class="bud" data-cat="${esc(c.id)}"><div class="row"><span class="ico" style="width:34px;height:34px;font-size:17px;background:${c.color}26">${esc(c.icon)}</span><span class="grow">${esc(c.name)}<div class="muted bud-meta"></div></span><input class="in num" inputmode="decimal" placeholder="不限" data-bud="${esc(c.id)}" value="${S.settings.catBudgets[c.id] ? yuan(S.settings.catBudgets[c.id]) : ''}" autocomplete="off"></div><div class="bar"><i style="width:0"></i></div></div>`).join('')}</div>
  <div class="hint" style="padding:0 4px">提醒规则：用到预算的 80% 显示黄色提醒，达到 100% 显示红色提醒。提醒只在打开 App 时显示（iPhone 网页应用无法保证后台推送）。</div>`;
  setTimeout(updateBudgetUI, 0);
  return h;
}
function updateBudgetUI() {
  if (S.tab !== 'budget') return;
  const b = budgetStatus(); const t = b.total;
  const paint = (barWrap, o) => { if (!barWrap) return; const bar = $('.bar', barWrap); bar.className = 'bar ' + (o.pct >= 100 ? 'over' : o.pct >= 80 ? 'warn' : ''); $('i', bar).style.width = Math.min(100, o.pct) + '%'; };
  const tb = $('#bud-total-bar');
  if (tb) tb.innerHTML = t.budget > 0 ? `<div class="row between" style="font-size:14px;margin-bottom:6px"><span>已用 ${fmt(t.spent)}（${Math.round(t.pct)}%）</span><b class="num ${t.budget - t.spent < 0 ? 'exp' : ''}">${t.budget - t.spent >= 0 ? '剩余 ' + fmt(t.budget - t.spent) : '超支 ' + fmt(t.spent - t.budget)}</b></div><div class="bar ${t.pct >= 100 ? 'over' : t.pct >= 80 ? 'warn' : ''}"><i style="width:${Math.min(100, t.pct)}%"></i></div>` : `<div class="muted">本期已支出 ${fmt(t.spent)}。设置预算后会显示进度。</div>`;
  const pe = $('#bud-period'); if (pe) pe.textContent = `当前预算周期：${fmtDate(b.p.start)} ~ ${fmtDate(b.p.end - 1)}`;
  $$('.bud').forEach(row => {
    const id = row.dataset.cat; const o = b.cats.find(c => c.id === id);
    const spent = txIn(b.p.start, b.p.end).filter(x => x.type === 'expense' && x.cat === id).reduce((s, x) => s + x.amount, 0);
    $('.bud-meta', row).textContent = o ? `已用 ${fmt(o.spent)} · ${o.budget - o.spent >= 0 ? '剩余 ' + fmt(o.budget - o.spent) : '超支 ' + fmt(o.spent - o.budget)}` : `本期已支出 ${fmt(spent)}`;
    if (o) paint(row, o); else { const bar = $('.bar', row); bar.className = 'bar'; $('i', bar).style.width = '0'; }
  });
  const al = $('#bud-alerts'); if (al) al.innerHTML = alertsHTML();
}

/* ----- 设置页 ----- */
function viewSettings() {
  const it = (act, ic, t, sub, extra = '') => `<button class="item ${extra}" data-act="${act}"><span style="font-size:20px">${ic}</span><span class="grow">${t}${sub ? `<small>${sub}</small>` : ''}</span><span class="arrow">›</span></button>`;
  const th = S.settings.theme;
  return `<div class="sect">外观</div><div class="card"><div class="seg" id="theme-seg">${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([k, n]) => `<button class="${th === k ? 'on' : ''}" data-act="theme" data-v="${k}">${n}</button>`).join('')}</div></div>
  <div class="sect">账单导入</div><div class="card list">${it('import', '📥', '导入账单文件', '支持 CSV、Excel(.xlsx)；导入前先预览确认')}${it('dl-template', '📄', '下载示例 CSV 模板', '微信 / 支付宝 / 银行卡 三种示例格式')}</div>
  <div class="hint" style="margin:-4px 4px 12px">⚠️ 微信、支付宝、银行卡的识别规则是按常见公开格式编写的，<b>尚未用你的真实账单验证</b>。导入前请务必在预览里核对金额、收支方向和日期。</div>
  <div class="sect">数据与备份</div><div class="card list">${it('export-csv', '📤', '导出全部记录（CSV）', '可用 Excel / Numbers 打开，也能再导入')}${it('export-json', '💾', '备份全部数据（JSON）', '含记录、类别、规则、预算设置')}${it('restore', '♻️', '从备份恢复', '选择之前备份的 JSON 文件')}</div>
  <div class="sect">管理</div><div class="card list">${it('cats', '🏷️', '类别管理', '新增、修改、删除类别，设置哪些算固定支出')}${it('rules', '🧠', '分类规则', `已学习 ${S.rules.length} 条（你修改分类时自动记录）`)}${S.tx.some(t => t.source === 'demo') ? it('clear-demo', '🧪', '清空演示数据', '只删除标注为演示的记录') : ''}</div>
  <div class="sect">危险操作</div><div class="card list">${it('clear-all', '🗑️', '清空所有数据', '删除全部记录、类别、规则和预算（需二次确认）', 'danger')}</div>
  <div class="sect">关于与隐私</div><div class="card"><div style="font-size:14px;line-height:1.7">
  <b>币种：</b>人民币（CNY，¥）<br><b>版本：</b>${APP_VERSION}　<b>记录数：</b>${S.tx.length}<br>
  <b>数据存放：</b>仅保存在这台 iPhone 的 Safari/主屏幕应用的本地数据库（IndexedDB），不会上传到任何服务器，不收集任何密码或验证码。<br>
  <b>持久存储：</b>${S.persisted === true ? '已获得系统保障' : S.persisted === false ? '未获得（系统在空间紧张或长期不用时可能清理）' : '未知'}<br>
  <div class="tip warn" style="margin-top:8px">⚠️ 卸载主屏幕应用、清除 Safari 网站数据、更换手机，都可能导致本地数据丢失。请定期用上面的“备份全部数据”导出并保存到“文件”App。</div></div></div>`;
}

/* ---------- 记一笔 / 编辑 ---------- */
function openTxSheet(id, presetType) {
  const t = id ? S.tx.find(x => x.id === id) : null;
  const st = S.txEdit = { id: t ? t.id : null, orig: t || null, type: t ? t.type : (presetType || 'expense'), cat: t ? t.cat : null, catTouched: !!t, ts: t ? t.ts : Date.now(), channel: t ? t.channel : (S.settings.lastChannel || 'wechat') };
  const wrap = openSheet(`<div class="grab"></div><div class="sheet-head"><button class="x" data-act="sheet-close">取消</button><h3>${t ? '编辑记录' : '记一笔'}</h3><button class="x" data-act="tx-save" style="font-weight:700">保存</button></div>
  <div class="seg" id="tx-type"><button data-act="tx-type" data-v="expense" class="exp">支出</button><button data-act="tx-type" data-v="income" class="inc">收入</button></div>
  <div class="field" style="margin-top:14px"><input id="tx-amount" class="in amount-in num" inputmode="decimal" placeholder="0.00" autocomplete="off" enterkeyhint="done" value="${t ? yuan(t.amount) : ''}"><div class="err" id="tx-err"></div></div>
  <div class="field"><label>类别</label><div class="chips" id="tx-cats"></div><div class="hint" id="tx-cathint"></div></div>
  <div class="field"><label>日期与时间</label><input type="datetime-local" id="tx-dt" class="in" value="${toLocalInput(st.ts)}"></div>
  <div class="field"><label>支付渠道</label><div class="chips" id="tx-ch"></div></div>
  <div class="field"><label>商家 / 交易对象</label><input id="tx-merchant" class="in" placeholder="例如：美团外卖" autocomplete="off" value="${t ? esc(t.merchant) : ''}"></div>
  <div class="field"><label>备注</label><input id="tx-note" class="in" placeholder="可选" autocomplete="off" value="${t ? esc(t.note) : ''}"></div>
  <div class="btns" style="margin-top:6px">${t ? '<button class="btn ghost" data-act="tx-del" style="flex:0 0 auto;width:auto;padding:0 14px">删除</button>' : ''}<button class="btn" data-act="tx-save">保存</button></div>`, { full: false });
  wrap.dataset.kind = 'tx';
  paintTxSheet();
  if (!t) setTimeout(() => { const a = $('#tx-amount'); if (a) a.focus(); }, 280);
}
function paintTxSheet() {
  const st = S.txEdit; if (!st) return;
  $$('#tx-type button').forEach(b => b.classList.toggle('on', b.dataset.v === st.type));
  if (st.cat && !catsFor(st.type).some(c => c.id === st.cat)) { st.cat = null; st.catTouched = false; }
  $('#tx-cats').innerHTML = catsFor(st.type).map(c => `<button class="chip ${st.cat === c.id ? 'on' : ''}" data-act="tx-cat" data-id="${esc(c.id)}">${esc(c.icon)} ${esc(c.name)}</button>`).join('');
  $('#tx-ch').innerHTML = CHANNELS.map(([k, n]) => `<button class="chip ${st.channel === k ? 'on' : ''}" data-act="tx-ch" data-id="${k}">${n}</button>`).join('');
  $('#tx-cathint').textContent = st.cat ? '' : '未选择类别时会归入「待确认」，之后可以修改。';
}
function guessForSheet() {
  const st = S.txEdit; if (!st || st.catTouched) return;
  const m = $('#tx-merchant').value, n = $('#tx-note').value;
  const g = guessCategory(S.rules, S.cats, { merchant: m, text: n, type: st.type });
  st.cat = g.cat === 'pending' ? null : g.cat; paintTxSheet();
  if (st.cat) $('#tx-cathint').textContent = `已根据${g.how === 'rule' ? '你的分类规则' : '关键词'}推荐「${catOf(st.cat).name}」，可点选其他类别修改。`;
}
function learnRule(merchant, cat) {
  const key = normM(merchant); if (!key || cat === 'pending') return;
  S.rules = S.rules.filter(r => r.key !== key); S.rules.push({ key, merchant: merchant.trim(), cat });
}
async function saveTx() {
  const st = S.txEdit; if (!st) return;
  const err = m => { $('#tx-err').textContent = m; };
  const amount = parseYuan($('#tx-amount').value);
  if (isNaN(amount) || amount <= 0) return err('请输入大于 0 的金额');
  if (amount > 99999999999) return err('金额过大');
  const ts = fromLocalInput($('#tx-dt').value); if (isNaN(ts)) return err('请选择日期和时间');
  const merchant = $('#tx-merchant').value.trim(), note = $('#tx-note').value.trim();
  const cat = st.cat || 'pending';
  const rec = Object.assign({}, st.orig || { id: uid(), source: 'manual', createdAt: Date.now() }, { ts, type: st.type, amount, cat, channel: st.channel, merchant, note });
  const ok = await safe(async () => {
    await DB.putTx([rec]);
    if (st.catTouched && merchant && cat !== 'pending' && (!st.orig || st.orig.cat !== cat || normM(st.orig.merchant) !== normM(merchant))) { learnRule(merchant, cat); await saveRules(); }
    S.settings.lastChannel = st.channel; await saveSettings();
    return true;
  });
  if (!ok) return;
  const i = S.tx.findIndex(x => x.id === rec.id); if (i >= 0) S.tx[i] = rec; else S.tx.push(rec);
  closeSheet($('[data-kind=tx]')); toast(st.orig ? '已保存修改' : '已记一笔'); render();
}

/* ---------- 类别 / 规则管理 ---------- */
function catListHTML() {
  return S.cats.map(c => `<button class="item" data-act="cat-edit" data-id="${esc(c.id)}"><span class="ico" style="background:${c.color}26">${esc(c.icon)}</span><span class="grow">${esc(c.name)}<small>${{ expense: '支出', income: '收入', both: '收入/支出通用' }[c.type]}${c.fixed ? ' · 固定支出' : ''}</small></span><span class="arrow">›</span></button>`).join('');
}
function openCatList() {
  const w = openSheet(`<div class="grab"></div><div class="sheet-head"><h3>类别管理</h3><button class="x" data-act="sheet-close">完成</button></div><div class="card list" id="cat-list" style="box-shadow:none;border:1px solid var(--line)">${catListHTML()}</div><button class="btn" data-act="cat-new" style="margin-top:12px">＋ 新增类别</button>`, { full: true });
  w.dataset.kind = 'cats';
}
function refreshCatList() { const el = $('#cat-list'); if (el) el.innerHTML = catListHTML(); }
function openCatForm(id) {
  const c = id ? S.cats.find(x => x.id === id) : null;
  const w = openSheet(`<div class="grab"></div><div class="sheet-head"><button class="x" data-act="sheet-close">取消</button><h3>${c ? '编辑类别' : '新增类别'}</h3><button class="x" data-act="cat-save" style="font-weight:700">保存</button></div>
  <div class="field"><label>名称</label><input class="in" id="cf-name" maxlength="12" value="${c ? esc(c.name) : ''}" autocomplete="off"></div>
  <div class="field"><label>图标（一个表情符号）</label><input class="in" id="cf-icon" maxlength="4" value="${c ? esc(c.icon) : '🏷️'}" autocomplete="off"></div>
  <div class="field"><label>适用于</label><select class="in" id="cf-type" ${c && c.id === 'pending' ? 'disabled' : ''}>${[['expense', '支出'], ['income', '收入'], ['both', '收入和支出通用']].map(([k, n]) => `<option value="${k}" ${c && c.type === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
  <div class="field"><label><input type="checkbox" id="cf-fixed" ${c && c.fixed ? 'checked' : ''}> 属于固定支出（如房租、话费、会员）</label></div>
  <div class="err" id="cf-err"></div>
  <div class="btns">${c && c.id !== 'pending' ? '<button class="btn ghost" data-act="cat-del" style="flex:0 0 auto;width:auto;padding:0 14px">删除</button>' : ''}<button class="btn" data-act="cat-save">保存</button></div>`);
  w.dataset.kind = 'catform'; w.dataset.id = id || '';
}
async function saveCat() {
  const w = $('[data-kind=catform]'); if (!w) return; const id = w.dataset.id;
  const name = $('#cf-name').value.trim(), icon = $('#cf-icon').value.trim() || '🏷️';
  if (!name) return ($('#cf-err').textContent = '请输入类别名称');
  if (S.cats.some(c => c.name === name && c.id !== id)) return ($('#cf-err').textContent = '已有同名类别');
  const type = $('#cf-type').value, fixed = $('#cf-fixed').checked;
  if (id) { const c = S.cats.find(x => x.id === id); Object.assign(c, { name, icon, fixed }); if (c.id !== 'pending') c.type = type; }
  else S.cats.push({ id: 'c_' + uid().slice(0, 8), name, icon, type, fixed, color: PALETTE[S.cats.length % PALETTE.length], builtin: false });
  await safe(saveCats); closeSheet(w); refreshCatList(); render(); toast('已保存');
}
async function deleteCat(id) {
  const c = S.cats.find(x => x.id === id); if (!c || id === 'pending') return;
  const n = S.tx.filter(t => t.cat === id).length;
  if (!await confirmBox({ title: `删除「${c.name}」？`, msg: n ? `该类别下的 ${n} 条记录会改为「待确认」，不会删除记录。` : '该类别下没有记录。', okText: '删除', danger: true })) return;
  const moved = S.tx.filter(t => t.cat === id).map(t => ({ ...t, cat: 'pending' }));
  await safe(async () => {
    if (moved.length) await DB.putTx(moved);
    moved.forEach(m => { const i = S.tx.findIndex(t => t.id === m.id); S.tx[i] = m; });
    S.cats = S.cats.filter(x => x.id !== id); S.rules = S.rules.filter(r => r.cat !== id); delete S.settings.catBudgets[id];
    await saveCats(); await saveRules(); await saveSettings();
  });
  $$('[data-kind=catform]').forEach(closeSheet); refreshCatList(); render(); toast('已删除类别');
}
function openRules() {
  const w = openSheet(`<div class="grab"></div><div class="sheet-head"><h3>分类规则</h3><button class="x" data-act="sheet-close">完成</button></div><div class="hint" style="margin:-6px 0 10px">当你手动修改某个商家的类别时，App 会记住“商家 → 类别”，下次自动使用。</div><div id="rules-list"></div>`, { full: true });
  w.dataset.kind = 'rules'; refreshRules();
}
function refreshRules() {
  const el = $('#rules-list'); if (el) el.innerHTML = S.rules.length ? `<div class="card list" style="box-shadow:none;border:1px solid var(--line)">${S.rules.map((r, i) => `<div class="item"><span class="grow">${esc(r.merchant)}<small>→ ${esc(catOf(r.cat).icon)} ${esc(catOf(r.cat).name)}</small></span><button class="btn sm sec" data-act="rule-del" data-i="${i}">删除</button></div>`).join('')}</div>` : '<div class="empty">还没有学习到规则</div>';
}

/* ---------- 导入账单 ---------- */
function startImport() { $('#file-import').click(); }
async function handleImportFile(file) {
  try {
    if (/\.xls$/i.test(file.name)) throw new Error('暂不支持旧版 .xls 文件。请用 Excel/WPS 另存为 .xlsx 或 .csv 后再导入。');
    const buf = await file.arrayBuffer(); const h = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    const rows = (h[0] === 0x50 && h[1] === 0x4b) || /\.xlsx$/i.test(file.name) ? await readXlsx(buf) : parseCSV(decodeText(buf));
    if (rows.length < 2) throw new Error('文件里没有找到数据。');
    const det = detectFormat(rows); mergeDateTimeColumns(rows, det.headerIdx, det.map);
    S.imp = { fileName: file.name, rows, headerIdx: det.headerIdx, map: det.map, platform: det.platform, formatOk: det.ok, channelOverride: '', filter: 'all', shown: 100, cands: [] };
    rebuildImport(); openImportSheet();
  } catch (e) { console.error(e); await dialog({ title: '无法读取这个文件', msg: e.message || String(e), buttons: [{ label: '好的', value: true }] }); }
}
function rebuildImport() {
  const im = S.imp;
  im.cands = buildCandidates(im.rows, im.headerIdx, im.map, { platform: im.platform, channelOverride: im.channelOverride, fileName: im.fileName, rules: S.rules, cats: S.cats });
  markDuplicates(im.cands, S.tx);
}
function impCounts() {
  const c = S.imp.cands; return {
    total: c.length, ready: c.filter(x => x.type === 'expense' || x.type === 'income').length, unknown: c.filter(x => x.type === 'unknown').length,
    dup: c.filter(x => x.status === 'dup').length, bad: c.filter(x => x.status === 'bad').length, closed: c.filter(x => x.status === 'closed').length,
    skip: c.filter(x => x.type === 'skip' && x.status !== 'bad').length,
  };
}
function impRowHTML(c, i) {
  const tag = c.status === 'bad' ? '<span class="tag bad">无法导入</span>' : c.status === 'dup' ? '<span class="tag warn">疑似重复</span>' : c.status === 'closed' ? '<span class="tag">已关闭/失败</span>' : c.type === 'unknown' ? '<span class="tag warn">需确认收支</span>' : '';
  const amt = c.status === 'bad' && c.amount == null ? '' : `<span class="num ${c.type === 'income' ? 'inc' : c.type === 'expense' ? 'exp' : 'muted'}">${c.type === 'income' ? '+' : c.type === 'expense' ? '-' : ''}${fmt(c.amount || 0)}</span>`;
  const title = c.merchant || c.item || '（无商家）';
  let l2 = '';
  if (c.status === 'bad') l2 = `<div class="hint">第 ${c.line} 行：${esc(c.reason)}</div>`;
  else {
    const t = c.type === 'income' ? 'income' : 'expense';
    l2 = `<div class="l2"><select class="in" data-imp-type="${i}" aria-label="收支"><option value="expense" ${c.type === 'expense' ? 'selected' : ''}>支出</option><option value="income" ${c.type === 'income' ? 'selected' : ''}>收入</option><option value="skip" ${c.type === 'skip' ? 'selected' : ''}>跳过</option>${c.type === 'unknown' ? '<option value="unknown" selected disabled>请选择…</option>' : ''}</select>
    <select class="in grow" data-imp-cat="${i}" aria-label="类别" ${c.type === 'skip' || c.type === 'unknown' ? 'disabled' : ''}>${catsFor(t).map(k => `<option value="${esc(k.id)}" ${k.id === c.cat ? 'selected' : ''}>${esc(k.icon)} ${esc(k.name)}</option>`).join('')}</select></div>${c.reason ? `<div class="hint">${esc(c.reason)}</div>` : ''}`;
  }
  return `<div class="imp-row" data-i="${i}"><div class="l1"><b>${esc(title)}${tag}</b>${amt}</div><div class="muted" style="font-size:12.5px">${c.ts && !isNaN(c.ts) ? fmtDT(c.ts) : '日期未知'} · ${chName(c.channel)}${c.item && c.merchant ? ' · ' + esc(c.item) : ''}</div>${l2}</div>`;
}
function paintImportSummary() {
  const n = impCounts();
  $('#imp-sum').innerHTML = `<div class="kv"><div><small>将导入</small><b class="num inc">${n.ready}</b></div><div><small>需确认收支</small><b class="num ${n.unknown ? 'exp' : ''}">${n.unknown}</b></div><div><small>疑似重复 / 已关闭</small><b class="num">${n.dup + n.closed}</b></div><div><small>无法识别</small><b class="num">${n.bad}</b></div></div>${n.unknown ? '<div class="tip warn">有些交易无法判断是收入还是支出（例如微信“/”、支付宝“不计收支”）。请在下方逐条选择，未选择的将被跳过。</div>' : ''}`;
  const b = $('#imp-go'); b.textContent = n.ready ? `确认导入 ${n.ready} 条` : '没有可导入的记录'; b.disabled = !n.ready;
  $$('[data-imp-filter]').forEach(x => { const k = x.dataset.impFilter; x.classList.toggle('on', S.imp.filter === k); });
}
function paintImportList() {
  const im = S.imp; const f = im.filter;
  let idx = im.cands.map((c, i) => i).filter(i => { const c = im.cands[i]; return f === 'all' || (f === 'todo' && c.type === 'unknown') || (f === 'dup' && c.status === 'dup') || (f === 'bad' && (c.status === 'bad' || c.status === 'closed')); });
  const shown = idx.slice(0, im.shown);
  $('#imp-list').innerHTML = (shown.map(i => impRowHTML(im.cands[i], i)).join('') || '<div class="empty">没有符合的记录</div>') + (idx.length > shown.length ? `<button class="btn sec" data-act="imp-more" style="margin-top:10px">显示更多（还有 ${idx.length - shown.length} 条）</button>` : '');
}
function openImportSheet() {
  const im = S.imp; const hdr = im.rows[im.headerIdx] || [];
  const opts = sel => `<option value="-1">（无）</option>` + hdr.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(String(h).trim() || '第' + (i + 1) + '列')}</option>`).join('');
  const platName = { wechat: '微信支付账单', alipay: '支付宝账单', bank: '银行卡流水（按常见格式推测）' }[im.platform];
  const w = openSheet(`<div class="grab"></div><div class="sheet-head"><button class="x" data-act="sheet-close">取消</button><h3>导入预览</h3><span style="min-width:44px"></span></div>
  <div class="card" style="box-shadow:none;border:1px solid var(--line)"><div style="font-size:14px"><b>${esc(im.fileName)}</b><br><span class="muted">共读到 ${im.cands.length} 行数据 · ${platName ? '识别为：' + platName : '未识别出平台，将按支付方式判断渠道'}</span></div>
  ${im.formatOk ? '' : '<div class="tip warn">没有自动找到“日期”和“金额”列，请在下面的“字段匹配”里手动选择。</div>'}
  <div class="tip">这些格式规则尚未经过你的真实账单验证，请在预览里核对。导入只会“新增”，不会覆盖已有记录。</div></div>
  <details class="map" ${im.formatOk ? '' : 'open'}><summary>字段匹配（可手动调整）</summary>${Object.keys(FIELD_LABEL).map(f => `<div class="maprow"><span>${FIELD_LABEL[f]}</span><select class="in" data-map="${f}">${opts(im.map[f])}</select></div>`).join('')}
  <div class="maprow"><span>默认渠道</span><select class="in" id="imp-ch"><option value="">自动识别</option>${CHANNELS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></div><div class="hint">修改匹配后会重新解析，之前在预览里做的单条修改会被重置。</div></details>
  <div id="imp-sum" style="margin:12px 0"></div>
  <div class="chips scroll" style="margin-bottom:6px">${[['all', '全部'], ['todo', '需确认'], ['dup', '疑似重复'], ['bad', '失败/关闭']].map(([k, n]) => `<button class="chip" data-act="imp-filter" data-imp-filter="${k}" data-v="${k}">${n}</button>`).join('')}</div>
  <div id="imp-list"></div><div class="stickybar"><button class="btn" id="imp-go" data-act="imp-go">确认导入</button></div>`, { full: true });
  w.dataset.kind = 'import'; paintImportSummary(); paintImportList();
}
async function commitImport() {
  const im = S.imp; if (!im) return; const n = impCounts();
  const ok = await confirmBox({ title: '确认导入？', msg: `将新增 ${n.ready} 条记录。${n.unknown ? `\n另有 ${n.unknown} 条收支未确认，将被跳过。` : ''}\n不会修改或覆盖你已有的记录。`, okText: '导入' });
  if (!ok) return;
  const recs = [], learn = [];
  im.cands.forEach(c => {
    if (c.type !== 'expense' && c.type !== 'income') return;
    const cat = catsFor(c.type).some(k => k.id === c.cat) ? c.cat : 'pending';
    recs.push({ id: uid(), ts: c.ts, type: c.type, amount: c.amount, cat, channel: c.channel, merchant: c.merchant, note: c.item, oid: c.oid || '', raw: Object.assign({ 原始金额: c.rawAmount }, c.raw), source: 'import', createdAt: Date.now() });
    if (c.catTouched && c.merchant && cat !== 'pending') learn.push([c.merchant, cat]);
  });
  const done = await safe(async () => { await DB.putTx(recs); learn.forEach(([m, c]) => learnRule(m, c)); if (learn.length) await saveRules(); return true; }, '导入失败，没有写入任何记录');
  if (!done) return;
  S.tx.push(...recs);
  const failed = n.bad, skipped = im.cands.length - recs.length - failed;
  closeSheet($('[data-kind=import]'));
  render();
  await dialog({ title: '导入完成', msg: `成功导入：${recs.length} 条\n跳过：${skipped} 条（重复、已关闭、未确认或手动跳过）\n失败：${failed} 条`, buttons: [{ label: '好的', value: true }] });
}

/* ---------- 导出 / 备份 / 恢复 ---------- */
async function exportCSV() {
  const rows = [['交易时间', '收/支', '金额(元)', '类别', '支付渠道', '商家', '备注', '订单号']];
  [...S.tx].sort((a, b) => a.ts - b.ts).forEach(t => rows.push([fmtDT(t.ts), t.type === 'income' ? '收入' : '支出', yuan(t.amount), catOf(t.cat).name, chName(t.channel), t.merchant, t.note, t.oid || '']));
  const r = await saveFile(`智能记账-全部记录-${fmtDate(Date.now())}.csv`, '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
  if (r !== 'cancelled') toast(r === 'shared' ? '已打开分享面板，可存储到“文件”' : '已导出 CSV');
}
async function exportJSON() {
  const data = { app: 'smart-ledger', version: 1, currency: 'CNY', exportedAt: new Date().toISOString(), tx: S.tx, cats: S.cats, rules: S.rules, settings: S.settings };
  const r = await saveFile(`智能记账-备份-${fmtDate(Date.now())}.json`, JSON.stringify(data, null, 1), 'application/json');
  if (r !== 'cancelled') toast(r === 'shared' ? '已打开分享面板，可存储到“文件”' : '已导出备份');
}
async function handleRestoreFile(file) {
  let data;
  try { data = JSON.parse(decodeText(await file.arrayBuffer())); } catch (e) { return dialog({ title: '无法读取', msg: '这不是有效的 JSON 备份文件。', buttons: [{ label: '好的', value: true }] }); }
  if (!data || data.app !== 'smart-ledger' || !Array.isArray(data.tx)) return dialog({ title: '无法恢复', msg: '这个文件不是“智能记账”导出的备份。', buttons: [{ label: '好的', value: true }] });
  const valid = data.tx.filter(t => t && typeof t.id === 'string' && Number.isFinite(t.ts) && Number.isInteger(t.amount) && t.amount > 0 && (t.type === 'income' || t.type === 'expense'));
  const bad = data.tx.length - valid.length;
  const when = data.exportedAt ? fmtDT(Date.parse(data.exportedAt) || 0) : '未知';
  const v = await dialog({ title: '恢复备份', msg: `备份时间：${when}\n备份包含 ${valid.length} 条有效记录${bad ? `（另有 ${bad} 条无效，已忽略）` : ''}。\n\n“覆盖”会用备份替换你现在的全部数据；“合并”只添加当前没有的记录。\n建议先备份当前数据。`, buttons: [{ label: '合并（保留现有数据）', value: 'merge' }, { label: '覆盖当前数据', value: 'replace', cls: 'danger' }, { label: '取消', value: null, cls: 'sec' }] });
  if (!v) return;
  const ok = await safe(async () => {
    if (v === 'replace') {
      await DB.clearTx(); await DB.putTx(valid); S.tx = valid;
      if (Array.isArray(data.cats) && data.cats.length) S.cats = data.cats;
      if (!S.cats.some(c => c.id === 'pending')) S.cats.push({ ...DEFAULT_CATS.find(c => c.id === 'pending') });
      S.rules = Array.isArray(data.rules) ? data.rules : [];
      S.settings = Object.assign(defaultSettings(), data.settings || {}, { initialized: true });
    } else {
      const have = new Set(S.tx.map(t => t.id)); const add = valid.filter(t => !have.has(t.id));
      await DB.putTx(add); S.tx.push(...add);
      (data.cats || []).forEach(c => { if (c && c.id && !S.cats.some(x => x.id === c.id)) S.cats.push(c); });
      (data.rules || []).forEach(r => { if (r && r.key && !S.rules.some(x => x.key === r.key)) S.rules.push(r); });
    }
    await saveCats(); await saveRules(); await saveSettings(); return true;
  }, '恢复失败');
  if (ok) { applyTheme(); render(); toast(v === 'replace' ? '已覆盖恢复' : '已合并恢复'); }
}
async function clearDemo() {
  if (!await confirmBox({ title: '清空演示数据？', msg: '只会删除标注为“演示”的记录，你自己录入或导入的记录不受影响。', okText: '清空', danger: true })) return;
  const ids = S.tx.filter(t => t.source === 'demo').map(t => t.id);
  await safe(() => DB.delTx(ids)); S.tx = S.tx.filter(t => t.source !== 'demo'); render(); toast('已清空演示数据');
}
async function clearAll() {
  if (!await confirmBox({ title: '清空所有数据？', msg: '将删除全部记录、类别、分类规则和预算设置，且无法恢复。\n建议先“备份全部数据”。', okText: '继续', danger: true })) return;
  const v = await dialog({ title: '再次确认', msg: '请输入“清空”两个字以确认彻底删除。', input: '清空', buttons: [{ label: '永久删除全部数据', value: 'go', cls: 'danger', needInput: true }, { label: '取消', value: null, cls: 'sec' }] });
  if (v !== 'go') return;
  await safe(async () => {
    await DB.clearTx(); await DB.clearKV();
    S.tx = []; S.cats = DEFAULT_CATS.map(c => ({ ...c })); S.rules = []; S.settings = Object.assign(defaultSettings(), { initialized: true });
    await saveSettings(); await saveCats(); await saveRules();
  });
  applyTheme(); render(); toast('已清空所有数据');
}

/* ---------- 主题 ---------- */
function applyTheme() {
  const th = S.settings.theme || 'auto';
  if (th === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = th;
  const dark = th === 'dark' || (th === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  const m = $('meta[name=theme-color]'); if (m) m.content = dark ? '#0e1215' : '#f2f4f7';
}

/* ---------- 演示数据（明确标注，可一键清空） ---------- */
function seedDemo() {
  let seed = 20261012; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const T = [['food', '演示·午餐', 'wechat', 18, 42], ['food', '演示·奶茶', 'alipay', 12, 26], ['food', '演示·晚餐', 'wechat', 30, 88], ['transport', '演示·地铁', 'wechat', 3, 9], ['transport', '演示·打车', 'alipay', 15, 48], ['shopping', '演示·超市', 'alipay', 25, 190], ['entertain', '演示·视频会员', 'bank', 15, 30], ['study', '演示·书店', 'wechat', 30, 120]];
  const now = Date.now(), sod = startOfDay(now), out = [];
  const mk = (ts, type, amount, cat, channel, merchant) => out.push({ id: uid(), ts, type, amount, cat, channel, merchant, note: '演示数据', source: 'demo', createdAt: now });
  for (let d = 0; d < 45; d++) {
    const day = addDays(sod, -d); const n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) { const t = T[Math.floor(rnd() * T.length)]; const ts = day + (8 + Math.floor(rnd() * 13)) * 3600000 + Math.floor(rnd() * 60) * 60000; if (ts <= now) mk(ts, 'expense', Math.round((t[3] + rnd() * (t[4] - t[3])) * 100), t[0], t[2], t[1]); }
  }
  [[1, 'housing', '演示·房租', 150000], [3, 'comm', '演示·话费', 5900], [5, 'bills', '演示·水电费', 18600]].forEach(([dd, c, m, a]) => { const ts = addDays(startOfMonth(now), dd) + 10 * 3600000; if (ts <= now) mk(ts, 'expense', a, c, 'bank', m); });
  [[0, 'salary', '演示·工资', 800000], [-1, 'salary', '演示·工资', 800000]].forEach(([mo, c, m, a]) => { const ts = addMonths(now, mo) + 9 * 3600000 + 5 * DAY; if (ts <= now) mk(ts, 'income', a, c, 'bank', m); });
  const ts = addDays(sod, -9) + 15 * 3600000; mk(ts, 'income', 60000, 'parttime', 'alipay', '演示·兼职');
  return out;
}

/* ---------- 事件 ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'), nav = e.target.closest('#nav button');
  if (nav) return setTab(nav.dataset.tab);
  if (!el) return;
  const act = el.dataset.act, d = el.dataset;
  switch (act) {
    case 'sheet-close': { const w = el.closest('.sheet-wrap'); closeSheet(w); break; }
    case 'dlg': { const w = el.closest('.sheet-wrap'); const v = w._buttons[+d.i].value; const r = w._resolve; w._resolve = null; w.remove(); if (!$('#sheet-root').children.length) document.body.classList.remove('noscroll'); r && r(v); break; }
    case 'goto': setTab(d.tab); break;
    case 'add': openTxSheet(null, d.type); break;
    case 'edit': openTxSheet(d.id); break;
    case 'tx-type': { const st = S.txEdit; st.type = d.v; paintTxSheet(); guessForSheet(); break; }
    case 'tx-cat': { const st = S.txEdit; st.cat = st.cat === d.id && st.catTouched ? null : d.id; st.catTouched = !!st.cat; paintTxSheet(); break; }
    case 'tx-ch': S.txEdit.channel = d.id; paintTxSheet(); break;
    case 'tx-save': saveTx(); break;
    case 'tx-del': {
      const id = S.txEdit && S.txEdit.id; if (!id) break;
      if (!await confirmBox({ title: '删除这条记录？', msg: '删除后无法恢复。', okText: '删除', danger: true })) break;
      await safe(() => DB.delTx([id])); S.tx = S.tx.filter(t => t.id !== id); $$('[data-kind=tx]').forEach(closeSheet); toast('已删除'); render(); break;
    }
    case 'hide-install': S.settings.hideInstall = true; saveSettings(); render(); break;
    case 'clear-demo': clearDemo(); break;
    case 'clear-all': clearAll(); break;
    case 'import': startImport(); break;
    case 'list-type': S.ui.list.type = d.v; S.ui.list.shown = 80; render(); break;
    case 'list-month': { const u = S.ui.list; const k = +d.d; if (k === 0) u.month = u.month == null ? startOfMonth(Date.now()) : null; else u.month = addMonths(u.month == null ? Date.now() : u.month, k); u.shown = 80; render(); break; }
    case 'list-more': S.ui.list.shown += 80; renderListResults(); break;
    case 'stats-range': S.ui.stats.range = d.v; render(); break;
    case 'theme': S.settings.theme = d.v; applyTheme(); saveSettings(); render(); break;
    case 'export-csv': exportCSV(); break;
    case 'export-json': exportJSON(); break;
    case 'restore': $('#file-restore').click(); break;
    case 'dl-template': { for (const k of ['wechat', 'alipay', 'bank']) { await saveFile(TEMPLATES[k].name, '﻿' + TEMPLATES[k].text, 'text/csv'); } toast('已生成 3 个示例模板'); break; }
    case 'cats': openCatList(); break;
    case 'cat-new': openCatForm(null); break;
    case 'cat-edit': openCatForm(d.id); break;
    case 'cat-save': saveCat(); break;
    case 'cat-del': deleteCat($('[data-kind=catform]').dataset.id); break;
    case 'rules': openRules(); break;
    case 'rule-del': S.rules.splice(+d.i, 1); await safe(saveRules); refreshRules(); render(); break;
    case 'imp-filter': S.imp.filter = d.v; S.imp.shown = 100; paintImportSummary(); paintImportList(); break;
    case 'imp-more': S.imp.shown += 100; paintImportList(); break;
    case 'imp-go': commitImport(); break;
  }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'tx-amount') {
    let v = t.value.replace(/[。，]/g, '.').replace(/[^\d.,]/g, ''); if (!v.includes('.')) v = v.replace(',', '.'); v = v.replace(/,/g, '');
    const p = v.split('.'); v = p[0].slice(0, 11) + (p.length > 1 ? '.' + p.slice(1).join('').slice(0, 2) : ''); if (v !== t.value) t.value = v;
    const er = $('#tx-err'); if (er) er.textContent = '';
  } else if (t.id === 'tx-merchant' || t.id === 'tx-note') guessForSheet();
  else if (t.id === 'list-q') { S.ui.list.q = t.value; S.ui.list.shown = 80; renderListResults(); }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'file-import') { const f = t.files[0]; t.value = ''; if (f) handleImportFile(f); }
  else if (t.id === 'file-restore') { const f = t.files[0]; t.value = ''; if (f) handleRestoreFile(f); }
  else if (t.id === 'st-from' || t.id === 'st-to') { S.ui.stats[t.id === 'st-from' ? 'from' : 'to'] = t.value; const y = window.scrollY; render(); window.scrollTo(0, y); }
  else if (t.id === 'bud-total') { const v = parseYuan(t.value); S.settings.totalBudget = v > 0 ? v : 0; if (!(v > 0)) t.value = ''; await safe(saveSettings); updateBudgetUI(); }
  else if (t.id === 'bud-start') { S.settings.budgetStartDay = +t.value; await safe(saveSettings); updateBudgetUI(); }
  else if (t.dataset.bud) { const v = parseYuan(t.value); if (v > 0) S.settings.catBudgets[t.dataset.bud] = v; else { delete S.settings.catBudgets[t.dataset.bud]; t.value = ''; } await safe(saveSettings); updateBudgetUI(); }
  else if (t.dataset.map) { S.imp.map[t.dataset.map] = +t.value; rebuildImport(); paintImportSummary(); paintImportList(); }
  else if (t.id === 'imp-ch') { S.imp.channelOverride = t.value; rebuildImport(); paintImportSummary(); paintImportList(); }
  else if (t.dataset.impType != null) {
    const i = +t.dataset.impType, c = S.imp.cands[i]; c.type = t.value; if (c.status === 'unknown' || c.status === 'dup' || c.status === 'closed') { /* 用户已决定 */ }
    regress(c, S.rules, S.cats); const row = t.closest('.imp-row'); row.outerHTML = impRowHTML(c, i); paintImportSummary();
  } else if (t.dataset.impCat != null) { const c = S.imp.cands[+t.dataset.impCat]; c.cat = t.value; c.catTouched = true; }
});

/* ---------- 启动 ---------- */
async function boot() {
  await DB.open();
  try {
    S.tx = await DB.allTx();
    const settings = await DB.getKV('settings'), cats = await DB.getKV('cats'), rules = await DB.getKV('rules');
    S.settings = Object.assign(defaultSettings(), settings || {});
    S.cats = Array.isArray(cats) && cats.length ? cats : DEFAULT_CATS.map(c => ({ ...c }));
    if (!S.cats.some(c => c.id === 'pending')) S.cats.push({ ...DEFAULT_CATS.find(c => c.id === 'pending') });
    S.rules = Array.isArray(rules) ? rules : [];
    if (!settings) {
      if (!S.tx.length) { S.tx = seedDemo(); await DB.putTx(S.tx); }
      S.settings.initialized = true; await saveSettings(); await saveCats();
    }
  } catch (e) { console.error(e); toast('读取本地数据失败'); }
  applyTheme(); render();
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
  try { if (navigator.storage && navigator.storage.persist) { await navigator.storage.persist(); S.persisted = await navigator.storage.persisted(); } } catch (e) { }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('Service Worker 注册失败', e); }
  }
}
boot();
