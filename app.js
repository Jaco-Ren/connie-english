window.addEventListener('error', function (event) {
  alert('网页脚本错误：' + event.message);
});

const SUPABASE_URL = 'https://qpsfuydpsrudcfpfewrd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_K5LSBbuUnZUCZT3oThIwXg_GMMilezf';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const PTS = Object.freeze({ words: 5, reading: 7, listening: 8 });
const TASK_KEYS = Object.freeze(['words', 'reading', 'listening']);
const VALID_STATUSES = Object.freeze(['none', 'pending', 'approved', 'rejected']);
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

  const parts = (noteRes.data?.content || '').split('|||');
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
      <div class="note-title">✏️ JACO 备注 — 给 Connie 留言</div>
      <div class="note-row">
        <input id="note-input" class="input note-input" value="${escapeAttr(note)}" placeholder="输入后点保存，Connie 登录后即可看到…">
        <button class="btn gold no-wrap" onclick="saveNote()">💾 保存</button>
      </div>
      ${note ? `<div class="current-note">当前内容：${escapeHTML(note)}</div>` : ''}
      <div class="note-divider">
        <div class="note-title purple">💬 CONNIE 对你说</div>
        <div class="note-text">${connieMsg ? escapeHTML(connieMsg) : '<span class="note-muted">Connie 暂未留言</span>'}</div>
      </div>
      <div class="note-divider">
        <div class="note-title amber">⚡ 手动加分 / 扣分</div>
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
      <div>
        <div class="note-title">JACO 对你说</div>
        <div class="note-text">${note ? escapeHTML(note) : '<span class="note-muted">暂无备注</span>'}</div>
      </div>
      <div class="note-divider">
        <div class="note-title purple">✏️ 给 JACO 留言</div>
        <div class="note-row">
          <input id="connie-msg-input" class="input note-input" value="${escapeAttr(connieMsg)}" placeholder="有什么想对 Jaco 说的…">
          <button class="btn purple-btn no-wrap" onclick="saveConnieMsg()">💾 保存</button>
        </div>
        ${connieMsg ? `<div class="current-note">当前内容：${escapeHTML(connieMsg)}</div>` : ''}
      </div>
      ${adjustments.length ? `<div class="note-divider"><div class="note-title amber">⚡ Jaco 调分记录</div>${renderAdjustmentList(false)}</div>` : ''}
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
    content: content + '|||' + connieMsg,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    toast('备注保存失败：' + error.message);
    return;
  }

  toast('✓ 备注已保存');
  await loadAll();
}

