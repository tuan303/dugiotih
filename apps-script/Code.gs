/**
 * @OnlyCurrentDoc
 *
 * Apps Script gắn với Google Sheet chứa câu trả lời của biểu mẫu “Phiếu đánh giá giờ dạy”.
 * Dùng NGUYÊN VĂN cho Sheet của từng cấp (Tiểu học, THCS, THPT): mỗi Sheet cài một bản riêng
 * (Tiện ích mở rộng → Apps Script trên chính Sheet đó). Mã không phụ thuộc cấp nào.
 *
 * Nhiệm vụ: gọi máy chủ Vercel (POST /api/sync) để đồng bộ Sheet → Firestore
 *   • ngay khi có phiếu mới được gửi từ Google Form (trigger “Khi gửi biểu mẫu”);
 *   • định kỳ 15 phút/lần kiểm tra (bắt cả những chỉnh sửa gõ trực tiếp trên Sheet).
 * Mỗi lượt, máy chủ đọc lại dữ liệu của MỌI cấp đã cấu hình (không chỉ Sheet đã gọi); Sheet không đổi kể từ lượt
 * trước → máy chủ bỏ qua, không ghi gì vào Firestore (“Google Sheet không có thay đổi”), có thay đổi → chỉ ghi phần đổi.
 *
 * CẤU HÌNH – KHÔNG ghi bí mật vào mã nguồn:
 *   Cài đặt dự án (biểu tượng bánh răng) → Thuộc tính tập lệnh (Script Properties):
 *     SYNC_URL          = https://<tên-miền-vercel>/api/sync
 *     SYNC_SECRET       = giống hệt biến môi trường SYNC_SECRET trên Vercel
 *     SCHEDULE_MINUTES  = (tùy chọn) chu kỳ đồng bộ định kỳ: 1, 5, 10, 15 (mặc định) hoặc 30;
 *                         0 = không cài trigger định kỳ (chỉ đồng bộ khi có phiếu mới gửi vào Sheet này)
 *   Sau đó chạy installTriggers() MỘT lần và cấp quyền. Chạy setup() để xem hướng dẫn/trạng thái.
 *
 * Các hàm chạy tay: setup(), installTriggers(), removeTriggers(), syncNow().
 * Hàm do trigger gọi: onFormSubmitTrigger(e), scheduledSync().
 */

const HANDLERS = ['onFormSubmitTrigger', 'scheduledSync']; // chỉ các trigger này bị xóa/tạo lại
const FORM_DELAY_MS = 3000;        // chờ Sheet cập nhật dữ liệu sau khi gửi biểu mẫu
const DEFAULT_SCHEDULE_MINUTES = 15; // chu kỳ đồng bộ định kỳ mặc định
const ALLOWED_SCHEDULE_MINUTES = [1, 5, 10, 15, 30]; // các giá trị Apps Script cho phép với everyMinutes()
const LOCK_WAIT_MS = 90 * 1000;    // chờ tối đa lượt đồng bộ khác của script này
const RETRIES_ON_LOCKED = 2;       // máy chủ trả 409 (đang có lượt đồng bộ khác) → thử lại
const RETRY_WAIT_MS = 15 * 1000;
const PROP_LAST_OK = 'LAST_OK_START_MS'; // do script tự ghi, không cần đặt tay
const LEVEL_LABELS = { tih: 'Tiểu học', thcs: 'THCS', thpt: 'THPT' }; // tên cấp trong kết quả đồng bộ v2

/* ======================= Hàm chạy tay ======================= */

