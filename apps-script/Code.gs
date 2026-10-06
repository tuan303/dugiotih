/**
 * @OnlyCurrentDoc
 *
 * Apps Script gắn với Google Sheet chứa câu trả lời của biểu mẫu “Phiếu đánh giá giờ dạy”.
 *
 * Nhiệm vụ: gọi máy chủ Vercel (POST /api/sync) để đồng bộ Sheet → Firestore
 *   • ngay khi có phiếu mới được gửi từ Google Form (trigger “Khi gửi biểu mẫu”);
 *   • định kỳ 15 phút/lần (bắt cả những chỉnh sửa gõ trực tiếp trên Sheet).
 * Máy chủ chỉ ghi phần thay đổi nên gọi nhiều lần cũng không tốn kém.
 *
 * CẤU HÌNH – KHÔNG ghi bí mật vào mã nguồn:
 *   Cài đặt dự án (biểu tượng bánh răng) → Thuộc tính tập lệnh (Script Properties):
 *     SYNC_URL     = https://<tên-miền-vercel>/api/sync
 *     SYNC_SECRET  = giống hệt biến môi trường SYNC_SECRET trên Vercel
 *   Sau đó chạy installTriggers() MỘT lần và cấp quyền. Chạy setup() để xem hướng dẫn/trạng thái.
 *
 * Các hàm chạy tay: setup(), installTriggers(), removeTriggers(), syncNow().
 * Hàm do trigger gọi: onFormSubmitTrigger(e), scheduledSync().
 */

