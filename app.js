window.addEventListener('error', function (event) {
  alert('网页脚本错误：' + event.message);
});

const SUPABASE_URL = 'https://qpsfuydpsrudcfpfewrd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_K5LSBbuUnZUCZT3oThIwXg_GMMilezf';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const PTS = Object.freeze({ words: 5, reading: 7, listening: 8 });
const TASK_KEYS = Object.freeze(['words', 'reading', 'listening']);
const MULTI_PROOF_TASKS = Object.freeze(['reading', 'listening']);
const VALID_STATUSES = Object.freeze(['none', 'pending', 'approved', 'rejected']);
const REVIEW_STATUSES = Object.freeze(['approved', 'rejected']);
const NOTE_SEPARATOR = '|||';
const TASK_UPSERT_OPTIONS = Object.freeze({ onConflict: 'task_date,task_key' });
const REVIEW_LIST_LIMIT = 5;
const LOG_PAGE_SIZE = 5;
const W = Object.freeze(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
const WC = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);
const META = Object.freeze({
  words: { emoji: '📖', title: '单词任务', sub: '背诵今日60个英语单词', freq: '每天' },
  reading: { emoji: '📝', title: '四级阅读', sub: '完成一篇四级阅读理解', freq: '每天' },
  listening: { emoji: '🎧', title: '四级听力', sub: '完成一篇四级听力理解', freq: '每隔一天' },
});

let session = null;
let profile = null;
let tasks = [];
let adjustments = [];
let note = '';
let connieMsg = '';
let weekOffset = 0;
let viewDay = null;
let logPage = 1;
let pendingUpload = null;
let realtimeChannel = null;

const ESCAPE_MAP = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

function escapeAttr(value) {
  return escapeHTML(value);
}

function escapeJsArg(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/</g, '\\x3C');
}

function normalizeStatus(status) {
  return VALID_STATUSES.includes(status) ? status : 'none';
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function safeId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function safeImageUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';

  try {
    const parsed = new URL(value, window.location.href);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return value;
    }
  } catch (_) {
    return '';
  }

  return '';
}

function parseStoredList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);

  const text = String(value).trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    if (typeof parsed === 'string') return [parsed].filter(Boolean);
  } catch (_) {
    return [text];
  }

  return [text];
}

function serializeStoredList(values) {
  const cleaned = values.map((value) => String(value || '').trim()).filter(Boolean);
  if (cleaned.length <= 1) return cleaned[0] || null;
  return JSON.stringify(cleaned);
}

function proofEntries(item) {
  const urls = parseStoredList(item?.proof_url).map(safeImageUrl).filter(Boolean);
  const names = parseStoredList(item?.proof_name);

  return urls.map((url, index) => ({
    url,
    name: names[index] || names[0] || '',
  }));
}

function proofSummary(item) {
  const proofs = proofEntries(item);
  if (!proofs.length) return '';

  const names = proofs.map((proof) => proof.name).filter(Boolean);
  if (proofs.length === 1) return names[0] || '1 张证明';
  if (!names.length) return `${proofs.length} 张证明`;
  return `${proofs.length} 张：${names.join('、')}`;
}

function renderProofImages(item, mode = 'task') {
  const proofs = proofEntries(item);
  if (!proofs.length) return '';

  const className = mode === 'review' ? 'proof-grid review-proofs' : 'proof-grid task-proofs';
  const imageClass = mode === 'review' ? 'review-thumb' : 'thumb';
  const images = proofs.map((proof, index) => `
    <img
      class="${imageClass}"
      src="${imgSrcAttr(proof.url)}"
      onclick="showImg('${jsArgAttr(proof.url)}')"
      alt="提交证明 ${index + 1}"
      title="${escapeAttr(proof.name || `提交证明 ${index + 1}`)}"
    >
  `).join('');

  return `<div class="${className}">${images}</div>`;
}

function allowsMultipleProofs(key) {
  return MULTI_PROOF_TASKS.includes(key);
}

function imgSrcAttr(url) {
  return escapeAttr(safeImageUrl(url));
}

