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
const CUSTOM_REVIEW_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
const CUSTOM_TASK_PREFIX = 'custom-';
const CUSTOM_TASK_KEY_PATTERN = /^custom-[a-z0-9-]+$/;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CUSTOM_TITLE_MAX = 40;
const CUSTOM_POINTS_MIN = 1;
const CUSTOM_POINTS_MAX = 100;
const CUSTOM_REPEAT_RULES = Object.freeze(['once', 'weekly']);
const WEEKDAY_OPTIONS = Object.freeze([
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
]);
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
let lateSubmitUnlockColumnsAvailable = false;

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

function isCustomTaskKey(key) {
  return CUSTOM_TASK_KEY_PATTERN.test(String(key || ''));
}

function isValidTaskKey(key) {
  return TASK_KEYS.includes(key) || isCustomTaskKey(key);
}

function isValidDateKey(value) {
  return DATE_KEY_PATTERN.test(String(value || ''));
}

function isCustomTask(itemOrKey) {
  const key = typeof itemOrKey === 'string' ? itemOrKey : itemOrKey?.task_key;
  return isCustomTaskKey(key);
}

function customReviewStatus(item) {
  if (!isCustomTask(item)) return 'approved';
  if (CUSTOM_REVIEW_STATUSES.includes(item?.custom_review_status)) {
    return item.custom_review_status;
  }

  const status = normalizeStatus(item?.status);
  if (status === 'pending' && !item?.proof_url) return 'pending';
  if (status === 'rejected' && !item?.proof_url) return 'rejected';
  return 'approved';
}

function isCustomTaskApproved(item) {
  return customReviewStatus(item) === 'approved';
}

function customRepeatRule(item) {
  const rule = String(item?.custom_repeat_rule || 'once');
  return CUSTOM_REPEAT_RULES.includes(rule) ? rule : 'once';
}

function parseCustomWeekdays(value) {
  if (!value) return [];
  const text = String(value).trim();
  if (!text) return [];

  let raw = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) raw = parsed;
  } catch (_) {
    raw = text.split(',');
  }

  return Array.from(new Set(raw
    .map((day) => Number(day))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)));
}

function serializeCustomWeekdays(days) {
  return Array.from(new Set(days
    .map((day) => Number(day))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)))
    .join(',');
}

function parseCustomDeletedDates(value) {
  if (!value) return [];
  const text = String(value).trim();
  if (!text) return [];

  let raw = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) raw = parsed;
  } catch (_) {
    raw = text.split(',');
  }

  return Array.from(new Set(raw
    .map((date) => String(date || '').trim())
    .filter(isValidDateKey)))
    .sort();
}

function serializeCustomDeletedDates(dates) {
  const cleaned = Array.from(new Set((dates || [])
    .map((date) => String(date || '').trim())
    .filter(isValidDateKey)))
    .sort();
  return cleaned.length ? cleaned.join(',') : null;
}

function customDeletedDates(item) {
  return parseCustomDeletedDates(item?.custom_deleted_dates);
}

function customStoppedFrom(item) {
  const value = String(item?.custom_stopped_from || '').trim();
  return isValidDateKey(value) ? value : '';
}

function hasCustomCompletionRecord(item) {
  if (!isCustomTask(item) || !isCustomTaskApproved(item)) return false;
  const status = normalizeStatus(item?.status);
  return Boolean(item?.submitted_at || item?.proof_url || ['pending', 'approved', 'rejected'].includes(status));
}

function customWeekdays(item) {
  const days = parseCustomWeekdays(item?.custom_weekdays);
  if (days.length) return days;

  if (customRepeatRule(item) === 'weekly' && item?.task_date) {
    return [dateFromYmd(item.task_date).getDay()];
  }

  return [];
}

function customRepeatText(item) {
  if (customRepeatRule(item) !== 'weekly') return '单次';

  const days = customWeekdays(item);
  if (!days.length) return '每周循环';

  const labels = WEEKDAY_OPTIONS
    .filter((option) => days.includes(option.value))
    .map((option) => option.label);
  return `每${labels.join('、')}`;
}

function isRecurringTemplate(item) {
  return isCustomTask(item)
    && customRepeatRule(item) === 'weekly'
    && item?.custom_is_template === true;
}

function pointsFor(itemOrKey) {
  if (typeof itemOrKey === 'object' && isCustomTask(itemOrKey)) {
    return Math.max(0, Math.trunc(safeNumber(itemOrKey.custom_points)));
  }

  const key = typeof itemOrKey === 'string' ? itemOrKey : itemOrKey?.task_key;
  return PTS[key] || 0;
}

function customTaskTitle(item) {
  return String(item?.custom_title || '').trim() || 'Connie 自定义任务';
}