const HANDLERS = ['onFormSubmitTrigger', 'scheduledSync']; // chỉ các trigger này bị xóa/tạo lại
const FORM_DELAY_MS = 3000;        // chờ Sheet cập nhật dữ liệu sau khi gửi biểu mẫu
const SCHEDULE_MINUTES = 15;       // chu kỳ đồng bộ định kỳ (Apps Script cho phép 1, 5, 10, 15, 30)
const LOCK_WAIT_MS = 90 * 1000;    // chờ tối đa lượt đồng bộ khác của script này
const RETRIES_ON_LOCKED = 2;       // máy chủ trả 409 (đang có lượt đồng bộ khác) → thử lại
const RETRY_WAIT_MS = 15 * 1000;
const PROP_LAST_OK = 'LAST_OK_START_MS'; // do script tự ghi, không cần đặt tay

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

  console.log([
    'HƯỚNG DẪN CẤU HÌNH ĐỒNG BỘ DASHBOARD DỰ GIỜ',
    '1. Bấm biểu tượng bánh răng “Cài đặt dự án” ở thanh bên trái.',
    '2. Kéo xuống “Thuộc tính tập lệnh” → “Thêm thuộc tính tập lệnh”, thêm 2 dòng:',
    '     SYNC_URL     = https://<tên-miền-vercel>/api/sync',
    '     SYNC_SECRET  = <giống hệt biến SYNC_SECRET trên Vercel>',
    '   rồi bấm “Lưu thuộc tính tập lệnh”.',
    '3. Quay lại “Trình chỉnh sửa”, chọn hàm installTriggers → Chạy → cấp quyền khi được hỏi.',
    '4. Chọn hàm syncNow → Chạy để thử; kết quả hiện trong “Nhật ký thực thi”.',
    '',
    'TRẠNG THÁI HIỆN TẠI',
    '  SYNC_URL    : ' + (url || '(chưa đặt)') + (url && !/^https:\/\//i.test(url) ? '  ← phải bắt đầu bằng https://' : ''),
    '  SYNC_SECRET : ' + (secret ? 'đã đặt (' + secret.length + ' ký tự)' : '(chưa đặt)'),
    '  Trigger     : ' + (triggers.length ? '\n' + triggers.join('\n') : '(chưa cài – chạy installTriggers)'),
    '  Lần đồng bộ thành công gần nhất: ' + (lastOk ? new Date(lastOk).toLocaleString('vi-VN') : '(chưa có)'),
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

  const removed = removeTriggers();
  ScriptApp.newTrigger('onFormSubmitTrigger').forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger('scheduledSync').timeBased().everyMinutes(SCHEDULE_MINUTES).create();
  console.log('Đã xóa ' + removed + ' trigger cũ; đã cài: onFormSubmitTrigger (khi gửi biểu mẫu) và scheduledSync (mỗi ' +
    SCHEDULE_MINUTES + ' phút) cho “' + ss.getName() + '”.');
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
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    console.warn('[' + reason + '] Đang có lượt đồng bộ khác của script, bỏ qua lượt này (lượt định kỳ sẽ cập nhật sau).');
    return null;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    if (coveredAfterMs) {
      const lastOk = Number(props.getProperty(PROP_LAST_OK) || 0);
      if (lastOk >= coveredAfterMs) {
        console.log('[' + reason + '] Bỏ qua: vừa có lượt đồng bộ khác đã bao gồm phiếu này.');
        return null;
      }
    }

    for (let attempt = 0; ; attempt++) {
      const startedAt = Date.now();
      const res = callSync_(cfg, reason);
      const b = res.body || {};

      if (res.code === 409 && attempt < RETRIES_ON_LOCKED) {
        // Lượt đang chạy thường tự chạy lại để lấy dữ liệu mới; thử lại để chắc chắn.
        console.log('[' + reason + '] Máy chủ đang đồng bộ lượt khác (409) – thử lại sau ' + RETRY_WAIT_MS / 1000 + ' giây.');
        Utilities.sleep(RETRY_WAIT_MS);
        continue;
      }
      if (res.code === 409) {
        console.warn('[' + reason + '] Máy chủ vẫn bận (409) sau ' + (attempt + 1) + ' lần thử – để lượt sau cập nhật.');
        return b;
      }
      if (res.code >= 200 && res.code < 300 && b.ok) {
        if (!b.skipped) props.setProperty(PROP_LAST_OK, String(startedAt));
        console.log('[' + reason + '] ' + describe_(b));
        (Array.isArray(b.warnings) ? b.warnings : []).forEach(w => console.warn('[' + reason + '] Lưu ý: ' + w));
        return b;
      }

      // 401/403/404/5xx…: báo lỗi để lượt chạy hiện “Không thành công” trong mục Lượt thực thi (Executions)
      // (Google gửi email thông báo lỗi trigger cho người đã cài trigger).
      const msg = b.error || res.text;
      throw new Error('[' + reason + '] Đồng bộ thất bại – HTTP ' + res.code + ': ' + msg + hint_(res.code));
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

function describe_(b) {
  if (b.skipped) return 'Máy chủ bỏ qua lượt này (' + b.skipped + ').';
  return [
    'Đồng bộ xong (' + (b.trigger || '?') + '): tổng ' + (b.count != null ? b.count : '?') + ' phiếu',
    '+' + (b.added || 0) + ' mới',
    (b.updated || 0) + ' sửa',
    (b.removed || 0) + ' xóa',
    (b.chunksWritten || 0) + ' khối dữ liệu ghi lại',
    b.staffChanged ? 'DS nhân sự thay đổi' : '',
    b.accessChanged ? 'danh sách quyền xem thay đổi' : '',
    (b.durationMs != null ? b.durationMs : '?') + ' ms',
  ].filter(Boolean).join(' · ');
}

function hint_(code) {
  if (code === 401) return ' → Kiểm tra SYNC_SECRET trong Script Properties có trùng biến SYNC_SECRET trên Vercel không (và đã Redeploy sau khi đặt biến). Nếu SYNC_URL là link Preview của Vercel, hãy dùng tên miền Production.';
  if (code === 403) return ' → Máy chủ từ chối quyền; kiểm tra SYNC_SECRET.';
  if (code === 404) return ' → Sai SYNC_URL (phải kết thúc bằng /api/sync).';
  if (code >= 500) return ' → Lỗi phía máy chủ; xem Vercel → Project → Logs.';
  return '';
}