function jsArgAttr(value) {
  return escapeAttr(escapeJsArg(value));
}

function metaFor(key) {
  return META[key] || { emoji: '•', title: '未知任务', sub: '', freq: '' };
}

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function weekStart(off = 0) {
  const date = startOfDay(new Date());
  date.setDate(date.getDate() - date.getDay() + off * 7);
  return date;
}

function dayDate(dayIndex, off = weekOffset) {
  const date = weekStart(off);
  date.setDate(date.getDate() + dayIndex);
  return date;
}

function fmt(date) {
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function full(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WC[date.getDay()]}`;
}

function hear(dayIndex, off = weekOffset) {
  return Math.floor(dayDate(dayIndex, off).getTime() / 86400000) % 2 === 0;
}

function task(date, key) {
  const row = tasks.find((item) => item.task_date === ymd(date) && item.task_key === key);
  return row ? { ...row, status: normalizeStatus(row.status) } : { status: 'none' };
}

function isJaco() {
  return profile?.role === 'jaco';
}

function requireJaco() {
  if (isJaco()) return true;
  toast('当前账号没有 Jaco 审核权限');
  return false;
}

function requireConnie() {
  if (profile && !isJaco()) return true;
  toast('请使用 Connie 账号提交任务');
  return false;
}

async function signIn() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email || !password) {
    toast('请输入邮箱和密码');
    return;
  }

  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) {
    toast('登录失败：' + error.message);
    return;
  }

  await init();
}

async function signOut() {
  await db.auth.signOut();
  location.reload();
}

async function init() {
  const { data, error: sessionError } = await db.auth.getSession();
  if (sessionError) {
    toast('读取登录状态失败：' + sessionError.message);
    return;
  }

  session = data.session;
  if (!session) return;

  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  const { data: userProfile, error } = await db
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .single();

  if (error || !userProfile) {
    toast('账号还没有绑定角色');
    return;
  }

  profile = userProfile;
  document.getElementById('role-tag').textContent = isJaco() ? 'Jaco 审核' : 'Connie 提交';

  await loadAll();
  subscribe();
}

async function loadAll() {
  const from = ymd(dayDate(0, -12));
  const to = ymd(dayDate(6, 4));
  const [taskRes, noteRes, adjRes] = await Promise.all([
    db.from('tasks').select('*').gte('task_date', from).lte('task_date', to).order('submitted_at', { ascending: false }),
    db.from('notes').select('*').eq('id', 1).maybeSingle(),
    db.from('score_adjustments').select('*').order('created_at', { ascending: false }),
  ]);

  const firstError = taskRes.error || noteRes.error || adjRes.error;
  if (firstError) {
    toast('同步失败：' + firstError.message);
  }

  tasks = taskRes.data || [];
  adjustments = adjRes.data || [];

  const parts = (noteRes.data?.content || '').split(NOTE_SEPARATOR);
  note = parts[0] || '';
  connieMsg = parts[1] || '';

  render();
}

function subscribe() {
  if (realtimeChannel) return;

  realtimeChannel = db
    .channel('online')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, loadAll)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notes' }, loadAll)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'score_adjustments' }, loadAll)
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') {
        toast('实时同步连接失败，请刷新后重试');
      }
    });
}

function render() {
  renderHead();
  renderHero();
  renderNote();
  renderReview();
  renderWeek();
  renderTasks();
  renderStats();
  renderLog();
}

function renderHead() {
  const now = new Date();
  const viewStart = weekStart(weekOffset);
  const viewEnd = dayDate(6, weekOffset);

  document.getElementById('hdr-date').textContent = full(now);
  document.getElementById('hdr-week').textContent = `WEEK OF ${viewStart.getMonth() + 1}/${viewStart.getDate()} – ${viewEnd.getMonth() + 1}/${viewEnd.getDate()}`;
  document.getElementById('week-range').textContent = `${fmt(viewStart)} — ${fmt(viewEnd)}`;
}

function isFull(dayIndex, off = weekOffset) {
  const date = dayDate(dayIndex, off);
  return task(date, 'words').status === 'approved'
    && task(date, 'reading').status === 'approved'
    && (!hear(dayIndex, off) || task(date, 'listening').status === 'approved');
}

function renderHero() {
  let points = 0;
  tasks.forEach((item) => {
    if (normalizeStatus(item.status) === 'approved') {
      points += PTS[item.task_key] || 0;
    }
  });
  adjustments.forEach((item) => {
    points += safeNumber(item.points);
  });

  document.getElementById('score').textContent = points;

  let weeklyFull = 0;
  for (let index = 0; index < 7; index += 1) {
    if (isFull(index, 0)) weeklyFull += 1;
  }
  document.getElementById('weekly-full').textContent = `本周 ${weeklyFull} 天全勤`;

  let streak = 0;
  const date = startOfDay(new Date());
  while (true) {
    const dayIndex = date.getDay();
    let ok = false;

    for (let off = -20; off <= 0; off += 1) {
      const start = weekStart(off);
      const end = dayDate(6, off);
      if (date >= start && date <= end) {
        ok = isFull(dayIndex, off);
        break;
      }
    }

    if (!ok) break;
    streak += 1;
    date.setDate(date.getDate() - 1);
  }

  document.getElementById('streak').textContent = `🔥 连续 ${streak} 天`;
}

function renderNote() {
  const box = document.getElementById('note-box');
  box.innerHTML = isJaco() ? renderJacoNote() : renderConnieNote();
}

function renderJacoNote() {
  return `
    <div class="note-section">
      <div class="note-header">
        <div>
          <div class="note-kicker">Jaco Note</div>
          <div class="note-heading">给 Connie 的留言</div>
        </div>
        <span class="note-pill">爱心备注</span>
      </div>
      <div class="note-compose">
        <div class="note-field-head">
          <label class="note-label" for="note-input">留言内容</label>
          ${note ? '<span class="saved-chip">已保存</span>' : ''}
        </div>
        <div class="note-row">
          <textarea id="note-input" class="input note-input note-textarea" rows="3" placeholder="写下今天要提醒 Connie 的话，保存后她登录就能看到。">${escapeHTML(note)}</textarea>
          <button class="btn gold no-wrap note-save" onclick="saveNote()">保存</button>
        </div>
      </div>
      <div class="note-divider">
        <div class="note-title purple">Connie 对你说</div>
        <div class="note-text">${connieMsg ? escapeHTML(connieMsg) : '<span class="note-muted">Connie 暂未留言</span>'}</div>
      </div>
      <div class="note-divider">
        <div class="note-title amber">手动加分 / 扣分</div>
        <div class="adjust-row">
          <input id="adj-pts" type="number" class="input adjust-points" placeholder="如 +5 或 -3">
          <input id="adj-reason" class="input adjust-reason" placeholder="原因（如：额外完成作业）">
          <button class="btn gold no-wrap" onclick="adjustScore()">确认</button>
        </div>
        ${renderAdjustmentList(true)}
      </div>
    </div>
  `;
}

function renderConnieNote() {
  return `
    <div class="note-section">
      <div class="note-header">
        <div>
          <div class="note-kicker">Jaco Note</div>
          <div class="note-heading">Jaco 对你说</div>
        </div>
        <span class="note-pill">爱心备注</span>
      </div>
      <div class="note-compose">
        <div class="note-text">${note ? escapeHTML(note) : '<span class="note-muted">暂无爱心备注</span>'}</div>
      </div>
      <div class="note-divider">
        <div class="note-field-head">
          <div class="note-title purple">给 Jaco 留言</div>
          ${connieMsg ? '<span class="saved-chip purple">已保存</span>' : ''}
        </div>
        <div class="note-row">
          <textarea id="connie-msg-input" class="input note-input note-textarea compact" rows="2" placeholder="有什么想对 Jaco 说的...">${escapeHTML(connieMsg)}</textarea>
          <button class="btn purple-btn no-wrap note-save" onclick="saveConnieMsg()">保存</button>
        </div>
      </div>
      ${adjustments.length ? `<div class="note-divider"><div class="note-title amber">Jaco 调分记录</div>${renderAdjustmentList(false)}</div>` : ''}
    </div>
  `;
}

function renderAdjustmentList(canDelete) {
  if (!adjustments.length) return '';

  const rows = adjustments.slice(0, 10).map((item) => {
    const points = safeNumber(item.points);
    const pointsText = `${points > 0 ? '+' : ''}${points}分`;
    const pointClass = points > 0 ? 'plus' : 'minus';
    const deleteButton = canDelete
      ? `<button class="mini-btn" onclick="deleteAdjustment(${safeId(item.id)})">撤销</button>`
      : '';

    return `
      <div class="adjust-item">
        <span>${escapeHTML(item.reason || '无备注')}</span>
        <div class="adjust-actions">
          <span class="adjust-score ${pointClass}">${escapeHTML(pointsText)}</span>
          ${deleteButton}
        </div>
      </div>
    `;
  }).join('');

  return `<div class="adjust-list ${canDelete ? '' : 'tall'}">${rows}</div>`;
}

async function saveNote() {
  if (!requireJaco()) return;

  const content = document.getElementById('note-input').value.trim();
  const { error } = await db.from('notes').upsert({
    id: 1,
    content: `${content}${NOTE_SEPARATOR}${connieMsg}`,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    toast('爱心备注保存失败：' + error.message);
    return;
  }

  toast('✓ 爱心备注已保存');
  await loadAll();
}

async function saveConnieMsg() {
  if (!requireConnie()) return;

  const msg = document.getElementById('connie-msg-input').value.trim();
  const { error } = await db.from('notes').upsert({
    id: 1,
    content: `${note}${NOTE_SEPARATOR}${msg}`,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    toast('留言保存失败：' + error.message);
    return;
  }

  toast('✓ 已发送给 Jaco');
  await loadAll();
}

function renderReview() {
  const panel = document.getElementById('review-panel');
  if (!isJaco()) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  const pending = tasks.filter((item) => normalizeStatus(item.status) === 'pending');
  const visiblePending = pending.slice(0, REVIEW_LIST_LIMIT);
  const countText = pending.length > visiblePending.length
    ? `${visiblePending.length}/${pending.length} 条`
    : `${pending.length} 条`;

  document.getElementById('review-count').textContent = countText;
  document.getElementById('review-list').innerHTML = visiblePending.length
    ? visiblePending.map(renderPendingReviewItem).join('')
    : '<div class="empty-state">暂无记录 ✓</div>';
}

function renderPendingReviewItem(item) {
  const meta = metaFor(item.task_key);

  return `
    <div class="review-item">
      ${renderProofImages(item, 'review')}
      <div class="review-main">
        <b>${meta.emoji} ${escapeHTML(meta.title)}</b>
        <div class="sub">${escapeHTML(item.task_date)} · ${escapeHTML(proofSummary(item))}</div>
      </div>
      ${renderReviewButtons(item.task_date, item.task_key)}
    </div>
  `;
}

function renderReviewButtons(date, key) {
  return `
    <button class="btn green" onclick="review('${jsArgAttr(date)}','${jsArgAttr(key)}','approved')">通过</button>
    <button class="btn red" onclick="review('${jsArgAttr(date)}','${jsArgAttr(key)}','rejected')">不通过</button>
  `;
}

function renderWeek() {
  const element = document.getElementById('week');
  element.innerHTML = '';

  const today = ymd(new Date());
  const selected = viewDay ?? new Date().getDay();

  for (let index = 0; index < 7; index += 1) {
    const date = dayDate(index);
    const pipClass = (key) => {
      const status = task(date, key).status;
      if (key === 'listening' && !hear(index)) return 'na';
      if (status === 'approved') return 'ok';
      if (status === 'pending') return 'pending';
      return '';
    };

    element.insertAdjacentHTML('beforeend', `
      <div class="day ${index === selected ? 'sel' : ''} ${ymd(date) === today ? 'today' : ''}" onclick="selectDay(${index})">
        <div class="dname">${W[index]}</div>
        <div class="num">${date.getDate()}</div>
        <div class="pips">
          <span class="pip ${pipClass('words')}"></span>
          <span class="pip ${pipClass('reading')}"></span>
          <span class="pip ${pipClass('listening')}"></span>
        </div>
      </div>
    `);
  }
}

function renderTasks() {
  const dayIndex = viewDay ?? new Date().getDay();
  const date = dayDate(dayIndex);
  const today = ymd(new Date());
  const isToday = ymd(date) === today && weekOffset === 0;

  document.getElementById('task-title').textContent = isToday ? '今日任务' : '当日任务';
  document.getElementById('date-chip').textContent = full(date);

  const element = document.getElementById('tasks');
  element.innerHTML = '';

  TASK_KEYS.forEach((key) => {
    element.insertAdjacentHTML('beforeend', renderTaskCard(key, date, dayIndex, isToday));
  });
}

function selectDay(dayIndex) {
  viewDay = dayIndex;
  renderWeek();
  renderTasks();
}

function renderTaskCard(key, date, dayIndex, isToday) {
  const meta = metaFor(key);
  const available = key !== 'listening' || hear(dayIndex);
  const currentTask = task(date, key);
  const status = normalizeStatus(currentTask.status);
  const proofImages = renderProofImages(currentTask);

  return `
    <div class="task ${status} ${available ? '' : 'lock'}">
      <div class="emoji">${meta.emoji}</div>
      <div class="pts">+${PTS[key]} 分</div>
      <h3>${escapeHTML(meta.title)}</h3>
      <p>${escapeHTML(meta.sub)}</p>
      <div class="freq">${escapeHTML(meta.freq)}</div>
      ${proofImages}
      <div class="status">${taskStatusText(status)}</div>
      ${taskActions(key, date, dayIndex, status, available, isToday)}
    </div>
  `;
}

function taskStatusText(status) {
  if (status === 'pending') return '⏳ 等待 Jaco 审核';
  if (status === 'approved') return '✓ Jaco 已通过';
  if (status === 'rejected') return '✕ 未通过，请重新提交';
  return '尚未提交';
}

function taskActions(key, date, dayIndex, status, available, isToday) {
  if (!available) return '<div class="status">今日无听力</div>';

  if (isJaco()) {
    const dateKey = ymd(date);

    if (status === 'pending') {
      return renderReviewButtons(dateKey, key);
    }

    if (status === 'approved') {
      return `<button class="btn muted-btn wide-btn" onclick="revoke('${jsArgAttr(dateKey)}','${jsArgAttr(key)}')">撤销通过</button>`;
    }

    return '<div class="status">等待 Connie 提交</div>';
  }

  if (!isToday) return '<div class="status">仅限当天提交</div>';
  if (status === 'approved') return '<div class="status green-text">✓ 已通过，积分已入账</div>';

  const label = status === 'pending'
    ? (allowsMultipleProofs(key) ? '更换证明图片' : '更换证明')
    : (allowsMultipleProofs(key) ? '上传完成证明图片' : '上传完成证明');
  return `<button class="btn gold" onclick="upload('${jsArgAttr(key)}',${dayIndex})">${label}</button>`;
}

function renderStats() {
  let earned = 0;
  let max = 0;

  const items = TASK_KEYS.map((key) => {
    let done = 0;
    let target = 0;

    for (let index = 0; index < 7; index += 1) {
      if (key === 'listening' && !hear(index)) continue;
      target += 1;
      const date = dayDate(index);
      if (task(date, key).status === 'approved') {
        done += 1;
        earned += PTS[key];
      }
    }

    max += target * PTS[key];
    return { name: metaFor(key).title.replace('任务', ''), done, target };
  });

  document.getElementById('week-pts').textContent = `已得 ${earned}/${max} 分`;
  document.getElementById('stats').innerHTML = items.map((item) => `
    <div class="stat">
      <div>
        <b>${escapeHTML(item.name)}</b>
        <div class="sub">目标 ${item.target}/${item.target}</div>
      </div>
      <div class="stat-progress">
        <div class="bar"><div class="fill" style="width:${item.target ? item.done / item.target * 100 : 0}%"></div></div>
        <span class="sub">${item.done}/${item.target}</span>
      </div>
    </div>
  `).join('');
}

function renderLog() {
  const entries = tasks
    .filter((item) => item.submitted_at)
    .slice()
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
  const pageCount = Math.max(1, Math.ceil(entries.length / LOG_PAGE_SIZE));
  logPage = Math.min(Math.max(logPage, 1), pageCount);

  const start = (logPage - 1) * LOG_PAGE_SIZE;
  const list = entries.slice(start, start + LOG_PAGE_SIZE);

  document.getElementById('log-count').textContent = `${entries.length} 条`;
  document.getElementById('log').innerHTML = entries.length
    ? `
      <div class="log-rows">
        ${list.map((item) => {
      const meta = metaFor(item.task_key);
      return `
        <div class="log-row">
          <span>${meta.emoji}</span>
          <span class="log-title">${escapeHTML(item.task_date)} · ${escapeHTML(meta.title)}</span>
          <span>${escapeHTML(normalizeStatus(item.status))}</span>
          <span class="log-points">+${PTS[item.task_key] || 0}</span>
        </div>
      `;
    }).join('')}
      </div>
      ${pageCount > 1 ? renderLogPagination(pageCount) : ''}
    `
    : '<div class="empty-state">暂无记录</div>';
}

function renderLogPagination(pageCount) {
  return `
    <div class="log-pagination" aria-label="提交记录分页">
      ${Array.from({ length: pageCount }, (_, index) => {
    const page = index + 1;
    const active = page === logPage ? ' active' : '';
    return `<button class="log-page${active}" onclick="changeLogPage(${page})">${page}</button>`;
  }).join('')}
    </div>
  `;
}

function changeLogPage(page) {
  const nextPage = Number(page);
  if (!Number.isInteger(nextPage) || nextPage < 1) return;
  logPage = nextPage;
  renderLog();
}

function changeWeek(offset) {
  weekOffset += offset;
  viewDay = null;
  render();
}

function goToday() {
  weekOffset = 0;
  viewDay = null;
  render();
}

function upload(key, dayIndex) {
  if (!requireConnie()) return;
  pendingUpload = { key, dayIndex };
  const fileInput = document.getElementById('file');
  fileInput.multiple = allowsMultipleProofs(key);
  fileInput.value = '';
  fileInput.click();
}

function compress(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      const image = new Image();

      image.onload = () => {
        const max = 1000;
        let width = image.width;
        let height = image.height;

        if (width > max) {
          height = Math.round(height * max / width);
          width = max;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(image, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('图片压缩失败'));
        }, 'image/jpeg', .72);
      };

      image.onerror = reject;
      image.src = event.target.result;
    };

    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleFile(event) {
  if (!pendingUpload) return;
  const { key, dayIndex } = pendingUpload;
  if (!TASK_KEYS.includes(key)) {
    toast('未知任务类型');
    pendingUpload = null;
    return;
  }

  let files = Array.from(event.target.files || []);
  if (!files.length) {
    pendingUpload = null;
    return;
  }

  if (!allowsMultipleProofs(key)) {
    files = files.slice(0, 1);
  }

  if (files.some((file) => !file.type.startsWith('image/'))) {
    toast('请选择图片文件');
    pendingUpload = null;
    return;
  }

  const date = dayDate(dayIndex);
  const dateKey = ymd(date);
  toast(files.length > 1 ? `正在上传 ${files.length} 张图片…` : '正在上传图片…');

  try {
    const urls = [];
    const names = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const blob = await compress(file);
      const path = `${dateKey}/${key}-${Date.now()}-${index + 1}.jpg`;
      const { error: uploadError } = await db.storage
        .from('proofs')
        .upload(path, blob, { contentType: 'image/jpeg', upsert: true });

      if (uploadError) throw uploadError;

      const { data: publicData } = db.storage.from('proofs').getPublicUrl(path);
      urls.push(publicData.publicUrl);
      names.push(file.name);
    }

    const row = {
      task_date: dateKey,
      task_key: key,
      status: 'pending',
      proof_url: serializeStoredList(urls),
      proof_name: serializeStoredList(names),
      submitted_at: new Date().toISOString(),
      reviewed_at: null,
      reviewed_by: null,
    };
    const { error } = await db.from('tasks').upsert(row, TASK_UPSERT_OPTIONS);

    if (error) throw error;
    toast(files.length > 1 ? `已提交 ${files.length} 张图片，等待 Jaco 审核` : '已提交，等待 Jaco 审核');
  } catch (err) {
    toast('上传失败：' + err.message);
  }

  pendingUpload = null;
  await loadAll();
}

async function review(date, key, status) {
  if (!requireJaco()) return;
  if (!TASK_KEYS.includes(key) || !REVIEW_STATUSES.includes(status)) {
    toast('审核参数无效');
    return;
  }

  const row = {
    task_date: date,
    task_key: key,
    status,
    reviewed_at: new Date().toISOString(),
    reviewed_by: session.user.id,
  };

  if (status === 'rejected') {
    row.proof_url = null;
    row.proof_name = null;
  }

  const { error } = await db.from('tasks').upsert(row, TASK_UPSERT_OPTIONS);
  if (error) {
    toast('审核失败：' + error.message);
    return;
  }

  toast(status === 'approved' ? '已通过' : '已退回');
  await loadAll();
}

async function revoke(date, key) {
  if (!requireJaco()) return;
  if (!TASK_KEYS.includes(key)) {
    toast('任务类型无效');
    return;
  }

  const row = {
    task_date: date,
    task_key: key,
    status: 'pending',
    reviewed_at: null,
    reviewed_by: null,
  };
  const { error } = await db.from('tasks').upsert(row, TASK_UPSERT_OPTIONS);

  if (error) {
    toast('撤销失败：' + error.message);
    return;
  }

  toast('已撤销通过，重新等待审核');
  await loadAll();
}

async function adjustScore() {
  if (!requireJaco()) return;

  const pointsInput = document.getElementById('adj-pts');
  const reasonInput = document.getElementById('adj-reason');
  const points = parseInt(pointsInput.value, 10);
  const reason = reasonInput.value.trim();

  if (Number.isNaN(points) || points === 0) {
    toast('请输入有效的分数');
    return;
  }

  const { error } = await db.from('score_adjustments').insert({
    points,
    reason,
    created_by: session.user.id,
  });

  if (error) {
    toast('操作失败：' + error.message);
    return;
  }

  toast(points > 0 ? `✓ 已加 ${points} 分` : `✓ 已扣 ${Math.abs(points)} 分`);
  pointsInput.value = '';
  reasonInput.value = '';
  await loadAll();
}

async function deleteAdjustment(id) {
  if (!requireJaco()) return;
  if (!safeId(id)) {
    toast('调分记录无效');
    return;
  }

  if (!confirm('确定撤销这条调分记录？')) return;

  const { error } = await db.from('score_adjustments').delete().eq('id', id);
  if (error) {
    toast('撤销失败：' + error.message);
    return;
  }

  toast('✓ 已撤销该调分');
  await loadAll();
}

function showImg(src) {
  const safeUrl = safeImageUrl(src);
  if (!safeUrl) {
    toast('图片链接无效');
    return;
  }

  document.getElementById('lightbox-img').src = safeUrl;
  document.getElementById('lightbox').classList.add('open');
}

function toast(message) {
  const element = document.createElement('div');
  element.className = 'toast';
  element.textContent = message;
  document.body.appendChild(element);
  setTimeout(() => element.remove(), 3200);
}

Object.assign(window, {
  signIn,
  signOut,
  saveNote,
  saveConnieMsg,
  renderWeek,
  renderTasks,
  selectDay,
  changeLogPage,
  changeWeek,
  goToday,
  upload,
  handleFile,
  review,
  revoke,
  adjustScore,
  deleteAdjustment,
  showImg,
});

init();