function createCustomTaskKey() {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${CUSTOM_TASK_PREFIX}${Date.now()}-${suffix}`;
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
  return MULTI_PROOF_TASKS.includes(key) || isCustomTaskKey(key);
}

function imgSrcAttr(url) {
  return escapeAttr(safeImageUrl(url));
}

function jsArgAttr(value) {
  return escapeAttr(escapeJsArg(value));
}

function metaFor(key, item = null) {
  if (isCustomTaskKey(key)) {
    return {
      emoji: '✨',
      title: customTaskTitle(item),
      sub: 'Connie 自主申报的今日加分任务',
      freq: customRepeatText(item),
    };
  }

  return META[key] || { emoji: '•', title: '未知任务', sub: '', freq: '' };
}

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateFromYmd(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return startOfDay(new Date());
  }

  return new Date(year, month - 1, day);
}

function shiftDateKey(dateKey, days) {
  const date = dateFromYmd(dateKey);
  date.setDate(date.getDate() + days);
  return ymd(date);
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
  const dateKey = ymd(date);
  const row = tasks.find((item) => item.task_date === dateKey && item.task_key === key);
  if (row) return { ...row, status: normalizeStatus(row.status) };

  const template = recurringTemplateForDate(date, key);
  if (template) return materializeRecurringTask(template, date);

  return { task_date: dateKey, task_key: key, status: 'none' };
}

function taskByDateKey(dateKey, key) {
  return tasks.find((item) => item.task_date === dateKey && item.task_key === key) || null;
}

function recurringTemplateMatchesDate(template, date) {
  if (!isRecurringTemplate(template) || !isCustomTaskApproved(template)) return false;
  const dateKey = ymd(date);
  if (dateKey < template.task_date) return false;
  const stoppedFrom = customStoppedFrom(template);
  if (stoppedFrom && dateKey >= stoppedFrom) return false;
  if (customDeletedDates(template).includes(dateKey)) return false;
  return customWeekdays(template).includes(date.getDay());
}

function recurringTemplateForDate(date, key = null) {
  return tasks.find((item) => (
    isRecurringTemplate(item)
    && (!key || item.task_key === key)
    && recurringTemplateMatchesDate(item, date)
  )) || null;
}

function recurringTemplateForSeries(item) {
  return tasks.find((template) => (
    isRecurringTemplate(template)
    && template.task_key === item.task_key
    && template.custom_series_id === item.custom_series_id
  )) || null;
}

function materializeRecurringTask(template, date) {
  return {
    ...template,
    task_date: ymd(date),
    status: 'none',
    proof_url: null,
    proof_name: null,
    submitted_at: null,
    reviewed_at: null,
    reviewed_by: null,
    custom_is_template: false,
    _virtual: true,
  };
}

function customTaskSource(row) {
  return taskByDateKey(row.task_date, row.task_key)
    || recurringTemplateForDate(dateFromYmd(row.task_date), row.task_key);
}

function keepCustomTaskFields(row) {
  if (!isCustomTaskKey(row.task_key)) return row;

  const existing = customTaskSource(row);
  if (!existing) return row;

  if (row.custom_title === undefined) row.custom_title = existing.custom_title;
  if (row.custom_points === undefined) row.custom_points = existing.custom_points;
  if (row.custom_created_by === undefined) row.custom_created_by = existing.custom_created_by;
  if (row.custom_review_status === undefined) row.custom_review_status = customReviewStatus(existing);
  if (row.custom_requested_at === undefined) row.custom_requested_at = existing.custom_requested_at;
  if (row.custom_reviewed_at === undefined) row.custom_reviewed_at = existing.custom_reviewed_at;
  if (row.custom_reviewed_by === undefined) row.custom_reviewed_by = existing.custom_reviewed_by;
  if (row.custom_repeat_rule === undefined) row.custom_repeat_rule = existing.custom_repeat_rule;
  if (row.custom_weekdays === undefined) row.custom_weekdays = existing.custom_weekdays;
  if (row.custom_series_id === undefined) row.custom_series_id = existing.custom_series_id;
  if (row.custom_is_template === undefined) row.custom_is_template = Boolean(existing.custom_is_template) && row.task_date === existing.task_date;
  if (row.custom_deleted_dates === undefined) row.custom_deleted_dates = existing.custom_deleted_dates;
  if (row.custom_stopped_from === undefined) row.custom_stopped_from = existing.custom_stopped_from;
  return row;
}

function isCustomTaskDeletedOnDate(item, date) {
  if (!isCustomTask(item)) return false;
  const template = isRecurringTemplate(item) ? item : recurringTemplateForSeries(item);
  return Boolean(template && customDeletedDates(template).includes(ymd(date)));
}

function shouldCountTaskPoints(item) {
  if (normalizeStatus(item?.status) !== 'approved') return false;
  if (!isCustomTask(item)) return true;
  return isCustomTaskApproved(item) && (hasCustomCompletionRecord(item) || !isCustomTaskDeletedOnDate(item, dateFromYmd(item.task_date)));
}

function customTaskIsVisibleOnDate(item, date) {
  const reviewStatus = customReviewStatus(item);
  if (reviewStatus === 'rejected') return false;

  const dateKey = ymd(date);
  if (reviewStatus === 'pending') {
    return !isJaco() && item.task_date === dateKey;
  }

  if (customRepeatRule(item) !== 'weekly') {
    return item.task_date === dateKey;
  }

  if (item.task_date === dateKey && hasCustomCompletionRecord(item)) return true;

  const template = isRecurringTemplate(item) ? item : recurringTemplateForSeries(item);
  if (template && customDeletedDates(template).includes(dateKey)) return false;
  if (template) return recurringTemplateMatchesDate(template, date);

  return dateKey >= item.task_date && customWeekdays(item).includes(date.getDay());
}

function customTasksForDate(date) {
  const dateKey = ymd(date);
  const realRows = tasks
    .filter((item) => item.task_date === dateKey && isCustomTask(item) && customTaskIsVisibleOnDate(item, date));
  const realKeys = new Set(realRows.map((item) => item.task_key));
  const virtualRows = tasks
    .filter((item) => isRecurringTemplate(item) && recurringTemplateMatchesDate(item, date) && !realKeys.has(item.task_key))
    .map((item) => materializeRecurringTask(item, date));

  return [...realRows, ...virtualRows]
    .sort((a, b) => String(a.custom_requested_at || a.submitted_at || '').localeCompare(String(b.custom_requested_at || b.submitted_at || '')));
}

function hasLateSubmitUnlockColumns(item) {
  return Object.prototype.hasOwnProperty.call(item || {}, 'late_submit_unlocked_at');
}

function supportsLateSubmitUnlockColumns() {
  return lateSubmitUnlockColumnsAvailable || tasks.some(hasLateSubmitUnlockColumns);
}

function markLateSubmitUnlockColumns(rows) {
  if ((rows || []).some(hasLateSubmitUnlockColumns)) {
    lateSubmitUnlockColumnsAvailable = true;
  }
}

function isLateSubmitUnlocked(item) {
  const status = normalizeStatus(item?.status);
  return Boolean(item?.late_submit_unlocked_at) && status !== 'approved' && status !== 'pending';
}

function canConnieSubmitTask(date, item) {
  return ymd(date) === ymd(new Date()) || isLateSubmitUnlocked(item);
}

function isFutureDateValue(value) {
  const dateKey = value instanceof Date ? ymd(value) : String(value || '');
  return dateKey > ymd(new Date());
}

function submitKindForDate(value) {
  return isFutureDateValue(value) ? '提交' : '补交';
}

function openSubmitText(value) {
  return `开放${submitKindForDate(value)}`;
}

function openedSubmitText(value) {
  return `已开放${submitKindForDate(value)}`;
}

function clearLateSubmitUnlock(row) {
  if (supportsLateSubmitUnlockColumns()) {
    row.late_submit_unlocked_at = null;
    row.late_submit_unlocked_by = null;
  }
  return row;
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
  hideLoginError();

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email || !password) {
    showLoginError(email ? '请输入密码' : password ? '请输入邮箱' : '请输入邮箱和密码');
    return;
  }

  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) {
    showLoginError();
    return;
  }

  await init();
}

function showLoginError(message = '邮箱或密码错误，请重试') {
  const error = document.getElementById('login-error');
  const text = document.getElementById('login-error-text');
  if (text) text.textContent = message;
  error?.classList.remove('hidden');
}

function hideLoginError() {
  document.getElementById('login-error')?.classList.add('hidden');
}

document.getElementById('email')?.addEventListener('input', hideLoginError);
document.getElementById('password')?.addEventListener('input', hideLoginError);

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

function mergeTaskRows(primaryRows, extraRows) {
  const rows = [];
  const seen = new Set();

  [...primaryRows, ...extraRows].forEach((row) => {
    const key = `${row.task_date}|${row.task_key}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  });

  return rows;
}

