'use strict';
/* =====================================================================
 * 智能记账 · lib.js —— 工具函数 / 本地数据库 / 智能分类 / 账单解析
 * 货币：人民币（CNY, ¥）。金额一律以“分”(整数) 存储，避免小数误差。
 * ===================================================================== */
const APP_VERSION = '1.0.1';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const DAY = 86400000;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

/* ---------- 日期 ---------- */
const fmtDate = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtTime = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDT = ts => `${fmtDate(ts)} ${fmtTime(ts)}`;
const toLocalInput = ts => `${fmtDate(ts)}T${fmtTime(ts)}`;
const fromLocalInput = v => { const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(v || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : NaN; };
const fromDateInput = (v, endOfDay) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); if (!m) return NaN; return new Date(+m[1], +m[2] - 1, +m[3] + (endOfDay ? 1 : 0)).getTime(); };
const startOfDay = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (ts, n) => { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); };
const startOfWeek = ts => { const d = new Date(startOfDay(ts)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
const startOfMonth = ts => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const addMonths = (ts, n) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); };
const dayIndex = ts => { const d = new Date(ts); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); };
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dayLabel = ts => { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`; };

/* ---------- 金额（分） ---------- */
function parseYuan(s) {
  s = String(s ?? '').replace(/[¥￥,，\s元]/g, '').replace(/[−–—]/g, '-').replace(/^\((.*)\)$/, '-$1');
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && !m[3])) return NaN;
  const frac = (m[3] || '') + '000';
  let f = +frac.slice(0, 2);
  if (+frac[2] >= 5) f++;
  const v = (+(m[2] || 0)) * 100 + f;
  return m[1] === '-' ? -v : v;
}
const yuan = fen => (fen / 100).toFixed(2);
const fmt = (fen, sign = false) => {
  const neg = fen < 0;
  const s = (Math.abs(fen) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (neg ? '-' : (sign ? '+' : '')) + '¥' + s;
};

/* ---------- 本地数据库（IndexedDB，失败时退回内存） ---------- */
const DB = {
  db: null, useMem: false, mem: { tx: new Map(), kv: new Map() },
  open() {
    return new Promise(res => {
      let done = false;
      const fail = () => { if (!done) { done = true; this.useMem = true; res(false); } };
      const timer = setTimeout(fail, 4000);
      try {
        const r = indexedDB.open('smart-ledger', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('tx')) d.createObjectStore('tx', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        };
        r.onsuccess = () => { if (done) return; done = true; clearTimeout(timer); this.db = r.result; res(true); };
        r.onerror = () => { clearTimeout(timer); fail(); };
        r.onblocked = () => { clearTimeout(timer); fail(); };
      } catch (e) { clearTimeout(timer); fail(); }
    });
  },
  _run(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      try { out = fn(s); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('事务中止'));
    });
  },
  async allTx() { return this.useMem ? [...this.mem.tx.values()] : this._run('tx', 'readonly', s => s.getAll()); },
  async putTx(list) { if (this.useMem) { list.forEach(t => this.mem.tx.set(t.id, t)); return; } return this._run('tx', 'readwrite', s => { list.forEach(t => s.put(t)); }); },
  async delTx(ids) { if (this.useMem) { ids.forEach(i => this.mem.tx.delete(i)); return; } return this._run('tx', 'readwrite', s => { ids.forEach(i => s.delete(i)); }); },
  async clearTx() { if (this.useMem) { this.mem.tx.clear(); return; } return this._run('tx', 'readwrite', s => { s.clear(); }); },
  async getKV(k) { return this.useMem ? this.mem.kv.get(k) : this._run('kv', 'readonly', s => s.get(k)); },
  async setKV(k, v) { if (this.useMem) { this.mem.kv.set(k, v); return; } return this._run('kv', 'readwrite', s => { s.put(v, k); }); },
  async clearKV() { if (this.useMem) { this.mem.kv.clear(); return; } return this._run('kv', 'readwrite', s => { s.clear(); }); },
};

/* ---------- 渠道 / 类别 ---------- */
const CHANNELS = [['wechat', '微信'], ['alipay', '支付宝'], ['bank', '银行卡'], ['cash', '现金'], ['other', '其他']];
const chName = id => (CHANNELS.find(c => c[0] === id) || CHANNELS[4])[1];
const PALETTE = ['#e5784d', '#4f8cff', '#8e4ec6', '#30a46c', '#f5a524', '#e93d82', '#12a594', '#ad7f58', '#6e56cf', '#c4a000', '#3b9ac4', '#889096'];
const DEFAULT_CATS = [
  { id: 'food', name: '餐饮', icon: '🍜', type: 'expense', fixed: false, color: PALETTE[0] },
  { id: 'transport', name: '交通', icon: '🚇', type: 'expense', fixed: false, color: PALETTE[1] },
  { id: 'shopping', name: '购物', icon: '🛍️', type: 'expense', fixed: false, color: PALETTE[2] },
  { id: 'housing', name: '住宿', icon: '🏠', type: 'expense', fixed: true, color: PALETTE[3] },
  { id: 'entertain', name: '娱乐', icon: '🎮', type: 'expense', fixed: false, color: PALETTE[5] },
  { id: 'study', name: '学习', icon: '📚', type: 'expense', fixed: false, color: PALETTE[8] },
  { id: 'comm', name: '通讯', icon: '📱', type: 'expense', fixed: true, color: PALETTE[6] },
  { id: 'medical', name: '医疗', icon: '💊', type: 'expense', fixed: false, color: PALETTE[10] },
  { id: 'bills', name: '生活缴费', icon: '💡', type: 'expense', fixed: true, color: PALETTE[4] },
  { id: 'transfer', name: '转账', icon: '🔁', type: 'both', fixed: false, color: PALETTE[7] },
  { id: 'other', name: '其他', icon: '📦', type: 'both', fixed: false, color: PALETTE[11] },
  { id: 'salary', name: '工资收入', icon: '💰', type: 'income', fixed: false, color: '#2e9e6a' },
  { id: 'parttime', name: '兼职收入', icon: '🧾', type: 'income', fixed: false, color: '#5aa6a0' },
  { id: 'pending', name: '待确认', icon: '❓', type: 'both', fixed: false, color: '#9aa4b0' },
].map(c => ({ ...c, builtin: true }));

/* ---------- 智能分类（纯本地关键词 + 用户规则，不需要任何 API） ---------- */
const KW = [
  ['comm', ['话费', '中国移动', '中国联通', '中国电信', '流量包', '宽带', '手机充值', '移动通信']],
  ['bills', ['水费', '电费', '燃气', '煤气', '国家电网', '南方电网', '物业费', '供暖', '水电', '生活缴费', '缴费']],
  ['medical', ['医院', '药房', '药店', '大药房', '诊所', '医疗', '挂号', '体检', '口腔', '牙科', '医保']],
  ['transport', ['地铁', '公交', '出租', '打车', '滴滴', '高德', '曹操', '首汽', '哈啰', '单车', '火车', '12306', '高铁', '机票', '航空', '中国铁路', '加油', '中石化', '中石油', '停车', '交通出行', '爱车养车', '公共交通', '轨道交通', '网约车']],
  ['housing', ['房租', '租金', '酒店', '宾馆', '民宿', '住宿', '携程', '飞猪', '如家', '汉庭', '链家', '贝壳', '自如', '公寓', '旅店']],
  ['study', ['学费', '培训', '课程', '教育', '书店', '图书', '当当', '知乎', '网课', '考试', '报名', '新东方', '学习', '驾校', '文具']],
  ['entertain', ['视频', '会员', '爱奇艺', '腾讯视频', '优酷', '哔哩哔哩', 'bilibili', 'b站', '网易云', 'qq音乐', 'spotify', 'netflix', '游戏', 'steam', '电影', '影院', '猫眼', 'ktv', '演出', '门票', '景区', '密室', '剧本杀', '健身', '运动户外', '文化休闲']],
  ['food', ['餐', '饭', '外卖', '美团', '饿了么', '奶茶', '茶饮', '喜茶', '奈雪', '蜜雪', '瑞幸', '星巴克', '咖啡', '肯德基', '麦当劳', '必胜客', '汉堡', '火锅', '烧烤', '烤肉', '小吃', '食堂', '快餐', '面包', '蛋糕', '甜品', '海底捞', '沙县', '拉面', '米线', '包子', '饺子', '早点', '茶百道', '古茗', '霸王茶姬', '便当', '酒楼', '饮品']],
  ['shopping', ['超市', '便利店', '京东', '淘宝', '天猫', '拼多多', '盒马', '永辉', '沃尔玛', '全家', '罗森', '7-eleven', '711', '商场', '百货', '服饰', '优衣库', '宜家', '屈臣氏', '苏宁', '得物', '小米商城', '商店', '购物', '日用', '数码', '家居', '山姆', 'costco', '美宜佳', '美容美发', '母婴']],
  ['salary', ['工资', '薪资', '薪水', '代发', '奖金', '发薪']],
  ['parttime', ['兼职', '稿费', '劳务', '佣金', '分红', '报酬']],
  ['transfer', ['转账', '红包', '收款', '亲属卡', '提现', '零钱充值', '转入', '转出']],
];
const normM = s => String(s || '').trim().toLowerCase();
function guessCategory(rules, cats, { merchant = '', text = '', platCat = '', type = 'expense' }) {
  const ok = id => { const c = cats.find(x => x.id === id); return !!c && (c.type === 'both' || c.type === type); };
  const key = normM(merchant);
  if (key) { const r = rules.find(r => r.key === key && ok(r.cat)); if (r) return { cat: r.cat, how: 'rule' }; }
  // 完整类别名（例如导入自己导出的 CSV）
  for (const v of [platCat, merchant]) {
    // “其他”是平台常见的笼统标签，不能据此判断，交给后面的关键词；都不命中则进「待确认」
    const c = cats.find(c => c.name && c.name === String(v || '').trim() && ok(c.id) && c.id !== 'pending' && c.id !== 'other');
    if (c) return { cat: c.id, how: 'name' };
  }
  const primary = (merchant + ' ' + text).toLowerCase();
  const scan = src => {
    if (!src) return null;
    for (const [id, ws] of KW) if (ok(id) && ws.some(w => src.includes(w))) return id;
    const c = cats.find(c => !c.builtin && ok(c.id) && c.name && src.includes(c.name.toLowerCase()));
    return c ? c.id : null;
  };
  const a = scan(primary) || scan(String(platCat || '').toLowerCase());
  return a ? { cat: a, how: 'keyword' } : { cat: 'pending', how: 'none' };
}

/* ---------- CSV / Excel 解析 ---------- */
function decodeText(buf) {
  let u8 = new Uint8Array(buf);
  if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) u8 = u8.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) { }
  for (const enc of ['gb18030', 'gbk']) { try { return new TextDecoder(enc).decode(u8); } catch (e) { } }
  return new TextDecoder('utf-8').decode(u8);
}
function parseCSV(text) {
  const head = text.split('\n').slice(0, 30).join('\n');
  const delim = (head.match(/\t/g) || []).length > (head.match(/,/g) || []).length * 2 ? '\t' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"' && cur === '') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
async function readZip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('不是有效的 .xlsx 文件');
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  const files = {};
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    files[new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen))] = { method, csize, lho };
    p += 46 + nlen + elen + clen;
  }
  const get = async name => {
    const f = files[name]; if (!f) return null;
    const ln = dv.getUint16(f.lho + 26, true), le = dv.getUint16(f.lho + 28, true);
    const data = u8.subarray(f.lho + 30 + ln + le, f.lho + 30 + ln + le + f.csize);
    if (f.method === 0) return data;
    if (f.method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持读取 .xlsx，请改用 CSV');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('不支持的压缩方式');
  };
  return { files, get };
}
async function readXlsx(buf) {
  const z = await readZip(buf);
  const dec = new TextDecoder();
  const parse = s => new DOMParser().parseFromString(s, 'application/xml');
  const shared = [];
  const ss = await z.get('xl/sharedStrings.xml');
  if (ss) {
    parse(dec.decode(ss)).querySelectorAll('si').forEach(si => {
      let t = ''; si.querySelectorAll('t').forEach(x => { if (!x.closest('rPh')) t += x.textContent; });
      shared.push(t);
    });
  }
  let sheetName = Object.keys(z.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))[0];
  if (!sheetName) throw new Error('xlsx 中没有找到工作表');
  const doc = parse(dec.decode(await z.get(sheetName)));
  const colIdx = ref => { let n = 0; for (const ch of ref.replace(/\d/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  const rows = [];
  doc.querySelectorAll('sheetData > row').forEach(r => {
    const arr = [];
    r.querySelectorAll(':scope > c').forEach(c => {
      const t = c.getAttribute('t'); const v = c.querySelector('v');
      let val = '';
      if (t === 's') val = shared[+(v ? v.textContent : -1)] ?? '';
      else if (t === 'inlineStr') val = Array.from(c.querySelectorAll('t')).map(x => x.textContent).join('');
      else val = v ? v.textContent : '';
      arr[colIdx(c.getAttribute('r') || 'A1')] = val;
    });
    const rowNo = +(r.getAttribute('r') || rows.length + 1);
    while (rows.length < rowNo - 1) rows.push([]);
    rows.push(Array.from(arr, x => x ?? ''));
  });
  return rows;
}

/* ---------- 账单识别 ---------- */
const FIELD_SYN = {
  date: ['交易时间', '交易日期', '记账日期', '入账时间', '交易创建时间', '付款时间', '记账时间', '日期', '时间'],
  amount: ['金额(元)', '交易金额', '金额', '发生额', '收支金额'],
  income: ['收入金额', '收入', '贷方金额', '贷方发生额', '存入'],
  expense: ['支出金额', '支出', '借方金额', '借方发生额', '取出'],
  dir: ['收/支', '收支', '收支类型', '借贷标志', '类型'],
  merchant: ['交易对方', '对方户名', '对方名称', '商户名称', '商家名称', '商家', '对手方', '对手信息', '对方', '收款方'],
  item: ['商品', '商品说明', '交易摘要', '摘要', '附言', '用途', '交易说明', '商品名称'],
  platCat: ['交易分类', '交易类型', '类别', '分类'],
  pay: ['支付方式', '收/付款方式', '付款方式', '支付渠道', '账户', '交易渠道'],
  status: ['当前状态', '交易状态', '状态'],
  oid: ['交易单号', '交易订单号', '订单号', '流水号', '交易流水号'],
  note: ['备注'],
};
const FIELD_LABEL = { date: '交易时间', amount: '金额', income: '收入金额列', expense: '支出金额列', dir: '收/支', merchant: '商家/交易对方', item: '商品/摘要', platCat: '平台分类/类别', pay: '支付方式', status: '交易状态', oid: '交易单号', note: '备注' };
const normH = s => String(s ?? '').replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').replace(/[:：]$/, '');

function detectFormat(rows) {
  let best = { idx: 0, score: -1, map: null };
  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const cells = rows[i].map(normH);
    if (cells.filter(Boolean).length < 3) continue;
    const map = {}; const used = new Set(); let score = 0;
    for (const f in FIELD_SYN) {
      map[f] = -1;
      for (const syn of FIELD_SYN[f]) { const j = cells.findIndex((c, k) => c === syn && !used.has(k)); if (j >= 0) { map[f] = j; used.add(j); score++; break; } }
    }
    const good = map.date >= 0 && (map.amount >= 0 || map.income >= 0 || map.expense >= 0);
    if (good && score > best.score) { best = { idx: i, score, map, good: true }; if (score >= 6) break; }
    else if (!best.good && score > best.score) best = { idx: i, score, map };
  }
  if (!best.map) { best.map = {}; for (const f in FIELD_SYN) best.map[f] = -1; }
  if (best.good || best.score > 0) {
    const cells = rows[best.idx].map(normH);
    const used = new Set(Object.values(best.map).filter(v => v >= 0));
    for (const f of ['date', 'amount', 'merchant', 'item']) {
      if (best.map[f] >= 0) continue;
      const j = cells.findIndex((c, k) => !used.has(k) && c && FIELD_SYN[f].some(s => c.includes(s)));
      if (j >= 0) { best.map[f] = j; used.add(j); }
    }
  }
  const pre = rows.slice(0, best.idx).map(r => r.join(' ')).join('\n');
  let platform = null;
  if (/微信支付|微信昵称/.test(pre)) platform = 'wechat';
  else if (/支付宝|alipay/i.test(pre)) platform = 'alipay';
  else if (rows[best.idx] && rows[best.idx].map(normH).some(h => /余额$/.test(h)) && best.map.merchant >= 0) platform = 'bank'; // 带“余额”列的流水按银行卡处理
  return { headerIdx: best.idx, map: best.map, platform, ok: !!best.good };
}
function parseDateTime(s) {
  s = String(s ?? '').trim();
  if (!s) return NaN;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = +s; if (n < 20000 || n > 80000) return NaN;
    const u = new Date(Math.round((n - 25569) * 86400000));
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds()).getTime();
  }
  let m = /(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})日?(?:[ T]*(\d{1,2})[:：时](\d{1,2})(?:[:：分](\d{1,2}))?)?/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/.exec(s);
  if (!m) return NaN;
  const [y, mo, d, h, mi, se] = [+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return NaN;
  const dt = new Date(y, mo - 1, d, h, mi, se);
  return dt.getMonth() === mo - 1 ? dt.getTime() : NaN;
}
function mapChannel(text, fallback) {
  const t = String(text || '');
  if (/微信|零钱/.test(t)) return 'wechat';
  if (/支付宝|余额宝|花呗|蚂蚁/.test(t)) return 'alipay';
  if (/现金/.test(t)) return 'cash';
  if (/银行|储蓄|信用卡|借记|工商|建设|招商|农业|交通银|浦发|中信|民生|光大|平安|邮储|卡\(|卡（/.test(t)) return 'bank';
  return fallback || 'other';
}
const cleanTxt = s => { s = String(s ?? '').trim(); return s === '/' || s === '-' || s === '无' ? '' : s; };

/* 把表格行变成待导入候选记录 */
function buildCandidates(rows, headerIdx, map, opts) {
  const { platform = null, channelOverride = '', fileName = '', rules, cats } = opts;
  const header = rows[headerIdx] || [];
  const out = [];
  const signed = map.amount >= 0 && map.dir < 0 && rows.slice(headerIdx + 1).some(r => /^\s*[-−(]/.test(String((r || [])[map.amount] ?? '')));
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => String(c ?? '').trim() === '')) continue;
    const cell = f => (map[f] >= 0 ? String(r[map[f]] ?? '').trim() : '');
    const raw = {}; header.forEach((h, k) => { if (String(h ?? '').trim() !== '') raw[String(h).trim()] = String(r[k] ?? '').trim(); });
    const c = { line: i + 1, raw: { file: fileName, row: raw }, status: 'ok', reason: '', type: 'skip', catTouched: false };
    if (r.length < 3 && !cell('date')) continue; // 汇总/说明行
    c.ts = parseDateTime(cell('date'));
    if (isNaN(c.ts)) { c.status = 'bad'; c.reason = '无法识别日期：' + (cell('date') || '空'); out.push(finishCand(c, cell, platform, channelOverride, rules, cats)); continue; }
    let amt = NaN, type = 'unknown';
    const dirText = cell('dir');
    const hasDir = map.dir >= 0;
    if (map.amount >= 0) {
      amt = parseYuan(cell('amount'));
      c.rawAmount = cell('amount');
    } else {
      const ex = parseYuan(cell('expense')), inc = parseYuan(cell('income'));
      c.rawAmount = `支出:${cell('expense')} 收入:${cell('income')}`;
      if (ex > 0) { amt = ex; type = 'expense'; } else if (inc > 0) { amt = inc; type = 'income'; }
    }
    if (isNaN(amt)) { c.status = 'bad'; c.reason = '无法识别金额：' + (c.rawAmount || '空'); out.push(finishCand(c, cell, platform, channelOverride, rules, cats)); continue; }
    if (amt === 0) { c.status = 'bad'; c.reason = '金额为 0'; out.push(finishCand(c, cell, platform, channelOverride, rules, cats)); continue; }
    if (type === 'unknown') {
      if (/支出|^付|^借|^出/.test(dirText)) type = 'expense';
      else if (/收入|^收款|^贷|^入/.test(dirText)) type = 'income';
      else if (!hasDir && signed) type = amt < 0 ? 'expense' : 'income'; // 没有收/支列：整份文件用正负号表示方向
    }
    c.amount = Math.abs(amt);
    c.type = type;
    if (type === 'unknown') c.status = 'unknown';
    const st = cell('status');
    if (/关闭|失败|已取消/.test(st)) { c.status = 'closed'; c.reason = '交易状态：' + st; c.type = 'skip'; }
    out.push(finishCand(c, cell, platform, channelOverride, rules, cats));
  }
  return out;
}
function finishCand(c, cell, platform, channelOverride, rules, cats) {
  c.merchant = cleanTxt(cell('merchant'));
  c.item = [cleanTxt(cell('item')), cleanTxt(cell('note'))].filter(Boolean).join(' · ');
  c.platCat = cleanTxt(cell('platCat'));
  c.oid = cleanTxt(cell('oid'));
  c.payText = cleanTxt(cell('pay'));
  c.channel = channelOverride || platform || mapChannel(c.payText + ' ' + c.platCat, 'other');
  c.autoType = c.type;
  regress(c, rules, cats);
  return c;
}
function regress(c, rules, cats) {
  if (c.catTouched) return;
  const t = c.type === 'income' ? 'income' : 'expense';
  c.cat = guessCategory(rules, cats, { merchant: c.merchant, text: c.item, platCat: c.platCat, type: t }).cat;
}
/* 标记重复交易（每条已有记录只能“用掉”一次，避免把真正的重复消费误判） */
function markDuplicates(cands, existing) {
  const minKey = t => [Math.floor(t.ts / 60000), t.amount, t.type, normM(t.merchant)].join('|');
  const dayKey = t => [dayIndex(t.ts), t.amount, t.type, normM(t.merchant)].join('|');
  const oids = new Set(existing.filter(t => t.oid).map(t => t.oid));
  const exact = new Map(), loose = new Map();
  for (const t of existing) {
    exact.set(minKey(t), (exact.get(minKey(t)) || 0) + 1);
    if (t.source !== 'import') loose.set(dayKey(t), (loose.get(dayKey(t)) || 0) + 1);
  }
  const seenOid = new Set();
  for (const c of cands) {
    if (c.status === 'bad' || c.status === 'closed') continue;
    if (c.type !== 'expense' && c.type !== 'income') continue;
    let why = '';
    if (c.oid && (oids.has(c.oid) || seenOid.has(c.oid))) why = '交易单号已存在';
    else if ((exact.get(minKey(c)) || 0) > 0) { exact.set(minKey(c), exact.get(minKey(c)) - 1); why = '同一时间、金额、商家的记录已存在'; }
    else if ((loose.get(dayKey(c)) || 0) > 0) { loose.set(dayKey(c), loose.get(dayKey(c)) - 1); why = '当天已有金额与商家相同的手动记录'; }
    if (c.oid) seenOid.add(c.oid);
    if (why) { c.status = 'dup'; c.reason = '疑似重复：' + why; c.type = 'skip'; }
  }
  return cands;
}

/* ---------- 示例模板（也用于自测）---------- */
const TEMPLATES = {
  wechat: {
    name: '示例-微信账单.csv',
    text: `微信支付账单明细
微信昵称：[示例用户]
起始时间：[2026-09-01 00:00:00] 终止时间：[2026-09-30 23:59:59]
导出类型：[全部]
导出时间：[2026-10-01 10:00:00]

共6笔记录
收入：2笔 8100.00元
支出：3笔 62.30元
中性交易：1笔 20.00元
注：以上数据仅作为示例

----------------------微信支付账单明细列表--------------------
交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
2026-09-02 12:11:05,商户消费,示例面馆,"午餐套餐",支出,¥28.00,零钱,支付成功,4200000000202609020001,M0001,/
2026-09-02 18:40:12,商户消费,示例地铁,"乘车码",支出,¥4.30,零钱,支付成功,4200000000202609020002,M0002,/
2026-09-03 09:15:00,商户消费,示例奶茶店,"奶茶",支出,¥30.00,招商银行储蓄卡(1234),支付成功,4200000000202609030001,M0003,/
2026-09-05 10:00:00,转账,某某同事,"转账备注",收入,¥100.00,/,已收钱,4200000000202609050001,/,/
2026-09-10 09:00:00,其他,公司,"工资",收入,"¥8,000.00",/,已存入零钱,4200000000202609100001,/,/
2026-09-11 20:00:00,微信红包,某某朋友,"恭喜发财",/,¥20.00,/,已存入零钱,4200000000202609110001,/,/
`,
  },
  alipay: {
    name: '示例-支付宝账单.csv',
    text: `------------------------------------------------------------------------------------
导出信息：
姓名：示例用户
支付宝账户：example@example.com
起始时间：[2026-09-01 00:00:00]    终止时间：[2026-09-30 23:59:59]
导出交易类型：[全部]
导出时间：[2026-10-01 10:00:00]

共5笔记录
------------------------支付宝（中国）网络技术有限公司  电子客户回单------------------------
交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,
2026-09-03 08:20:11,餐饮美食,示例早餐店,exa***@163.com,早餐,支出,12.50,余额宝,交易成功,2026090300001,B0001,,
2026-09-04 19:05:30,日用百货,示例超市,exb***@163.com,日用品,支出,86.20,花呗,交易成功,2026090400002,B0002,,
2026-09-06 14:00:00,充值缴费,中国移动,exc***@163.com,话费充值,支出,50.00,招商银行储蓄卡(1234),交易成功,2026090600003,B0003,,
2026-09-08 11:11:11,交通出行,示例打车,exd***@163.com,打车,支出,23.80,余额宝,交易关闭,2026090800004,B0004,,
2026-09-09 15:30:00,其他,某某用户,exe***@163.com,转账,不计收支,200.00,余额宝,交易成功,2026090900005,B0005,,
`,
  },
  bank: {
    name: '示例-银行卡账单.csv',
    text: `交易日期,交易时间,交易金额,联机余额,交易摘要,对手信息
2026-09-01,09:30:00,"8,000.00","12,345.67",代发工资,示例科技有限公司
2026-09-02,13:10:22,-45.00,"12,300.67",消费,示例餐厅
2026-09-07,08:00:00,-1500.00,"10,800.67",房租,房东某某
2026-09-12,21:05:09,-299.00,"10,501.67",消费,示例视频会员
`,
  },
};
/* 银行卡示例把“日期”和“时间”分成两列：合并成一列再解析 */
function mergeDateTimeColumns(rows, headerIdx, map) {
  const h = rows[headerIdx].map(normH);
  const d = h.indexOf('交易日期'), t = h.indexOf('交易时间');
  if (d >= 0 && t >= 0 && d !== t) {
    for (let i = headerIdx + 1; i < rows.length; i++) if (rows[i][d] && rows[i][t] && /^\d{1,2}:\d{2}/.test(String(rows[i][t]).trim())) rows[i][d] = String(rows[i][d]).trim() + ' ' + String(rows[i][t]).trim();
    map.date = d;
    if (map.merchant === t) map.merchant = -1;
    return true;
  }
  return false;
}

/* ---------- 保存/分享文件（iPhone 上优先用系统分享面板，可“存储到文件”） ---------- */
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
async function saveFile(name, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  if (isIOS() && navigator.canShare) {
    try {
      const file = new File([blob], name, { type: mime });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return 'shared'; }
    } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}
const csvCell = v => { v = String(v ?? ''); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