/** Hướng dẫn cấu hình + kiểm tra trạng thái hiện tại (không thay đổi gì). */
function setup() {
  const props = PropertiesService.getScriptProperties();
  const url = (props.getProperty('SYNC_URL') || '').trim();
  const secret = (props.getProperty('SYNC_SECRET') || '').trim();
  const triggers = ScriptApp.getProjectTriggers()
    .filter(t => HANDLERS.indexOf(t.getHandlerFunction()) >= 0)
    .map(t => '  - ' + t.getHandlerFunction() + ' (' + t.getEventType() + ')');
  const lastOk = Number(props.getProperty(PROP_LAST_OK) || 0);
  let schedule;
  try { schedule = scheduleMinutes_(); } catch (err) { schedule = err.message; }

  console.log([
    'HƯỚNG DẪN CẤU HÌNH ĐỒNG BỘ DASHBOARD DỰ GIỜ (cài giống nhau trên Sheet của từng cấp)',
    '1. Bấm biểu tượng bánh răng “Cài đặt dự án” ở thanh bên trái.',
    '2. Kéo xuống “Thuộc tính tập lệnh” → “Thêm thuộc tính tập lệnh”, thêm 2 dòng:',
    '     SYNC_URL     = https://<tên-miền-vercel>/api/sync',
    '     SYNC_SECRET  = <giống hệt biến SYNC_SECRET trên Vercel>',
    '   (tùy chọn) SCHEDULE_MINUTES = 1, 5, 10, 15 hoặc 30 (mặc định 15); 0 = không đồng bộ định kỳ từ Sheet này',
    '   rồi bấm “Lưu thuộc tính tập lệnh”.',
    '3. Quay lại “Trình chỉnh sửa”, chọn hàm installTriggers → Chạy → cấp quyền khi được hỏi.',
    '4. Chọn hàm syncNow → Chạy để thử; kết quả hiện trong “Nhật ký thực thi”.',
    '',
    'TRẠNG THÁI HIỆN TẠI – Sheet “' + sheetName_() + '”',
    '  SYNC_URL    : ' + (url ? maskUrl_(url) : '(chưa đặt)') + (url && !/^https:\/\//i.test(url) ? '  ← phải bắt đầu bằng https://' : ''),
    '  SYNC_SECRET : ' + (secret ? 'đã đặt (' + secret.length + ' ký tự)' : '(chưa đặt)'),
    '  Chu kỳ      : ' + (typeof schedule === 'number' ? (schedule ? 'mỗi ' + schedule + ' phút' : 'không đồng bộ định kỳ (SCHEDULE_MINUTES=0)') : schedule),
    '  Trigger     : ' + (triggers.length ? '\n' + triggers.join('\n') : '(chưa cài – chạy installTriggers)'),
    '  Lần kiểm tra/đồng bộ thành công gần nhất: ' + (lastOk ? new Date(lastOk).toLocaleString('vi-VN') : '(chưa có)'),
  ].join('\n'));
}

/**
 * Cài (hoặc cài lại) trigger. Chạy lại bao nhiêu lần cũng được: trigger cũ của
 * các hàm trong HANDLERS bị xóa trước, trigger khác trong dự án (nếu có) được giữ nguyên.
 */
function installTriggers() {
  getConfig_(); // báo lỗi sớm nếu chưa đặt thuộc tính
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Script phải được mở từ chính Google Sheet (Tiện ích mở rộng → Apps Script).');

  const minutes = scheduleMinutes_(); // báo lỗi sớm nếu SCHEDULE_MINUTES sai

  const removed = removeTriggers();
  ScriptApp.newTrigger('onFormSubmitTrigger').forSpreadsheet(ss).onFormSubmit().create();
  if (minutes) ScriptApp.newTrigger('scheduledSync').timeBased().everyMinutes(minutes).create();
  console.log('Đã xóa ' + removed + ' trigger cũ; đã cài: onFormSubmitTrigger (khi gửi biểu mẫu)' +
    (minutes ? ' và scheduledSync (mỗi ' + minutes + ' phút)' : ' (không cài đồng bộ định kỳ vì SCHEDULE_MINUTES=0)') +
    ' cho “' + ss.getName() + '”.');
}

/** Gỡ các trigger của script này (dùng khi muốn tạm dừng đồng bộ tự động). Trả về số trigger đã xóa. */
function removeTriggers() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (HANDLERS.indexOf(t.getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

/** Đồng bộ ngay (chạy tay từ trình soạn thảo để thử kết nối). */
function syncNow() {
  return runSync_('manual');
}

/* ======================= Hàm do trigger gọi ======================= */

/** Trigger “Khi gửi biểu mẫu” của Sheet. */
function onFormSubmitTrigger(e) {
  Utilities.sleep(FORM_DELAY_MS);
  // Mọi lượt đồng bộ bắt đầu SAU thời điểm này chắc chắn đã có phiếu vừa gửi → nếu đã có thì bỏ qua.
  runSync_('form-submit', Date.now());
}

/** Trigger định kỳ. */
function scheduledSync() {
  runSync_('schedule');
}

/* ======================= Nội bộ ======================= */

/** Tên Sheet đang gắn script (để ghi nhật ký; phân biệt Sheet của từng cấp). */
function sheetName_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    return ss ? ss.getName() : '?';
  } catch (err) {
    return '?';
  }
}

/** Ẩn giá trị tham số truy vấn của URL khi in nhật ký (vd. ?x-vercel-protection-bypass=… của link Preview). */
function maskUrl_(url) {
  return String(url).replace(/([?&][^=&#]+=)[^&#]*/g, '$1…');
}

/** Chu kỳ đồng bộ định kỳ (phút) từ Script Property SCHEDULE_MINUTES; 0 = không cài trigger định kỳ. */
function scheduleMinutes_() {
  const raw = (PropertiesService.getScriptProperties().getProperty('SCHEDULE_MINUTES') || '').trim();
  if (!raw) return DEFAULT_SCHEDULE_MINUTES;
  const n = Number(raw);
  if (n === 0) return 0;
  if (ALLOWED_SCHEDULE_MINUTES.indexOf(n) < 0) {
    throw new Error('Script Property SCHEDULE_MINUTES = “' + raw + '” không hợp lệ: chỉ nhận 0, ' + ALLOWED_SCHEDULE_MINUTES.join(', ') + '.');
  }
  return n;
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const url = (props.getProperty('SYNC_URL') || '').trim();
  const secret = (props.getProperty('SYNC_SECRET') || '').trim();
  if (!/^https:\/\/\S+$/i.test(url)) {
    throw new Error('Chưa đặt Script Property SYNC_URL hợp lệ (dạng https://<tên-miền>/api/sync). Chạy setup() để xem hướng dẫn.');
  }
  if (!secret) {
    throw new Error('Chưa đặt Script Property SYNC_SECRET (giống biến SYNC_SECRET trên Vercel). Chạy setup() để xem hướng dẫn.');
  }
  return { url: url, secret: secret };
}

/**
 * Gọi /api/sync, có khóa để các trigger của script không chạy chồng nhau.
 * @param {string} reason  lý do (ghi nhật ký)
 * @param {number=} coveredAfterMs  nếu đã có lượt đồng bộ thành công bắt đầu từ thời điểm này → bỏ qua
 * @return {Object|null} JSON trả về từ máy chủ, hoặc null nếu bỏ qua
 */
function runSync_(reason, coveredAfterMs) {
  const cfg = getConfig_();
  const tag = '[' + reason + ' · ' + sheetName_() + '] ';
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    console.warn(tag + 'Đang có lượt đồng bộ khác của script, bỏ qua lượt này (lượt định kỳ sẽ cập nhật sau).');
    return null;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    if (coveredAfterMs) {
      const lastOk = Number(props.getProperty(PROP_LAST_OK) || 0);
      if (lastOk >= coveredAfterMs) {
        console.log(tag + 'Bỏ qua: vừa có lượt đồng bộ khác đã bao gồm phiếu này.');
        return null;
      }
    }

    for (let attempt = 0; ; attempt++) {
      const startedAt = Date.now();
      const res = callSync_(cfg, reason);
      const b = res.body || {};

      if (res.code === 409 && attempt < RETRIES_ON_LOCKED) {
        // Lượt đang chạy thường tự chạy lại để lấy dữ liệu mới; thử lại để chắc chắn.
        console.log(tag + 'Máy chủ đang đồng bộ lượt khác (409) – thử lại sau ' + RETRY_WAIT_MS / 1000 + ' giây.');
        Utilities.sleep(RETRY_WAIT_MS);
        continue;
      }
      if (res.code === 409) {
        console.warn(tag + 'Máy chủ vẫn bận (409) sau ' + (attempt + 1) + ' lần thử – để lượt sau cập nhật.');
        return b;
      }
      if (res.code >= 200 && res.code < 300 && b.ok) {
        // 'unchanged': máy chủ đã đọc Sheet sau thời điểm này và thấy dữ liệu đã có đủ → cũng tính là đã bao gồm.
        if (!b.skipped || b.skipped === 'unchanged') props.setProperty(PROP_LAST_OK, String(startedAt));
        console.log(tag + describe_(b));
        (Array.isArray(b.warnings) ? b.warnings : []).forEach(w => console.warn(tag + 'Lưu ý: ' + w));
        return b;
      }

      // 401/403/404/5xx…: báo lỗi để lượt chạy hiện “Không thành công” trong mục Lượt thực thi (Executions)
      // (Google gửi email thông báo lỗi trigger cho người đã cài trigger).
      const msg = b.error || res.text;
      throw new Error(tag + 'Đồng bộ thất bại – HTTP ' + res.code + ': ' + msg + hint_(res.code, res.text));
    }
  } finally {
    lock.releaseLock();
  }
}

function callSync_(cfg, reason) {
  const resp = UrlFetchApp.fetch(cfg.url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ source: 'apps-script', reason: reason }),
    headers: { Authorization: 'Bearer ' + cfg.secret },
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  const raw = resp.getContentText() || '';
  let body = null;
  try { body = JSON.parse(raw); } catch (err) { body = null; }
  // Phản hồi không phải JSON (vd. trang HTML) → chỉ giữ một đoạn ngắn để ghi nhật ký.
  const text = body ? '' : raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { code: code, body: body, text: text };
}

/**
 * Tóm tắt kết quả /api/sync thành một dòng nhật ký. Chỉ in các trường máy chủ thực sự trả về,
 * nên dùng được với cả máy chủ v1 (một cấp) lẫn v2 (toàn trường, có danh sách `levels`).
 */
function describe_(b) {
  if (b.skipped === 'unchanged') return 'Google Sheet không có thay đổi kể từ lượt trước – máy chủ không ghi gì (' + (b.count != null ? b.count + ' phiếu' : '?') + ').';
  if (b.skipped) return 'Máy chủ bỏ qua lượt này (' + b.skipped + ').';
  const parts = ['Đồng bộ xong (' + (b.trigger || '?') + ')'];
  // v2: levels = { tih: {enabled, count, stale}, thcs: {…}, thpt: {…} }
  const levels = b.levels && typeof b.levels === 'object' ? b.levels : null;
  const caps = levels ? Object.keys(levels) : [];
  if (caps.length) {
    parts.push(caps.map(cap => {
      const l = levels[cap] || {};
      const name = LEVEL_LABELS[cap] || cap;
      if (l.enabled === false) return name + ': chưa kết nối dữ liệu';
      return name + ': ' + (l.count != null ? l.count : '?') + ' phiếu' + (l.stale ? ' (giữ dữ liệu cũ – xem cảnh báo)' : '');
    }).join(', '));
    if (b.count != null) parts.push('tổng ' + b.count + ' phiếu');
  } else if (b.count != null) {
    parts.push('tổng ' + b.count + ' phiếu');
  }
  const counters = [
    ['added', ' phiếu mới'], ['updated', ' phiếu sửa'], ['removed', ' phiếu xóa'],
    ['scopesWritten', ' phạm vi ghi lại'], ['scopesDeleted', ' phạm vi xóa'],
    ['chunksWritten', ' khối dữ liệu ghi lại'], ['chunksDeleted', ' khối dữ liệu xóa'],
    ['accessWritten', ' tài liệu quyền ghi lại'], ['accessDeleted', ' tài liệu quyền xóa'],
  ];
  if (typeof b.accessCount === 'number') parts.push(b.accessCount + ' tài khoản được cấp quyền');
  counters.forEach(c => { if (typeof b[c[0]] === 'number' && b[c[0]]) parts.push(b[c[0]] + c[1]); });
  if (b.staffChanged) parts.push('DS nhân sự thay đổi');
  if (b.accessChanged) parts.push('phân quyền thay đổi');
  parts.push((b.durationMs != null ? b.durationMs : '?') + ' ms');
  return parts.join(' · ');
}

function hint_(code, text) {
  if (code === 401 && /vercel|authentication required|log in/i.test(text || '')) {
    return ' → SYNC_URL đang trỏ tới link Preview được Vercel Deployment Protection bảo vệ (trang “Authentication Required”). ' +
      'Dùng tên miền Production, hoặc thêm ?x-vercel-protection-bypass=<mã Protection Bypass for Automation> vào cuối SYNC_URL (README, mục thử nghiệm v2 trên Preview).';
  }
  if (code === 401) return ' → Kiểm tra SYNC_SECRET trong Script Properties có trùng biến SYNC_SECRET trên Vercel không (biến phải được tích cho đúng môi trường Production/Preview và đã Redeploy sau khi đặt).';
  if (code === 403) return ' → Máy chủ từ chối quyền; kiểm tra SYNC_SECRET.';
  if (code === 404) return ' → Sai SYNC_URL (phải kết thúc bằng /api/sync).';
  if (code >= 500) return ' → Lỗi phía máy chủ; xem Vercel → Project → Logs.';
  return '';
}