async function loadAll() {
  const from = ymd(dayDate(0, Math.min(-12, weekOffset)));
  const to = ymd(dayDate(6, Math.max(4, weekOffset)));
  const [taskRes, recurringRes, noteRes, adjRes] = await Promise.all([
    db.from('tasks').select('*').gte('task_date', from).lte('task_date', to).order('submitted_at', { ascending: false }),
    db.from('tasks').select('*').eq('custom_repeat_rule', 'weekly').eq('custom_is_template', true).lte('task_date', to).order('custom_requested_at', { ascending: false }),
    db.from('notes').select('*').eq('id', 1).maybeSingle(),
    db.from('score_adjustments').select('*').order('created_at', { ascending: false }),
  ]);

  const firstError = taskRes.error || recurringRes.error || noteRes.error || adjRes.error;
  if (firstError) {
    toast('同步失败：' + firstError.message);
  }

  tasks = mergeTaskRows(taskRes.data || [], recurringRes.data || []);
  markLateSubmitUnlockColumns(tasks);
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
    if (shouldCountTaskPoints(item)) {
      points += pointsFor(item);
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

  document.getElementById('streak').textContent = `连续 ${streak} 天`;
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
          <div class="note-kicker">Heart Note</div>
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
          <div class="note-kicker">Heart Note</div>
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

  const pending = tasks
    .filter(needsJacoReview)
    .sort((a, b) => String(reviewSortTime(b)).localeCompare(String(reviewSortTime(a))));
  const visiblePending = pending.slice(0, REVIEW_LIST_LIMIT);
  const countText = pending.length > visiblePending.length
    ? `${visiblePending.length}/${pending.length} 条`
    : `${pending.length} 条`;

  document.getElementById('review-count').textContent = countText;
  document.getElementById('review-list').innerHTML = visiblePending.length
    ? visiblePending.map(renderPendingReviewItem).join('')
    : '<div class="empty-state">暂无记录 ✓</div>';
}

function needsJacoReview(item) {
  if (isCustomTask(item) && isCustomTaskDeletedOnDate(item, dateFromYmd(item.task_date)) && !hasCustomCompletionRecord(item)) return false;
  if (!isCustomTask(item)) return normalizeStatus(item.status) === 'pending';
  return customReviewStatus(item) === 'pending'
    || (isCustomTaskApproved(item) && normalizeStatus(item.status) === 'pending');
}

function reviewSortTime(item) {
  if (isCustomTask(item) && customReviewStatus(item) === 'pending') {
    return item.custom_requested_at || item.submitted_at || '';
  }

  return item.submitted_at || item.custom_requested_at || '';
}

function renderPendingReviewItem(item) {
  const meta = metaFor(item.task_key, item);
  const custom = isCustomTask(item);
  const reviewingCustomTask = custom && customReviewStatus(item) === 'pending';
  const details = custom
    ? `${item.task_date} · ${reviewingCustomTask ? '任务申请' : '完成证明'} · ${customRepeatText(item)} · +${pointsFor(item)} 分${reviewingCustomTask ? '' : ` · ${proofSummary(item)}`}`
    : `${item.task_date} · ${proofSummary(item)}`;

  return `
    <div class="review-item">
      ${renderProofImages(item, 'review')}
      <div class="review-main">
        <b>${meta.emoji} ${escapeHTML(meta.title)}</b>
        <div class="sub">${escapeHTML(details)}</div>
      </div>
      ${reviewingCustomTask ? renderCustomTaskReviewButtons(item.task_date, item.task_key) : renderReviewButtons(item.task_date, item.task_key)}
    </div>
  `;
}

function renderCustomTaskReviewButtons(date, key) {
  return `
    <div class="review-actions">
      <button class="btn green" onclick="reviewCustomTask('${jsArgAttr(date)}','${jsArgAttr(key)}','approved')">批准任务</button>
      <button class="btn red" onclick="reviewCustomTask('${jsArgAttr(date)}','${jsArgAttr(key)}','rejected')">拒绝任务</button>
    </div>
  `;
}

function renderReviewButtons(date, key) {
  return `
    <div class="review-actions">
      <button class="btn green" onclick="review('${jsArgAttr(date)}','${jsArgAttr(key)}','approved')">通过</button>
      <button class="btn red" onclick="review('${jsArgAttr(date)}','${jsArgAttr(key)}','rejected')">不通过</button>
    </div>
  `;
}

function renderCustomDeleteActions(date, key, item) {
  if (!isJaco() || !isCustomTask(item)) return '';

  if (customRepeatRule(item) === 'weekly') {
    return `
      <div class="custom-delete-row">
        <button class="mini-btn delete-task-btn" onclick="deleteCustomTask('${jsArgAttr(date)}','${jsArgAttr(key)}','single')">删除本次</button>
        <button class="mini-btn delete-task-btn danger" onclick="deleteCustomTask('${jsArgAttr(date)}','${jsArgAttr(key)}','series')">停止周期</button>
      </div>
    `;
  }

  return `
    <div class="custom-delete-row single">
      <button class="mini-btn delete-task-btn danger" onclick="deleteCustomTask('${jsArgAttr(date)}','${jsArgAttr(key)}','single')">删除任务</button>
    </div>
  `;
}

function withCustomDeleteActions(primaryAction, date, key, item) {
  const deleteActions = renderCustomDeleteActions(date, key, item);
  if (!deleteActions) return primaryAction;

  return `
    <div class="custom-action-stack">
      ${primaryAction}
      ${deleteActions}
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
    if (key === 'listening' && !hear(dayIndex)) return;
    element.insertAdjacentHTML('beforeend', renderTaskCard(key, date, dayIndex, isToday));
  });

  customTasksForDate(date).forEach((item) => {
    element.insertAdjacentHTML('beforeend', renderTaskCard(item.task_key, date, dayIndex, isToday, item));
  });

  if (isToday && !isJaco()) {
    element.insertAdjacentHTML('beforeend', renderCustomTaskForm(dayIndex));
  }
}

function selectDay(dayIndex) {
  viewDay = dayIndex;
  renderWeek();
  renderTasks();
}

function renderTaskCard(key, date, dayIndex, isToday, item = null) {
  const currentTask = item ? { ...item, status: normalizeStatus(item.status) } : task(date, key);
  const custom = isCustomTask(currentTask);
  const meta = metaFor(key, currentTask);
  const available = custom || key !== 'listening' || hear(dayIndex);
  if (!available) return '';

  const status = normalizeStatus(currentTask.status);
  const cardStatus = custom && !isCustomTaskApproved(currentTask) ? customReviewStatus(currentTask) : status;
  const lateUnlocked = isLateSubmitUnlocked(currentTask);
  const proofImages = renderProofImages(currentTask);
  const pointValue = pointsFor(currentTask);

  return `
    <div class="task ${cardStatus} ${lateUnlocked ? 'unlocked' : ''} ${available ? '' : 'lock'} ${custom ? 'custom-task-card' : ''}">
      <div class="task-main">
        <div class="task-headline">
          <div class="emoji">${meta.emoji}</div>
          <div class="pts">+${pointValue} 分</div>
        </div>
        <h3>${escapeHTML(meta.title)}</h3>
        <p>${escapeHTML(meta.sub)}</p>
        <div class="freq">${escapeHTML(meta.freq)}</div>
      </div>
      ${proofImages ? `<div class="task-proof-area">${proofImages}</div>` : ''}
      <div class="task-footer">
        <div class="status ${taskStatusClass(status, currentTask)}">${taskStatusText(status, currentTask)}</div>
        <div class="task-actions">${taskActions(key, date, dayIndex, status, available, isToday, currentTask)}</div>
      </div>
    </div>
  `;
}

function renderCustomTaskForm(dayIndex) {
  return `
    <div class="task custom-task-form">
      <div class="task-main">
        <div class="task-headline">
          <div class="emoji">＋</div>
          <div class="pts">自定分值</div>
        </div>
        <h3>申报今日加分任务</h3>
        <p>写下今天想新增的学习任务和分值，Jaco 批准后再上传完成证明。</p>
        <div class="custom-fields">
          <input id="custom-task-title" class="input" maxlength="${CUSTOM_TITLE_MAX}" placeholder="任务名称，如：完成一套四级翻译">
          <input id="custom-task-points" class="input" type="number" min="${CUSTOM_POINTS_MIN}" max="${CUSTOM_POINTS_MAX}" placeholder="加几分">
          <div class="repeat-mode" role="radiogroup" aria-label="任务重复方式">
            <label class="repeat-option">
              <input type="radio" name="custom-repeat-rule" value="once" checked onchange="toggleCustomRepeatDays()">
              <span>单次</span>
            </label>
            <label class="repeat-option">
              <input type="radio" name="custom-repeat-rule" value="weekly" onchange="toggleCustomRepeatDays()">
              <span>每周循环</span>
            </label>
          </div>
          <div id="custom-repeat-days" class="weekday-picker hidden">
            ${WEEKDAY_OPTIONS.map((option) => `
              <label class="weekday-option">
                <input type="checkbox" value="${option.value}">
                <span>${option.label}</span>
              </label>
            `).join('')}
          </div>
        </div>
      </div>
      <div class="task-footer">
        <div class="status status-idle">先审核任务</div>
        <div class="task-actions">
          <button class="btn gold" onclick="submitCustomTask(${dayIndex})">To Jaco</button>
        </div>
      </div>
    </div>
  `;
}

function taskStatusClass(status, item) {
  if (isCustomTask(item) && !isCustomTaskApproved(item)) {
    return customReviewStatus(item) === 'pending' ? 'status-pending' : 'status-rejected';
  }

  if (isLateSubmitUnlocked(item)) return 'status-unlocked';
  if (status === 'pending') return 'status-pending';
  if (status === 'approved') return 'status-approved';
  if (status === 'rejected') return 'status-rejected';
  return 'status-idle';
}

function taskStatusText(status, item) {
  if (isCustomTask(item)) {
    const reviewStatus = customReviewStatus(item);
    if (reviewStatus === 'pending') return '等待 Jaco 批准任务';
    if (reviewStatus === 'rejected') return '任务申请未通过';
    if (status === 'pending') return '完成证明等待 Jaco 审核';
    if (status === 'approved') return 'Jaco 已通过，积分已入账';
    if (status === 'rejected') return '完成证明未通过，请重新提交';
    return '任务已批准，等待上传证明';
  }

  if (isLateSubmitUnlocked(item)) return `Jaco ${openedSubmitText(item?.task_date)}`;
  if (status === 'pending') return '等待 Jaco 审核';
  if (status === 'approved') return 'Jaco 已通过';
  if (status === 'rejected') return '未通过，请重新提交';
  return '尚未提交';
}

function uploadLabel(key, status, isToday, date) {
  if (!isToday) {
    const kind = submitKindForDate(date);
    return allowsMultipleProofs(key) ? `${kind}完成证明图片` : `${kind}完成证明`;
  }

  if (status === 'pending') {
    return allowsMultipleProofs(key) ? '更换证明图片' : '更换证明';
  }

  return allowsMultipleProofs(key) ? '上传完成证明图片' : '上传完成证明';
}

function taskActions(key, date, dayIndex, status, available, isToday, currentTask) {
  if (!available) return '';

  if (isCustomTask(currentTask)) {
    return customTaskActions(key, date, dayIndex, status, currentTask);
  }

  if (isJaco()) {
    const dateKey = ymd(date);
    const lateUnlocked = isLateSubmitUnlocked(currentTask);

    if (status === 'pending') {
      return renderReviewButtons(dateKey, key);
    }

    if (status === 'approved') {
      return `<button class="btn muted-btn wide-btn" onclick="revoke('${jsArgAttr(dateKey)}','${jsArgAttr(key)}')">撤销通过</button>`;
    }

    if (!isToday) {
      if (lateUnlocked) {
        return `<div class="task-action-note action-success">${openedSubmitText(date)}</div>`;
      }

      return `<button class="btn purple-btn wide-btn" onclick="unlockLateSubmit('${jsArgAttr(dateKey)}','${jsArgAttr(key)}')">${openSubmitText(date)}</button>`;
    }

    return '<div class="task-action-note">等待 Connie 提交</div>';
  }

  if (status === 'approved') return '<div class="task-action-note action-success">积分已入账</div>';
  if (!canConnieSubmitTask(date, currentTask)) {
    return `<div class="task-action-note">${isFutureDateValue(date) ? `等待 Jaco ${openSubmitText(date)}` : '仅限当天提交'}</div>`;
  }

  const label = uploadLabel(key, status, isToday, date);
  return `<button class="btn gold" onclick="upload('${jsArgAttr(key)}',${dayIndex})">${label}</button>`;
}

function customTaskActions(key, date, dayIndex, status, currentTask) {
  const dateKey = ymd(date);
  const reviewStatus = customReviewStatus(currentTask);
  let primaryAction = '';

  if (isJaco()) {
    if (reviewStatus === 'pending') {
      primaryAction = renderCustomTaskReviewButtons(dateKey, key);
      return withCustomDeleteActions(primaryAction, dateKey, key, currentTask);
    }

    if (reviewStatus === 'rejected') {
      primaryAction = '<div class="task-action-note">任务申请已退回</div>';
      return withCustomDeleteActions(primaryAction, dateKey, key, currentTask);
    }

    if (status === 'pending') {
      primaryAction = renderReviewButtons(dateKey, key);
      return withCustomDeleteActions(primaryAction, dateKey, key, currentTask);
    }

    if (status === 'approved') {
      primaryAction = `<button class="btn muted-btn wide-btn" onclick="revoke('${jsArgAttr(dateKey)}','${jsArgAttr(key)}')">撤销通过</button>`;
      return withCustomDeleteActions(primaryAction, dateKey, key, currentTask);
    }

    primaryAction = '<div class="task-action-note">等待 Connie 上传证明</div>';
    return withCustomDeleteActions(primaryAction, dateKey, key, currentTask);
  }

  if (reviewStatus === 'pending') return withCustomDeleteActions('<div class="task-action-note">已申报，等待 Jaco 批准任务</div>', dateKey, key, currentTask);
  if (reviewStatus === 'rejected') return withCustomDeleteActions('<div class="task-action-note">任务申请未通过，可重新申报</div>', dateKey, key, currentTask);
  if (status === 'approved') return withCustomDeleteActions('<div class="task-action-note action-success">自定义积分已入账</div>', dateKey, key, currentTask);
  if (status === 'pending') return withCustomDeleteActions('<div class="task-action-note">完成证明等待 Jaco 审核</div>', dateKey, key, currentTask);
  if (!canConnieSubmitTask(date, currentTask)) return withCustomDeleteActions('<div class="task-action-note">仅限当天上传证明</div>', dateKey, key, currentTask);
  return `<button class="btn gold" onclick="upload('${jsArgAttr(key)}',${dayIndex})">${status === 'rejected' ? '重新上传完成证明' : '上传完成证明图片'}</button>`;
}

function renderStats() {
  let earned = 0;
  let max = 0;
  let customEarned = 0;
  const weekFrom = ymd(dayDate(0));
  const weekTo = ymd(dayDate(6));

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

  tasks.forEach((item) => {
    if (
      isCustomTask(item)
      && shouldCountTaskPoints(item)
      && item.task_date >= weekFrom
      && item.task_date <= weekTo
    ) {
      customEarned += pointsFor(item);
    }
  });

  document.getElementById('week-pts').textContent = customEarned
    ? `基础 ${earned}/${max} 分 · 自定义 +${customEarned}`
    : `已得 ${earned}/${max} 分`;
  document.getElementById('stats').innerHTML = items.map((item) => `
    <div class="stat">
      <div>
        <b>${escapeHTML(item.name)}</b>
        <div class="sub">完成 ${item.done}/${item.target}</div>
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
      const meta = metaFor(item.task_key, item);
      return `
        <div class="log-row">
          <span>${meta.emoji}</span>
          <span class="log-title">${escapeHTML(item.task_date)} · ${escapeHTML(meta.title)}</span>
          <span>${escapeHTML(normalizeStatus(item.status))}</span>
          <span class="log-points">+${pointsFor(item)}</span>
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

async function changeWeek(offset) {
  weekOffset += offset;
  viewDay = null;
  await loadAll();
}

async function goToday() {
  weekOffset = 0;
  viewDay = null;
  await loadAll();
}

function selectedCustomRepeatRule() {
  return document.querySelector('input[name="custom-repeat-rule"]:checked')?.value || 'once';
}

function selectedCustomWeekdays() {
  return Array.from(document.querySelectorAll('#custom-repeat-days input[type="checkbox"]:checked'))
    .map((input) => Number(input.value))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
}

function toggleCustomRepeatDays() {
  const picker = document.getElementById('custom-repeat-days');
  if (!picker) return;

  picker.classList.toggle('hidden', selectedCustomRepeatRule() !== 'weekly');
}

async function submitCustomTask(dayIndex) {
  if (!requireConnie()) return;

  const date = dayDate(dayIndex);
  const dateKey = ymd(date);
  if (weekOffset !== 0 || dateKey !== ymd(new Date())) {
    toast('只能申报今天的自定义任务');
    return;
  }

  const titleInput = document.getElementById('custom-task-title');
  const pointsInput = document.getElementById('custom-task-points');
  const title = titleInput.value.trim();
  const points = parseInt(pointsInput.value, 10);
  const repeatRule = selectedCustomRepeatRule();
  const weekdays = repeatRule === 'weekly' ? selectedCustomWeekdays() : [];

  if (!title || title.length > CUSTOM_TITLE_MAX) {
    toast(`请输入 1-${CUSTOM_TITLE_MAX} 个字的任务名称`);
    return;
  }

  if (!Number.isInteger(points) || points < CUSTOM_POINTS_MIN || points > CUSTOM_POINTS_MAX) {
    toast(`加分需在 ${CUSTOM_POINTS_MIN}-${CUSTOM_POINTS_MAX} 分之间`);
    return;
  }

  if (repeatRule === 'weekly' && !weekdays.length) {
    toast('请选择每周循环的星期');
    return;
  }

  const taskKey = createCustomTaskKey();
  const now = new Date().toISOString();
  const row = clearLateSubmitUnlock({
    task_date: dateKey,
    task_key: taskKey,
    status: 'none',
    custom_title: title,
    custom_points: points,
    custom_created_by: session.user.id,
    custom_review_status: 'pending',
    custom_requested_at: now,
    custom_reviewed_at: null,
    custom_reviewed_by: null,
    custom_repeat_rule: repeatRule,
    custom_weekdays: repeatRule === 'weekly' ? serializeCustomWeekdays(weekdays) : null,
    custom_series_id: taskKey,
    custom_is_template: repeatRule === 'weekly',
    proof_url: null,
    proof_name: null,
    submitted_at: null,
    reviewed_at: null,
    reviewed_by: null,
  });

  const { error } = await db.from('tasks').insert(row);
  if (error) {
    const setupHint = /custom_|task_key|row-level security|constraint/i.test(String(error.message || ''))
      ? '（请先在 Supabase SQL Editor 执行 supabase/rls.sql）'
      : '';
    toast(`申报失败：${error.message}${setupHint}`);
    return;
  }

  toast('已申报给 Jaco，等待批准任务');
  titleInput.value = '';
  pointsInput.value = '';
  document.querySelector('input[name="custom-repeat-rule"][value="once"]').checked = true;
  document.querySelectorAll('#custom-repeat-days input[type="checkbox"]').forEach((input) => {
    input.checked = false;
  });
  toggleCustomRepeatDays();
  await loadAll();
}

function upload(key, dayIndex) {
  if (!requireConnie()) return;
  if (!isValidTaskKey(key)) {
    toast('未知任务类型');
    return;
  }

  const date = dayDate(dayIndex);
  const currentTask = task(date, key);
  const custom = isCustomTask(currentTask);
  if (custom && !isCustomTaskApproved(currentTask)) {
    toast('Jaco 批准这个任务后才能上传证明');
    return;
  }

  if (custom && !canConnieSubmitTask(date, currentTask)) {
    toast('只能在任务当天上传证明');
    return;
  }

  if (!custom && !canConnieSubmitTask(date, currentTask)) {
    toast(`这个任务还没有${openSubmitText(date)}`);
    return;
  }

  if (normalizeStatus(currentTask.status) === 'approved') {
    toast('这个任务已经通过了');
    return;
  }

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
  if (!isValidTaskKey(key)) {
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
  const currentTask = task(date, key);
  if (isCustomTask(currentTask) && !isCustomTaskApproved(currentTask)) {
    toast('Jaco 批准这个任务后才能上传证明');
    pendingUpload = null;
    return;
  }

  if (isCustomTask(currentTask) && !canConnieSubmitTask(date, currentTask)) {
    toast('只能在任务当天上传证明');
    pendingUpload = null;
    return;
  }

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

    const row = keepCustomTaskFields(clearLateSubmitUnlock({
      task_date: dateKey,
      task_key: key,
      status: 'pending',
      proof_url: serializeStoredList(urls),
      proof_name: serializeStoredList(names),
      submitted_at: new Date().toISOString(),
      reviewed_at: null,
      reviewed_by: null,
    }));
    const { error } = await db.from('tasks').upsert(row, TASK_UPSERT_OPTIONS);

    if (error) throw error;
    toast(files.length > 1 ? `已提交 ${files.length} 张图片，等待 Jaco 审核` : '已提交，等待 Jaco 审核');
  } catch (err) {
    toast('上传失败：' + err.message);
  }

  pendingUpload = null;
  await loadAll();
}

async function unlockLateSubmit(date, key) {
  if (!requireJaco()) return;
  if (!TASK_KEYS.includes(key) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    toast('任务参数无效');
    return;
  }

  const currentTask = tasks.find((item) => item.task_date === date && item.task_key === key) || { status: 'none' };
  const status = normalizeStatus(currentTask.status);
  if (status === 'pending') {
    toast('这个任务已经在等待审核');
    return;
  }

  if (status === 'approved') {
    toast('这个任务已经通过了');
    return;
  }

  const row = {
    task_date: date,
    task_key: key,
    status: 'rejected',
    late_submit_unlocked_at: new Date().toISOString(),
    late_submit_unlocked_by: session.user.id,
  };
  const { error } = await db.from('tasks').upsert(row, TASK_UPSERT_OPTIONS);

  if (error) {
    const setupHint = String(error.message || '').includes('late_submit_unlocked')
      ? '（请先在 Supabase SQL Editor 执行 supabase/rls.sql）'
      : '';
    toast(`${openSubmitText(date)}失败：${error.message}${setupHint}`);
    return;
  }

  lateSubmitUnlockColumnsAvailable = true;
  toast(`已给 Connie ${openSubmitText(date)}机会`);
  await loadAll();
}

async function reviewCustomTask(date, key, status) {
  if (!requireJaco()) return;
  if (!isCustomTaskKey(key) || !REVIEW_STATUSES.includes(status)) {
    toast('任务申请审核参数无效');
    return;
  }

  const existing = taskByDateKey(date, key);
  if (!existing || !isCustomTask(existing)) {
    toast('没有找到这个自定义任务申请');
    return;
  }

  const row = keepCustomTaskFields(clearLateSubmitUnlock({
    task_date: date,
    task_key: key,
    status: 'none',
    custom_review_status: status,
    custom_reviewed_at: new Date().toISOString(),
    custom_reviewed_by: session.user.id,
    proof_url: null,
    proof_name: null,
    submitted_at: null,
    reviewed_at: null,
    reviewed_by: null,
  }));

  const { error } = await db.from('tasks').upsert(row, TASK_UPSERT_OPTIONS);
  if (error) {
    toast('任务申请审核失败：' + error.message);
    return;
  }

  toast(status === 'approved' ? '已批准任务，等待 Connie 上传证明' : '已拒绝这个任务申请');
  await loadAll();
}

async function review(date, key, status) {
  if (!requireJaco()) return;
  if (!isValidTaskKey(key) || !REVIEW_STATUSES.includes(status)) {
    toast('审核参数无效');
    return;
  }

  const existing = taskByDateKey(date, key);
  if (isCustomTaskKey(key) && (!existing || !isCustomTaskApproved(existing))) {
    toast('请先批准这个自定义任务，再审核完成证明');
    return;
  }

  const row = keepCustomTaskFields(clearLateSubmitUnlock({
    task_date: date,
    task_key: key,
    status,
    reviewed_at: new Date().toISOString(),
    reviewed_by: session.user.id,
  }));

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
  if (!isValidTaskKey(key)) {
    toast('任务类型无效');
    return;
  }

  const row = keepCustomTaskFields(clearLateSubmitUnlock({
    task_date: date,
    task_key: key,
    status: 'pending',
    reviewed_at: null,
    reviewed_by: null,
  }));
  const { error } = await db.from('tasks').upsert(row, TASK_UPSERT_OPTIONS);

  if (error) {
    toast('撤销失败：' + error.message);
    return;
  }

  toast('已撤销通过，重新等待审核');
  await loadAll();
}

function customTaskForDelete(date, key) {
  const existing = taskByDateKey(date, key);
  if (existing && isCustomTask(existing)) return existing;
  return recurringTemplateForDate(dateFromYmd(date), key);
}

function recurringTemplateForDelete(date, key, item) {
  if (isRecurringTemplate(item)) return item;
  return recurringTemplateForSeries(item) || recurringTemplateForDate(dateFromYmd(date), key);
}

function taskDeleteSetupHint(error) {
  const message = String(error?.message || '');
  return /custom_deleted_dates|custom_stopped_from|row-level security|permission|delete/i.test(message)
    ? '（请先在 Supabase SQL Editor 执行 supabase/rls.sql）'
    : '';
}

async function deleteSingleRecurringOccurrence(date, key, item) {
  if (hasCustomCompletionRecord(item)) {
    return { error: null, keptHistory: true };
  }

  const template = recurringTemplateForDelete(date, key, item);
  if (!template) {
    const existing = taskByDateKey(date, key);
    if (hasCustomCompletionRecord(existing)) return { error: null, keptHistory: true };
    return db.from('tasks').delete().eq('task_date', date).eq('task_key', key);
  }

  const deletedDates = serializeCustomDeletedDates([...customDeletedDates(template), date]);
  const templateUpdate = { custom_deleted_dates: deletedDates };
  if (template.task_date === date) {
    Object.assign(templateUpdate, clearLateSubmitUnlock({
      status: 'none',
      proof_url: null,
      proof_name: null,
      submitted_at: null,
      reviewed_at: null,
      reviewed_by: null,
    }));
  }

  const templateRes = await db
    .from('tasks')
    .update(templateUpdate)
    .eq('task_date', template.task_date)
    .eq('task_key', key);

  if (templateRes.error) return templateRes;

  const existing = taskByDateKey(date, key);
  if (existing && !isRecurringTemplate(existing)) {
    if (hasCustomCompletionRecord(existing)) return { error: null, keptHistory: true };
    const cleanupRes = await db.from('tasks').delete().eq('task_date', date).eq('task_key', key);
    if (cleanupRes.error) return { ...cleanupRes, partial: true };
  }

  return { error: null };
}

function seriesStopDateForDelete(date, item) {
  const today = ymd(new Date());
  let stopFrom = date < today ? today : date;

  if (hasCustomCompletionRecord(item) && stopFrom <= item.task_date) {
    stopFrom = shiftDateKey(item.task_date, 1);
  }

  return stopFrom;
}

async function stopRecurringCustomTask(date, key, item) {
  const template = recurringTemplateForDelete(date, key, item);
  if (!template) {
    return { error: new Error('没有找到这个周期任务模板') };
  }

  const stopFrom = seriesStopDateForDelete(date, item);
  const templateRes = await db
    .from('tasks')
    .update({ custom_stopped_from: stopFrom })
    .eq('task_date', template.task_date)
    .eq('task_key', key);

  return templateRes.error ? templateRes : { error: null, stopFrom };
}

async function deleteCustomTask(date, key, scope = 'single') {
  if (!requireJaco()) return;
  if (!isValidDateKey(date) || !isCustomTaskKey(key) || !['single', 'series'].includes(scope)) {
    toast('删除参数无效');
    return;
  }

  const item = customTaskForDelete(date, key);
  if (!item || !isCustomTask(item)) {
    toast('没有找到这个自定义任务');
    return;
  }

  const repeatRule = customRepeatRule(item);
  const deleteSeries = scope === 'series' && repeatRule === 'weekly';
  const title = customTaskTitle(item);
  const stopFrom = deleteSeries ? seriesStopDateForDelete(date, item) : '';
  const confirmText = deleteSeries
    ? `确定从 ${stopFrom} 起停止周期任务「${title}」吗？之前已提交/已通过的记录和积分会保留。`
    : repeatRule === 'weekly'
      ? `确定只删除 ${date} 这一次「${title}」吗？周期里的其他日期会保留。`
      : `确定删除尚未提交的任务「${title}」吗？`;

  if (!confirm(confirmText)) return;

  let result = { error: null };
  if (deleteSeries) {
    result = await stopRecurringCustomTask(date, key, item);
  } else if (repeatRule === 'weekly') {
    result = await deleteSingleRecurringOccurrence(date, key, item);
  } else if (hasCustomCompletionRecord(item)) {
    toast('已有提交记录，历史积分和图片会保留，不删除');
    return;
  } else {
    result = await db.from('tasks').delete().eq('task_date', date).eq('task_key', key);
  }

  if (result.error) {
    if (result.partial) {
      toast(`已隐藏本次，但清理提交记录失败：${result.error.message}${taskDeleteSetupHint(result.error)}`);
      await loadAll();
      return;
    }

    toast(`删除失败：${result.error.message}${taskDeleteSetupHint(result.error)}`);
    return;
  }

  if (result.keptHistory) {
    toast('已有提交记录，历史积分和图片已保留');
  } else {
    toast(deleteSeries ? `已从 ${result.stopFrom || stopFrom} 起停止周期任务` : '已删除未来任务');
  }
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
  toggleCustomRepeatDays,
  submitCustomTask,
  upload,
  handleFile,
  unlockLateSubmit,
  reviewCustomTask,
  review,
  revoke,
  deleteCustomTask,
  adjustScore,
  deleteAdjustment,
  showImg,
});

init();