async function saveConnieMsg() {
  if (!requireConnie()) return;

  const msg = document.getElementById('connie-msg-input').value.trim();
  const { error } = await db.from('notes').upsert({
    id: 1,
    content: note + '|||' + msg,
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
  const approved = tasks.filter((item) => normalizeStatus(item.status) === 'approved');

  document.getElementById('review-count').textContent = `${pending.length} 条`;
  document.getElementById('review-list').innerHTML = (pending.length || approved.length)
    ? [
      ...pending.map(renderPendingReviewItem),
      ...approved.map(renderApprovedReviewItem),
    ].join('')
    : '<div class="empty-state">暂无记录 ✓</div>';
}

function renderPendingReviewItem(item) {
  const meta = metaFor(item.task_key);
  const proofUrl = safeImageUrl(item.proof_url);
  const image = proofUrl
    ? `<img src="${imgSrcAttr(proofUrl)}" onclick="showImg('${jsArgAttr(proofUrl)}')" alt="提交证明">`
    : '';

  return `
    <div class="review-item">
      ${image}
      <div class="review-main">
        <b>${meta.emoji} ${escapeHTML(meta.title)}</b>
        <div class="sub">${escapeHTML(item.task_date)} · ${escapeHTML(item.proof_name || '')}</div>
      </div>
      <button class="btn green" onclick="review('${jsArgAttr(item.task_date)}','${jsArgAttr(item.task_key)}','approved')">通过</button>
      <button class="btn red" onclick="review('${jsArgAttr(item.task_date)}','${jsArgAttr(item.task_key)}','rejected')">不通过</button>
    </div>
  `;
}

function renderApprovedReviewItem(item) {
  const meta = metaFor(item.task_key);
  return `
    <div class="review-item">
      <div class="review-icon">${meta.emoji}</div>
      <div class="review-main">
        <b class="approved-title">✓ ${escapeHTML(meta.title)}</b>
        <div class="sub">${escapeHTML(item.task_date)} · 已通过</div>
      </div>
      <button class="btn muted-btn" onclick="revoke('${jsArgAttr(item.task_date)}','${jsArgAttr(item.task_key)}')">撤销通过</button>
    </div>
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
  const proofUrl = safeImageUrl(currentTask.proof_url);
  const image = proofUrl
    ? `<img class="thumb" src="${imgSrcAttr(proofUrl)}" onclick="showImg('${jsArgAttr(proofUrl)}')" alt="提交证明">`
    : '';

  return `
    <div class="task ${status} ${available ? '' : 'lock'}">
      <div class="emoji">${meta.emoji}</div>
      <div class="pts">+${PTS[key]} 分</div>
      <h3>${escapeHTML(meta.title)}</h3>
      <p>${escapeHTML(meta.sub)}</p>
      <div class="freq">${escapeHTML(meta.freq)}</div>
      ${image}
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
    if (status === 'pending') {
      return `
        <button class="btn green" onclick="review('${jsArgAttr(ymd(date))}','${jsArgAttr(key)}','approved')">通过</button>
        <button class="btn red" onclick="review('${jsArgAttr(ymd(date))}','${jsArgAttr(key)}','rejected')">不通过</button>
      `;
    }

    if (status === 'approved') {
      return `<button class="btn muted-btn wide-btn" onclick="revoke('${jsArgAttr(ymd(date))}','${jsArgAttr(key)}')">撤销通过</button>`;
    }

    return '<div class="status">等待 Connie 提交</div>';
  }

  if (!isToday) return '<div class="status">仅限当天提交</div>';
  if (status === 'approved') return '<div class="status green-text">✓ 已通过，积分已入账</div>';

  const label = status === 'pending' ? '更换证明' : '上传完成证明';
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
  const list = tasks
    .filter((item) => item.submitted_at)
    .slice()
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)))
    .slice(0, 50);

  document.getElementById('log-count').textContent = `${list.length} 条`;
  document.getElementById('log').innerHTML = list.length
    ? list.map((item) => {
      const meta = metaFor(item.task_key);
      return `
        <div class="log-row">
          <span>${meta.emoji}</span>
          <span class="log-title">${escapeHTML(item.task_date)} · ${escapeHTML(meta.title)}</span>
          <span>${escapeHTML(normalizeStatus(item.status))}</span>
          <span class="log-points">+${PTS[item.task_key] || 0}</span>
        </div>
      `;
    }).join('')
    : '<div class="empty-state">暂无记录</div>';
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
  document.getElementById('file').value = '';
  document.getElementById('file').click();
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
  const file = event.target.files[0];
  if (!file || !pendingUpload) return;
  if (!file.type.startsWith('image/')) {
    toast('请选择图片文件');
    return;
  }

  const { key, dayIndex } = pendingUpload;
  if (!TASK_KEYS.includes(key)) {
    toast('未知任务类型');
    pendingUpload = null;
    return;
  }

  const date = dayDate(dayIndex);
  toast('正在上传图片…');

  try {
    const blob = await compress(file);
    const path = `${ymd(date)}/${key}-${Date.now()}.jpg`;
    const { error: uploadError } = await db.storage
      .from('proofs')
      .upload(path, blob, { contentType: 'image/jpeg', upsert: true });

    if (uploadError) throw uploadError;

    const { data: publicData } = db.storage.from('proofs').getPublicUrl(path);
    const row = {
      task_date: ymd(date),
      task_key: key,
      status: 'pending',
      proof_url: publicData.publicUrl,
      proof_name: file.name,
      submitted_at: new Date().toISOString(),
    };
    const { error } = await db.from('tasks').upsert(row, { onConflict: 'task_date,task_key' });

    if (error) throw error;
    toast('已提交，等待 Jaco 审核');
  } catch (err) {
    toast('上传失败：' + err.message);
  }

  pendingUpload = null;
  await loadAll();
}

async function review(date, key, status) {
  if (!requireJaco()) return;
  if (!TASK_KEYS.includes(key) || !['approved', 'rejected'].includes(status)) {
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

  const { error } = await db.from('tasks').upsert(row, { onConflict: 'task_date,task_key' });
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
  const { error } = await db.from('tasks').upsert(row, { onConflict: 'task_date,task_key' });

  if (error) {
    toast('撤销失败：' + error.message);
    return;
  }

  toast('已撤销通过，重新等待审核');
  await loadAll();
}

async function adjustScore() {
  if (!requireJaco()) return;

  const points = parseInt(document.getElementById('adj-pts').value, 10);
  const reason = document.getElementById('adj-reason').value.trim();

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
  document.getElementById('adj-pts').value = '';
  document.getElementById('adj-reason').value = '';
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
