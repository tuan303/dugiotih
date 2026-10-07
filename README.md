# Dashboard dự giờ – Ngôi Sao Hoàng Mai

Bảng điều hành tổng hợp kết quả biểu mẫu **“Phiếu đánh giá giờ dạy”** (Google Form) của Trường Tiểu học,
THCS & THPT Ngôi Sao Hoàng Mai.

- **Google Sheet câu trả lời là dữ liệu gốc.** Không sửa dữ liệu ở nơi nào khác.
- Một hàm máy chủ trên **Vercel** (`/api/sync`) chép dữ liệu Sheet sang **Firebase Firestore**, chỉ ghi phần thay đổi.
- Người xem **đăng nhập bằng tài khoản Microsoft 365 của trường** (`…@hoangmaistarschool.edu.vn`) qua Firebase
  Authentication. Dashboard đọc Firestore và **tự cập nhật theo thời gian thực**.

> **Repo này công khai.** Không commit mã Google Sheet, khóa service account, client secret hay bất kỳ bí mật nào.
> Các giá trị đó chỉ nằm trong biến môi trường của Vercel, trong Firebase console và trong Script Properties của
> Apps Script. Cấu hình web của Firebase (`apiKey`, `projectId`…) và Tenant ID của Microsoft 365 là thông tin
> công khai theo thiết kế, nên được phép nằm trong `index.html`.

> [!IMPORTANT]
> **Hai điều kiện bảo mật bắt buộc trước khi đưa dashboard vào sử dụng:**
>
> 1. App registration trên Microsoft Entra mà Firebase dùng để đăng nhập phải là **Single tenant**
>    (*Single tenant only* / *Accounts in this organizational directory only*) với Redirect URI
>    `https://dugiotih.firebaseapp.com/__/auth/handler`. Nếu chọn multi-tenant, người ngoài trường có thể giả mạo
>    email `@hoangmaistarschool.edu.vn` và xem được dữ liệu. Xem [Bảo mật đăng nhập Microsoft 365](#bảo-mật-đăng-nhập-microsoft-365).
> 2. Google Sheet câu trả lời phải ở chế độ chia sẻ **“Bị hạn chế”** (chỉ chia sẻ quyền Xem cho service account của
>    máy chủ). Khi Sheet còn ở chế độ *“Bất kỳ ai có đường liên kết”*, ai có link đều đọc được **toàn bộ câu trả lời
>    và trang “DS Nhân sự” (kể cả email)** mà không cần đăng nhập – vượt qua mọi lớp bảo vệ của dashboard. Xem
>    [bước 2](#2-firebase-console-httpsconsolefirebasegooglecom--project-dugiotih). Khi Sheet còn công khai, máy chủ
>    tự ẩn đường dẫn Sheet khỏi dashboard và trả cảnh báo trong mỗi lượt đồng bộ.

## Mục lục

- [Kiến trúc](#kiến-trúc)
- [Bảo mật đăng nhập Microsoft 365](#bảo-mật-đăng-nhập-microsoft-365)
- [Dữ liệu trong Firestore](#dữ-liệu-trong-firestore)
- [Cài đặt (làm theo thứ tự)](#cài-đặt-làm-theo-thứ-tự)
- [Quản lý quyền xem](#quản-lý-quyền-xem)
- [Phát triển cục bộ](#phát-triển-cục-bộ)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Bảo trì định kỳ](#bảo-trì-định-kỳ)
- [Chi phí](#chi-phí)

## Kiến trúc

```
Google Form ─► Google Sheet (dữ liệu gốc: trang “Câu trả lời biểu mẫu” + trang “DS Nhân sự”)
                   │
                   │  Ba nguồn kích hoạt đồng bộ:
                   │   ① Apps Script gắn với Sheet: ngay khi có phiếu mới + định kỳ 15 phút/lần   (Bearer SYNC_SECRET)
                   │   ② Vercel Cron: mỗi ngày ~06:00 giờ VN (vercel.json), dự phòng            (Bearer CRON_SECRET)
                   │   ③ Dashboard đang mở: nút “Làm mới” + “Tự đồng bộ” khi dữ liệu cũ hơn     (Bearer Firebase ID token)
                   │      5/15/30 phút (người xem tự chọn, mặc định 15 phút)
                   ▼
        /api/sync  (Vercel Function, Node.js)
        đọc Sheet qua gviz → so sánh mã băm → CHỈ ghi phần thay đổi
                   ▼
        Cloud Firestore (project dugiotih)
                   ▼  onSnapshot (realtime), kiểm tra quyền bằng Security Rules
        index.html  –  đăng nhập Microsoft 365 (Firebase Auth, nhà cung cấp microsoft.com)
```

| Thành phần | Tệp |
|---|---|
| Dashboard (trang tĩnh, không cần build) | `index.html` |
| Logic dùng chung máy chủ/trình duyệt (đọc bảng gviz, chuẩn hóa, chia khối, dựng lại bản ghi) | `lib/shared.js` |
| API đồng bộ | `api/sync.js` và thư mục `server/` |
| Script gắn vào Google Sheet | `apps-script/Code.gs`, `apps-script/appsscript.json` |
| Security Rules & chỉ mục Firestore | `firestore.rules`, `firestore.indexes.json`, `firebase.json`, `.firebaserc` |
| Cấu hình Vercel (Cron, thời gian chạy hàm, header) | `vercel.json` |
| Chạy thử đồng bộ không ghi Firestore, kiểm thử offline | `scripts/dry-run.mjs`, `scripts/sync.test.mjs` |
| Mẫu biến môi trường | `.env.example` |
| Tệp không được tải lên khi deploy bằng Vercel CLI / không được commit | `.vercelignore`, `.gitignore` |

`dashboard-du-gio.html` (bản dashboard cũ dạng một tệp) và `dev-data.json` (dữ liệu xem trước) chứa thông tin
không được công khai nên đã nằm trong `.gitignore`.

## Bảo mật đăng nhập Microsoft 365

**Cách đăng nhập.** `index.html` chỉ dùng một nhà cung cấp: `OAuthProvider('microsoft.com')` với tham số
`tenant = af9ef20a-3158-43a0-a1ab-ad72a03eb4c5` (tenant Microsoft 365 của trường – thông tin công khai),
`prompt = select_account`, `domain_hint = hoangmaistarschool.edu.vn`. Không dùng Google, email/mật khẩu hay
đăng nhập ẩn danh.

**Vì sao không kiểm tra `email_verified`.** Firebase luôn đặt `email_verified = false` cho tài khoản Microsoft, vì
trường `email` trong token Microsoft Entra là thuộc tính *có thể thay đổi* và không được Microsoft xác minh.
Vì vậy hệ thống kiểm tra:

1. token được cấp qua nhà cung cấp `microsoft.com` (`request.auth.token.firebase.sign_in_provider`);
2. token có email khác rỗng;
3. email (viết thường) có trong danh sách được phép, **hoặc** tên miền của email (phần sau dấu `@` cuối cùng)
   có trong danh sách tên miền được phép.

**Vì sao App registration phải là Single tenant (bắt buộc).** Với ứng dụng multi-tenant, *quản trị viên của bất kỳ
tenant Microsoft nào* cũng có thể đặt email của một người dùng trong tenant của họ thành, chẳng hạn,
`hieutruong@hoangmaistarschool.edu.vn`, rồi đăng nhập vào ứng dụng – Firebase sẽ nhận email đó (kiểu tấn công
được gọi là “nOAuth”). Khi App registration là **Single tenant**, Microsoft Entra **chỉ cấp token cho tài khoản
nằm trong thư mục của trường** (thành viên và khách được mời), và chỉ quản trị viên của trường mới đặt được email
cho các tài khoản đó. Tham số `tenant` trong `index.html` chỉ giúp chuyển thẳng tới trang đăng nhập của trường;
**lớp bảo vệ thực sự là thiết lập Single tenant của App registration** – người dùng có thể sửa tham số phía trình
duyệt, nhưng không sửa được thiết lập trên Entra.

**Hai nơi kiểm tra quyền, cùng một quy tắc:**

| Nơi | Kiểm tra |
|---|---|
| `firestore.rules` (mọi lượt đọc Firestore từ trình duyệt) | đăng nhập bằng `microsoft.com` + email có trong `config/access.emails` hoặc tên miền có trong `config/access.domains`. Chưa có `config/access` (chưa đồng bộ lần nào) → từ chối. Client không được ghi ở đâu cả; `config/*` không ai đọc được từ trình duyệt. |
| `/api/sync` (nút “Làm mới”, “Tự đồng bộ”, “Thử đồng bộ lần đầu”) | xác minh Firebase ID token bằng Admin SDK, yêu cầu `sign_in_provider = microsoft.com` và email; được phép nếu email/tên miền có trong `config/access` hoặc trong biến môi trường (`ALLOWED_EMAILS`, `ALLOWED_DOMAINS`) – nhờ đó có thể đồng bộ ngay cả trước lần đồng bộ đầu tiên. |

Ở cả hai nơi, email phải có **đúng một** dấu `@` và được so khớp chính xác (không nhận tên miền con hay tên miền
giả dạng như `…@hoangmaistarschool.edu.vn.evil.com`).

**Lớp bảo vệ duy nhất chống nOAuth là thiết lập Single tenant** – ID token của Firebase không mang Tenant ID của
Microsoft nên mã nguồn không tự kiểm tra được. Hãy kiểm tra lại thiết lập này mỗi khi đổi client secret (xem
[bước 1](#1-microsoft-entra--tạo-app-registration)).

## Dữ liệu trong Firestore

| Đường dẫn | Nội dung | Ai đọc được |
|---|---|---|
| `dashboard/meta` | `version`, `syncedAt` (giờ máy chủ), `syncedAtMs`, `count` (số phiếu), `chunkIds`, `crit` (danh sách tiêu chí `{code, d, full}`), `staffCount`, `trigger` (nguồn kích hoạt), `sheetUrl` (đường dẫn Sheet – **chỉ có khi Sheet đã ở chế độ “Bị hạn chế”**; Sheet còn công khai → chuỗi rỗng), `durationMs` | người được cấp quyền |
| `dashboard/staff` | `teach: [{name, group, role}]` (giáo viên), `bgh: [{name, role}]` (Ban Giám hiệu) – **không chứa email** | người được cấp quyền |
| `dashboard_chunks/c000, c001…` | `{ i, n, data, hash }` – `data` là chuỗi JSON chứa tối đa ~500 phiếu dạng gọn. Dashboard chỉ đọc `meta`, `staff` và các tài liệu này. | người được cấp quyền |
| `phieu/{mã phiếu}` | mỗi phiếu một tài liệu, tên trường tiếng Việt: `thoiGianGui` (Timestamp), `ngayGui`, `ngayDay`, `toNguoiDu`, `nguoiDu`, `toGiaoVien`, `giaoVien`, `tenBai`, `tiet`, `mon`, `lop`, `khoi`, `diem` (`{"1.1": 4, …}`), `tongDiem`, `diemToiDa`, `diemTB`, `xepLoai`, `uuDiem`, `canKhacPhuc`, `capNhatLuc` – để xem trong Firebase console hoặc dùng cho ứng dụng khác | người được cấp quyền |
| `config/access` | `emails`, `domains` (viết thường), `updatedAt` – danh sách được xem | **chỉ máy chủ** |
| `config/syncState` | mã băm của lần đồng bộ trước (`phieuHashes`, `chunkHashes`, `staffHash`, `accessHash`), `lastRunMs`, `lastTrigger`, `lastResult` | **chỉ máy chủ** |
| `config/syncLock` | khóa chống chạy trùng (`until`, hết hạn sau 55 giây) | **chỉ máy chủ** |

Mỗi lượt đồng bộ: đọc Sheet → chỉ ghi các phiếu mới/sửa/xóa (lô ≤ 400 thao tác) → ghi toàn bộ thay đổi của
`dashboard/*` và `dashboard_chunks/*` trong **một lô nguyên tử** (dashboard không bao giờ thấy dữ liệu nửa cũ nửa
mới) → `dashboard/meta` luôn được ghi lại.

## Cài đặt (làm theo thứ tự)

**Cần chuẩn bị:**

- tài khoản quản trị Microsoft 365 / Entra của trường có quyền tạo App registration và cấp *admin consent*
  (vd. vai trò *Application Administrator* hoặc *Cloud Application Administrator*);
- quyền Owner/Editor của Firebase project `dugiotih`;
- tài khoản GitHub có quyền đẩy (push) lên repo `tuan303/dugiotih` – máy dùng để đẩy code phải đăng nhập GitHub
  (`gh auth login` của GitHub CLI, Git Credential Manager, hoặc khóa SSH);
- tài khoản Vercel đã kết nối GitHub, và ứng dụng **Vercel** trên GitHub được cấp quyền truy cập repo
  `tuan303/dugiotih` (GitHub → Settings → Applications → Vercel → *Repository access*);
- quyền chỉnh sửa Google Sheet câu trả lời.

### 0. Đẩy code lên GitHub (repo công khai)

Trong thư mục dự án (lần đầu – thư mục chưa phải kho git):

```bash
git init -b main
git add -A
git status --ignored --short                      # dev-data.json, dashboard-du-gio.html, .env (nếu có) phải hiện '!!'
git grep -n --cached "<mã-Google-Sheet-thật>"     # kiểm tra các tệp SẮP commit – không được có kết quả nào
git commit -m "Dashboard dự giờ: Firestore + Microsoft 365"
git remote add origin https://github.com/tuan303/dugiotih.git
git push -u origin main                           # cần đăng nhập GitHub (gh auth login hoặc token/SSH)
```

`git grep` không có `--cached` chỉ tìm trong tệp đã được theo dõi, nên chạy trước `git add` sẽ luôn “không có kết
quả”. Lần sau chỉ cần `git add -A && git status --ignored --short && git commit … && git push`.

Chỉ deploy qua GitHub (Vercel tự build mỗi lần push). Nếu dùng Vercel CLI (`vercel`, `vercel --prod`), CLI **không**
đọc `.gitignore` mà chỉ đọc `.vercelignore` – tệp này đã loại `.env`, `dev-data.json`, `dashboard-du-gio.html` và các
tệp khóa; không xóa nó.

### 1. Microsoft Entra – tạo App registration

Mở **Microsoft Entra admin center** – https://entra.microsoft.com – và đăng nhập bằng tài khoản quản trị của trường.
Nếu tài khoản có nhiều tenant, bấm biểu tượng ⚙ (Settings) → *Directories + subscriptions* để chuyển sang tenant
của trường.

- [ ] **Entra ID → App registrations → New registration** (giao diện cũ: *Identity → Applications → App registrations*):
  - **Name:** `Dashboard dự giờ (Firebase)` (tên hiển thị khi đăng nhập, đổi được về sau).
  - **Supported account types:** **Single tenant only – <tên tenant của trường>** (giao diện cũ: *Accounts in this
    organizational directory only (… only – Single tenant)*).
    **BẮT BUỘC** – đây là điều kiện ngăn tài khoản của tenant khác giả mạo email `@hoangmaistarschool.edu.vn`
    (xem [giải thích](#bảo-mật-đăng-nhập-microsoft-365)). Không chọn *Multiple Entra ID tenants* / *Any
    organizational directory* hay *personal Microsoft accounts*.
  - **Redirect URI:** nền tảng **Web**, giá trị `https://dugiotih.firebaseapp.com/__/auth/handler`.
  - Bấm **Register**.
- [ ] Trang **Overview** của ứng dụng vừa tạo:
  - sao chép **Application (client) ID** (dùng ở bước 2);
  - kiểm tra **Directory (tenant) ID** = `af9ef20a-3158-43a0-a1ab-ad72a03eb4c5` (giá trị đã có sẵn trong `index.html`);
  - kiểm tra **Supported account types** = *My organization only*. Kiểm tra chắc chắn hơn: mục **Manifest** phải có
    `"signInAudience": "AzureADMyOrg"`, hoặc chạy Azure CLI
    `az ad app show --id <Application (client) ID> --query signInAudience -o tsv` → phải in `AzureADMyOrg`.
    **Kiểm tra lại mỗi khi đổi client secret** (xem [Bảo trì định kỳ](#bảo-trì-định-kỳ)).
- [ ] **Certificates & secrets → Client secrets → New client secret:** nhập mô tả, chọn thời hạn (tối đa 24 tháng;
      Microsoft khuyên dưới 12 tháng) → **Add** → sao chép ngay cột **Value** (không phải *Secret ID*; giá trị chỉ
      hiện một lần). **Ghi lại ngày hết hạn và đặt lịch nhắc** đổi secret trước hạn khoảng 2 tuần – hết hạn là
      không ai đăng nhập được (xem [Bảo trì định kỳ](#bảo-trì-định-kỳ)).
- [ ] **API permissions:** giữ quyền mặc định **Microsoft Graph → User.Read** (Delegated). Nếu tenant không cho
      người dùng tự đồng ý cấp quyền (người dùng thấy *“Need admin approval”/“Cần phê duyệt của quản trị viên”*),
      bấm **Grant admin consent for <tên tenant>** → **Yes**.
- [ ] *(Tùy chọn – nếu có người đăng nhập bị báo “không có địa chỉ email”)* **Token configuration → Add optional
      claim** → Token type **ID** → chọn **email** → **Add**. Microsoft chỉ cấp claim `email` cho tài khoản có thuộc
      tính *Mail* (thường là tài khoản có hộp thư Exchange Online).
- [ ] *(Tùy chọn – thu hẹp thêm ở phía Microsoft)* **Enterprise applications** → chọn ứng dụng → **Properties** →
      *Assignment required?* = **Yes**, rồi **Users and groups** → gán người/nhóm được dùng. Khi đó chỉ người được
      gán mới đăng nhập được, bất kể cấu hình ở Vercel.

### 2. Firebase console (https://console.firebase.google.com → project `dugiotih`)

- [ ] **Authentication:** Build → Authentication → *Get started* → **Sign-in method** → *Add new provider* →
      **Microsoft** → *Enable* → dán **Application ID** = *Application (client) ID* và **Application secret** =
      *Value* của client secret ở bước 1 → **Save**. Callback URL Firebase hiển thị phải đúng là
      `https://dugiotih.firebaseapp.com/__/auth/handler` (trùng Redirect URI ở bước 1).
      **Không bật** các nhà cung cấp khác (Google, Email/Password, Anonymous…) – không cần, và Security Rules cũng
      chỉ chấp nhận `microsoft.com`.
- [ ] **Authorized domains:** Authentication → **Settings** → *Authorized domains* → *Add domain*: tên miền
      Production của Vercel (vd. `dugiotih.vercel.app` – xem đúng tên ở Vercel → Project → *Domains*) và tên miền
      riêng nếu có. `localhost` và `dugiotih.firebaseapp.com` đã có sẵn.
- [ ] **Firestore:** Build → **Firestore Database** → *Create database* → Edition **Standard**, Database ID
      **`(default)`**, Location **`asia-southeast1` (Singapore)** (không đổi được về sau) → *Start in production mode*.
- [ ] **Service account cho máy chủ (quyền tối thiểu – khuyên dùng):** mở Google Cloud console
      (https://console.cloud.google.com, chọn project `dugiotih`) → **IAM & Admin → Service Accounts** →
      *Create service account*: tên `dashboard-sync` → *Create and continue* → vai trò **Cloud Datastore User**
      (`roles/datastore.user`) → *Done*. Mở service account vừa tạo → **Keys → Add key → Create new key → JSON** →
      tải về tệp JSON. Máy chủ chỉ cần quyền đọc/ghi Firestore (xác minh ID token đăng nhập không cần vai trò IAM nào),
      nên khóa này lộ ra cũng không quản trị được Authentication hay các dịch vụ khác của project.
      *Cách đơn giản hơn nhưng quyền rộng hơn:* ⚙ Project settings → **Service accounts** → Firebase Admin SDK →
      **Generate new private key**.
      **Không commit, không gửi qua chat/email**; dán vào Vercel ở bước 3 rồi cất giữ an toàn hoặc xóa. Ghi lại giá
      trị `client_email` trong tệp (dùng ngay ở mục dưới).
- [ ] **BẮT BUỘC – đặt Google Sheet ở chế độ riêng tư:** mở Google Sheet → **Chia sẻ** → *Quyền truy cập chung*:
      **Bị hạn chế** → thêm `client_email` của service account với quyền **Người xem**, bỏ chọn “Thông báo cho mọi
      người” → *Gửi*. Máy chủ đọc Sheet bằng service account nên đồng bộ vẫn chạy bình thường. Khi Sheet còn ở chế
      độ “Bất kỳ ai có đường liên kết”, ai có link (hoặc mã Sheet – vd. từ bản dashboard cũ dạng một tệp) đều đọc được
      toàn bộ câu trả lời và “DS Nhân sự” kèm email; trong trường hợp đó máy chủ ẩn đường dẫn Sheet khỏi dashboard
      (`dashboard/meta.sheetUrl` để trống) và mỗi lượt đồng bộ trả cảnh báo *“Google Sheet đang ở chế độ ‘Bất kỳ ai có
      đường liên kết’…”*. Nếu tổ chức Google Workspace chặn chia sẻ ra ngoài miền, nhờ quản trị Workspace cho phép
      chia sẻ với `…@dugiotih.iam.gserviceaccount.com`.

### 3. Vercel

- [ ] *Add New → Project* → *Import Git Repository* → chọn `tuan303/dugiotih` → Framework Preset **Other**, để trống
      *Build Command* và *Output Directory*, Root Directory `./`.
- [ ] **Settings → Environment Variables** (môi trường **Production**; đổi biến xong phải **Redeploy** mới có hiệu lực):

| Biến | Bắt buộc | Ví dụ | Mục đích |
|---|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | ✔ (hoặc 3 biến dưới) | *toàn bộ nội dung tệp JSON* | Khóa service account ở bước 2 (ghi Firestore, xác minh ID token, đọc Sheet riêng tư). Chấp nhận JSON thô hoặc base64. |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | thay thế cho biến trên | `dugiotih`, `dashboard-sync@dugiotih.iam.gserviceaccount.com`, `-----BEGIN PRIVATE KEY-----\n…` | Khai báo rời (khóa giữ nguyên các ký tự `\n`). |
| `SHEET_ID` | ✔ | `1AbC…xyz` | Mã Google Sheet (đoạn giữa `/d/` và `/edit`). Chỉ đặt ở đây, không ghi vào mã nguồn. |
| `SHEET_GID_FORM` | – | `948197065` | gid trang “Câu trả lời biểu mẫu” (mặc định như ví dụ). |
| `SHEET_GID_STAFF` | – | `979319376` | gid trang “DS Nhân sự” (mặc định như ví dụ; để trống = không đọc danh sách nhân sự). |
| `SYNC_SECRET` | ✔ cho Apps Script | *chuỗi 64 ký tự hex* | Bí mật Apps Script gửi kèm khi gọi `/api/sync`. |
| `CRON_SECRET` | ✔ cho Cron | *chuỗi 64 ký tự hex khác* | Vercel Cron tự gửi kèm; thiếu biến này thì lượt cron bị từ chối. |
| `ALLOWED_DOMAINS` | – | `hoangmaistarschool.edu.vn` | Tên miền được xem. **Không đặt hoặc để trống = `hoangmaistarschool.edu.vn`** (mọi tài khoản của trường). `none` = tắt cấp quyền theo tên miền. |
| `ALLOWED_EMAILS` | – | `a@hoangmaistarschool.edu.vn, b@…` | Email được xem thêm (cách nhau bằng dấu phẩy) – dùng khi `ALLOWED_DOMAINS=none`. |
| `ACCESS_FROM_SHEET` | – | `bgh` | Lấy thêm email từ cột Email của “DS Nhân sự”: `bgh` (mặc định) = các dòng Ban Giám Hiệu; `all` = mọi nhân sự đang làm việc; `0` = không lấy. |

  Tạo chuỗi bí mật: mở Terminal, chạy `openssl rand -hex 32` (chạy 2 lần, mỗi biến một giá trị khác nhau).
- [ ] **Deploy** (hoặc Deployments → ⋯ → **Redeploy** nếu đã deploy trước khi đặt biến). Ghi lại tên miền
      Production và thêm vào *Authorized domains* của Firebase (bước 2) nếu chưa làm.
- [ ] Khuyến nghị: Settings → **Functions** → *Function Region* → **Singapore (sin1)** cho gần Firestore.

Liên kết *Preview* của Vercel (mỗi nhánh/commit một tên miền khác) không nằm trong *Authorized domains* nên không
đăng nhập được; hãy dùng tên miền Production.

### 4. Triển khai Security Rules và chỉ mục

Trong thư mục repo (`.firebaserc` đã chọn sẵn project `dugiotih`):

```bash
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules,firestore:indexes
```

Hoặc thủ công: Firestore Database → **Rules** → dán nội dung `firestore.rules` → **Publish**. Phần chỉ mục chỉ để
tiết kiệm dung lượng: tắt đánh chỉ mục trường `data` của `dashboard_chunks` (Firestore → Indexes → *Single field*
→ *Add exemption*: collection `dashboard_chunks`, field `data`, bỏ chọn mọi kiểu chỉ mục).

### 5. Apps Script (gắn vào Google Sheet)

- [ ] Mở Google Sheet → **Tiện ích mở rộng → Apps Script**.
- [ ] Dán toàn bộ `apps-script/Code.gs` thay cho nội dung tệp `Code.gs`.
      *Nếu dự án script đã có mã khác:* tạo tệp mới (＋ → *Tập lệnh*) rồi dán vào, không xóa mã cũ.
- [ ] ⚙ **Cài đặt dự án** → bật *Hiển thị tệp kê khai “appsscript.json” trong trình chỉnh sửa* → dán nội dung
      `apps-script/appsscript.json`. (Nếu dự án đã có mã khác và tệp kê khai có sẵn `oauthScopes`, chỉ **thêm**
      3 scope của tệp này vào danh sách.)
- [ ] ⚙ Cài đặt dự án → **Thuộc tính tập lệnh** (Script Properties) → thêm 2 thuộc tính:
      `SYNC_URL` = `https://<tên-miền-production>/api/sync`, `SYNC_SECRET` = giống hệt biến trên Vercel.
- [ ] Trình chỉnh sửa → chọn hàm **`installTriggers`** → *Chạy* → cấp quyền. Hàm tạo trigger “Khi gửi biểu mẫu”
      (`onFormSubmitTrigger`, chờ ~3 giây rồi đồng bộ) và trigger định kỳ 15 phút (`scheduledSync`). Chạy lại bao
      nhiêu lần cũng được – chỉ xóa/tạo lại trigger của chính script này.
- [ ] Chọn hàm **`syncNow`** → *Chạy* → xem *Nhật ký thực thi*. Hàm **`setup`** in hướng dẫn và trạng thái cấu
      hình; **`removeTriggers`** tạm dừng đồng bộ tự động.

Trigger chạy dưới tài khoản Google đã chạy `installTriggers` – nên dùng tài khoản lâu dài của nhà trường. Lỗi đồng
bộ hiện trong mục *Lượt thực thi* (Executions) của Apps Script và Google gửi email thông báo cho tài khoản đó.

### 6. Đồng bộ lần đầu

Chọn một trong ba cách:

- chạy `syncNow` ở bước 5;
- mở dashboard, đăng nhập bằng tài khoản của trường → màn hình “Chưa được cấp quyền” → bấm **“Thử đồng bộ lần đầu”**
  (dùng được khi tài khoản thuộc `ALLOWED_DOMAINS`/`ALLOWED_EMAILS` trên Vercel);
- từ Terminal:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" https://<tên-miền-production>/api/sync
```

Kết quả mẫu: `{"ok":true,"count":1040,"added":1040,"updated":0,"removed":0,"chunksWritten":3,…,"trigger":"cron"}`.
Lần đầu ghi khoảng 1.050 tài liệu; các lần sau chỉ ghi phần thay đổi. Lượt này cũng tạo `config/access` – trước đó
Security Rules từ chối mọi lượt đọc.

Thêm `?force=1` vào đường dẫn (`curl -H "Authorization: Bearer <CRON_SECRET>" '…/api/sync?force=1'`) để ghi lại
toàn bộ dữ liệu, bỏ qua so sánh mã băm – dùng khi nghi dữ liệu Firestore lệch với Sheet. `force` **chỉ có tác dụng
với `CRON_SECRET`** (không nhận với `SYNC_SECRET` của Apps Script hay với người dùng), vì mỗi lượt force ghi lại
khoảng 1.050 tài liệu.

Vercel Cron (khai báo trong `vercel.json`, lịch `0 23 * * *` theo giờ UTC) tự gọi `GET /api/sync` kèm
`CRON_SECRET` mỗi ngày, **khoảng 06:00–06:59 giờ Việt Nam** (gói Hobby không chạy đúng phút – có thể lệch tới 59 phút);
xem ở Vercel → Project → **Settings → Cron Jobs**.

### 7. Kiểm tra

Mở `https://<tên-miền-production>/` → đăng nhập bằng tài khoản Microsoft 365 của trường → dashboard hiện dữ liệu.
Gửi thử một phiếu trên Google Form: vài giây sau dashboard tự cập nhật, không cần tải lại trang.

Kiểm tra Sheet đã riêng tư: nhật ký `syncNow` (Apps Script) **không** còn dòng *“Lưu ý: Google Sheet đang ở chế độ
‘Bất kỳ ai có đường liên kết’…”*, và chân trang dashboard có liên kết “Google Sheet …”.

### 8. Tăng cường bảo mật (khuyến nghị)

- **Người có quyền chỉnh sửa Google Sheet = quản trị dashboard.** Họ mở được Apps Script và đọc `SYNC_SECRET` trong
  Script Properties (gọi được `/api/sync`), và khi `ACCESS_FROM_SHEET` khác `0` thì cột Email của “DS Nhân sự” quyết
  định ai xem được dashboard. Giữ danh sách người chỉnh sửa Sheet ở mức tối thiểu; đổi `SYNC_SECRET` khi có người
  rời trường (xem [Bảo trì định kỳ](#bảo-trì-định-kỳ)).
- **Giới hạn API key (tùy chọn):** Google Cloud console (project `dugiotih`) → *APIs & Services* → *Credentials* →
  khóa *Browser key (auto created by Firebase)* → *Application restrictions*: **Websites** → thêm
  `https://<tên-miền-production>/*`, `https://dugiotih.firebaseapp.com/*` (bắt buộc cho trang đăng nhập) và
  `http://localhost:8080/*` nếu cần phát triển cục bộ. API key web của Firebase là định danh công khai; dữ liệu được
  bảo vệ bởi Security Rules, không phải bởi việc giấu key.
- **Không bật thêm nhà cung cấp đăng nhập** trong Firebase và **không đổi App registration sang multi-tenant**.

## Quản lý quyền xem

Danh sách được xem (`config/access`) được máy chủ tính lại **mỗi lần đồng bộ**:

```
domains = ALLOWED_DOMAINS        (không đặt/để trống → hoangmaistarschool.edu.vn;  none → không cấp theo tên miền)
emails  = ALLOWED_EMAILS
        ∪ email trong cột Email của “DS Nhân sự”, theo ACCESS_FROM_SHEET:
              bgh (mặc định) → các dòng Ban Giám Hiệu
              all            → mọi nhân sự đang làm việc (người có ghi chú “nghỉ” bị bỏ qua)
              0              → không lấy
```

Người xem phải đăng nhập bằng Microsoft 365, và email (hoặc tên miền của email) phải có trong danh sách.
**Mặc định: mọi tài khoản `@hoangmaistarschool.edu.vn` đều xem được dashboard.**

Trang dashboard chỉ nhận tài khoản có email `@hoangmaistarschool.edu.vn` (tài khoản khác bị báo “Vui lòng dùng tài
khoản @hoangmaistarschool.edu.vn” ngay sau khi đăng nhập). Vì vậy các biến dưới đây dùng để **thu hẹp** quyền trong
phạm vi tài khoản của trường, không dùng để mở cho tên miền khác.

| Muốn | Đặt trên Vercel |
|---|---|
| Mọi tài khoản của trường (mặc định) | không đặt `ALLOWED_DOMAINS` (hoặc `ALLOWED_DOMAINS=hoangmaistarschool.edu.vn`) |
| Chỉ nhân sự có tên trong “DS Nhân sự” | `ALLOWED_DOMAINS=none`, `ACCESS_FROM_SHEET=all` (cột Email phải được điền) |
| Chỉ Ban Giám hiệu | `ALLOWED_DOMAINS=none`, `ACCESS_FROM_SHEET=bgh` |
| Danh sách cố định | `ALLOWED_DOMAINS=none`, `ACCESS_FROM_SHEET=0`, `ALLOWED_EMAILS=a@…, b@…` |

> [!WARNING]
> Nếu **học sinh cũng có tài khoản** `@hoangmaistarschool.edu.vn` thì với cấu hình mặc định, học sinh cũng xem được
> kết quả đánh giá giờ dạy của giáo viên. Khi đó hãy thu hẹp quyền: `ALLOWED_DOMAINS=none` + `ACCESS_FROM_SHEET=all`
> (chỉ nhân sự có trong “DS Nhân sự”), và/hoặc bật *Assignment required* cho ứng dụng trên Entra (bước 1).

- Email trong “DS Nhân sự” / `ALLOWED_EMAILS` phải là **địa chỉ email chính của tài khoản Microsoft 365** (thường
  trùng tên đăng nhập). Cột chứa email phải có tiêu đề chứa chữ “Email”. Mỗi lượt đồng bộ trả về `warnings` (xem
  trong Vercel Logs hoặc nhật ký Apps Script) nếu thành viên BGH chưa có email hoặc danh sách quyền đang trống.
- Đổi cấu hình trên Vercel → **Redeploy** → chạy một lượt đồng bộ (chờ lượt định kỳ ≤ 15 phút, chạy `syncNow`, hoặc
  bấm “Làm mới”). Đổi “DS Nhân sự” chỉ cần chờ lượt đồng bộ kế tiếp.
- **Thu hồi quyền:** xóa email khỏi danh sách (hoặc ghi chú “nghỉ” trong “DS Nhân sự”) → chạy một lượt đồng bộ.
  Với quyền theo tên miền, khóa tài khoản Microsoft 365 **không** tự đăng xuất phiên Firebase đang mở: vào Firebase
  console → Authentication → **Users** → tìm email → **Disable account** (phiên hiện có hết hiệu lực trong ≤ 1 giờ).

## Phát triển cục bộ

```bash
npm install
cp .env.example .env                          # chỉ điền SHEET_ID (+ FIREBASE_SERVICE_ACCOUNT nếu Sheet riêng tư); .env đã nằm trong .gitignore
npm run dry-run                               # đọc Sheet, KHÔNG ghi Firestore → tạo dev-data.json
python3 -m http.server 8080 --bind 127.0.0.1  # chỉ máy này truy cập được; rồi mở http://localhost:8080/?local
npm test                                      # kiểm thử offline (scripts/*.test.mjs)
```

> [!WARNING]
> `python3 -m http.server` phục vụ **mọi tệp** trong thư mục, kể cả `.env` và `dev-data.json`. Luôn dùng
> `--bind 127.0.0.1`; nếu không, mọi máy cùng mạng (vd. Wi-Fi của trường) tải được `http://<IP-máy-bạn>:8080/.env`.
> Trong `.env` cục bộ chỉ đặt những gì cần: `SHEET_ID` cho dry-run, `FIREBASE_SERVICE_ACCOUNT` khi Sheet đã riêng
> tư; **không** đặt `SYNC_SECRET`/`CRON_SECRET` trừ khi chạy `vercel dev`.

- `npm run dry-run` đọc `SHEET_ID` từ `.env` (hoặc `npm run dry-run -- --sheet <mã>`), chạy toàn bộ logic đồng bộ
  trên kho dữ liệu trong bộ nhớ, in tóm tắt (số phiếu, tiêu chí, khối, nhân sự, quyền truy cập, chế độ chia sẻ của
  Sheet, cảnh báo) và ghi `dev-data.json`. Thêm `--no-write` để chỉ in tóm tắt. Nếu có `FIREBASE_SERVICE_ACCOUNT`
  (hoặc 3 biến `FIREBASE_*`), lệnh đọc Sheet bằng service account đó – bắt buộc khi Sheet đã ở chế độ “Bị hạn chế”;
  nếu không, chỉ đọc được Sheet công khai. Lệnh không ghi gì lên Firestore.
- `?local` (chỉ có tác dụng trên `localhost`/`127.0.0.1`) đọc `./dev-data.json` (`{ meta, staff, chunks: [{id, i, n, data}] }`)
  và **bỏ qua đăng nhập**; nút “Làm mới” khi đó đọc lại tệp. `dev-data.json` chứa dữ liệu thật nên đã nằm trong
  `.gitignore`.
- Mở `http://localhost:8080/` (không có `?local`) để thử đăng nhập Microsoft thật với dữ liệu Firestore thật
  (`localhost` có sẵn trong *Authorized domains*).
- Chạy cả `/api/sync` cục bộ: `npx vercel link` (một lần, chọn đúng project) rồi `npx vercel dev` (đọc biến môi
  trường từ `.env`). Không thêm script `dev` gọi `vercel dev` vào `package.json` – Vercel CLI sẽ từ chối chạy
  (“must not recursively invoke itself”).
- Deploy lên Production chỉ qua GitHub (push lên `main`). Nếu buộc phải deploy bằng Vercel CLI, `.vercelignore` là
  thứ ngăn `.env`, `dev-data.json` bị tải lên thành tệp công khai – giữ nguyên tệp này.
- Không dùng Firestore emulator (cần Java); `npm test` kiểm thử phần đồng bộ với kho dữ liệu trong bộ nhớ
  (`server/memory-store.js`). `firestore.rules` không có kiểm thử tự động – sau khi sửa rules, hãy thử đăng nhập
  thật hoặc dùng *Rules Playground* trong Firebase console.

## Xử lý sự cố

> [!IMPORTANT]
> **Bật Google Sheets API** cho project `dugiotih`: https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=dugiotih → **Enable**.
> Máy chủ đọc Sheet bằng Sheets API nên lấy **đủ mọi dòng** kể cả khi Sheet đang bật **bộ lọc**. Chưa bật thì máy chủ
> tạm đọc qua gviz (chỉ thấy các dòng đang hiển thị) và kèm cảnh báo; nếu số phiếu giảm quá nửa so với lần trước,
> đồng bộ dừng lại để không xóa dữ liệu trên dashboard.

## Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Số phiếu ít hơn trên Sheet; bỏ bộ lọc trên Sheet thì số phiếu tăng | Google Sheets API chưa bật → đọc qua gviz, chỉ thấy các dòng đang hiển thị | Bật Google Sheets API (ô lưu ý ở trên) rồi bấm **Làm mới** |
| Đồng bộ báo “Số phiếu giảm bất thường …” | Sheet đang bật bộ lọc (khi API chưa bật) hoặc nhiều dòng bị xóa | Bật Sheets API / bỏ lọc rồi Làm mới; nếu thật sự đã xóa, đồng bộ bằng `CRON_SECRET` kèm `?force=1` |
| Dashboard báo `permission-denied` / “Missing or insufficient permissions” | Chưa đồng bộ lần nào (chưa có `config/access`); email/tên miền không có trong danh sách; chưa triển khai `firestore.rules` | Chạy đồng bộ (bước 6); kiểm tra [Quản lý quyền xem](#quản-lý-quyền-xem); triển khai rules (bước 4). |
| `auth/unauthorized-domain` | Tên miền đang mở chưa có trong *Authorized domains* (kể cả link Preview của Vercel) | Firebase → Authentication → Settings → *Authorized domains* → thêm tên miền; hoặc dùng tên miền Production. |
| `auth/operation-not-allowed` | Chưa bật nhà cung cấp **Microsoft** trong Firebase | Làm lại bước 2 (Sign-in method → Microsoft → Enable). |
| `auth/invalid-credential` kèm `AADSTS7000215` (sai secret) hoặc `AADSTS7000222` (secret hết hạn) | Dán *Secret ID* thay vì *Value*; client secret đã hết hạn | Tạo client secret mới (bước 1) → dán *Value* vào Firebase → Save. |
| `AADSTS50011` (redirect URI không khớp) | Redirect URI trên Entra khác `https://dugiotih.firebaseapp.com/__/auth/handler` hoặc khai báo sai nền tảng | App registration → **Authentication** → nền tảng **Web** → thêm đúng URI. |
| `AADSTS50020` (tài khoản không thuộc tenant) | Đăng nhập bằng tài khoản Microsoft cá nhân (outlook.com, hotmail…) hoặc tài khoản của tổ chức khác | Chọn đúng tài khoản `@hoangmaistarschool.edu.vn`; nếu trình duyệt tự chọn sai, đăng xuất Microsoft hoặc dùng cửa sổ ẩn danh. Đây là hành vi đúng của ứng dụng Single tenant. |
| `AADSTS50194` (ứng dụng không phải multi-tenant) | Trang đăng nhập được mở qua endpoint `/common` (thiếu tham số `tenant`), vd. trình duyệt còn giữ bản `index.html` cũ | Tải lại trang (Ctrl/Cmd + Shift + R); kiểm tra `index.html` đang deploy có `tenant: 'af9ef20a-3158-43a0-a1ab-ad72a03eb4c5'`. **Không** chuyển App registration sang multi-tenant. |
| `AADSTS700016` (không tìm thấy ứng dụng) | *Application ID* trong Firebase sai, hoặc App registration được tạo ở tenant khác | Sao chép lại *Application (client) ID* từ đúng tenant của trường. |
| “Need admin approval” / `AADSTS65001`, `AADSTS90094` | Tenant không cho người dùng tự đồng ý quyền `User.Read` | Quản trị viên bấm **Grant admin consent** (bước 1, API permissions). |
| `AADSTS50105` (chưa được gán) | Đã bật *Assignment required* trên Enterprise application nhưng người dùng chưa được gán | Gán người/nhóm ở Enterprise applications → Users and groups, hoặc tắt *Assignment required*. |
| `auth/popup-blocked` / cửa sổ đăng nhập không hiện; hoặc “Đăng nhập qua trang chuyển hướng chưa hoàn tất” | Trình duyệt chặn cửa sổ bật lên | Trang tự chuyển sang đăng nhập kiểu chuyển hướng, nhưng trên Chrome 115+, Firefox 109+ và Safari 16.1+ kiểu này thường không hoàn tất (trang chạy trên tên miền Vercel còn trang đăng nhập Firebase ở `dugiotih.firebaseapp.com` → bị chặn lưu trữ bên thứ ba); trang sẽ báo lại khi quay về. Cách xử lý: cho phép pop-up cho trang (biểu tượng ở cuối thanh địa chỉ) rồi đăng nhập lại. |
| `auth/popup-closed-by-user` | Người dùng đóng cửa sổ đăng nhập | Bấm đăng nhập lại. |
| “Vui lòng dùng tài khoản @hoangmaistarschool.edu.vn” ngay sau khi đăng nhập | Đã chọn tài khoản Microsoft có email khác (vd. tài khoản khách) | Đăng xuất, chọn đúng tài khoản của trường. |
| “Tài khoản Microsoft này không có địa chỉ email” / `/api/sync` 403 “không có địa chỉ email” | Tài khoản Microsoft 365 không có thuộc tính *Mail* (vd. chưa có giấy phép Exchange Online), hoặc ID token không chứa claim `email` | Quản trị kiểm tra thuộc tính *Mail* của người dùng (Entra admin center → Users → Properties) / cấp giấy phép Exchange; thêm optional claim `email` cho App registration (bước 1). |
| `auth/account-exists-with-different-credential` | Email này đã có trong Firebase với phương thức đăng nhập khác (vd. Google, từ phiên bản thử nghiệm trước) | Firebase console → Authentication → **Users** → xóa tài khoản cũ của email đó, rồi đăng nhập lại bằng Microsoft. |
| `auth/user-disabled` | Tài khoản đã bị *Disable* trong Firebase → Authentication → Users | Bật lại nếu cần (*Enable account*). |
| `auth/web-storage-unsupported` | Trình duyệt chặn cookie/bộ nhớ (vd. chế độ ẩn danh nghiêm ngặt) | Dùng Edge/Chrome/Safari ở chế độ thường. |
| `AADSTS53003` | Chính sách *Conditional Access* của trường chặn lần đăng nhập (thiết bị/vị trí…) | Quản trị Entra xem **Sign-in logs** và điều chỉnh chính sách cho ứng dụng nếu cần. |
| `/api/sync` trả **401** | Thiếu/sai bí mật (`SYNC_SECRET`/`CRON_SECRET`); phiên đăng nhập hết hạn; gọi vào link *Preview* bị Vercel Deployment Protection chặn (trang HTML “Authentication Required”) | So khớp bí mật rồi *Redeploy*; đăng nhập lại; dùng tên miền Production. |
| `/api/sync` trả **403** | Tài khoản không đăng nhập bằng Microsoft, không có email, hoặc email/tên miền không được phép | Xem [Quản lý quyền xem](#quản-lý-quyền-xem). |
| `/api/sync` trả **409** `skipped: "locked"` | Đang có lượt đồng bộ khác | Chờ khoảng 1 phút (khóa tự hết hạn sau 55 giây). |
| `{"ok":true,"skipped":"recent"}` | Bấm “Làm mới” khi lượt trước vừa xong < 60 giây | Chờ một chút; dữ liệu vốn đã mới. (Apps Script và Cron không bị giới hạn này.) |
| `/api/sync` trả **429** “Lượt đồng bộ gần nhất chưa thành công…” | Người dùng gọi lại trong vòng 60 giây sau một lượt đồng bộ **thất bại** | Chờ hết thời gian ghi trong thông báo; xem lỗi của lượt trước (Vercel Logs, nhật ký Apps Script) và sửa nguyên nhân. |
| Cảnh báo “Google Sheet đang ở chế độ ‘Bất kỳ ai có đường liên kết’…”; chân trang dashboard không có liên kết tới Sheet | Sheet chưa được đặt riêng tư | Làm mục **BẮT BUỘC** ở bước 2 (Chia sẻ → Bị hạn chế → thêm `client_email` của service account). |
| **500**, lỗi nhắc tới biến môi trường / service account | Thiếu `SHEET_ID` hoặc `FIREBASE_SERVICE_ACCOUNT`, hoặc JSON dán sai | Đặt lại biến, *Redeploy*. |
| **500**, Google trả về trang HTML / “không có quyền đọc Google Sheet” | Sheet đã chuyển riêng tư nhưng chưa chia sẻ cho service account | Chia sẻ Sheet (Người xem) cho `client_email` của service account; nếu tổ chức Google chặn chia sẻ ra ngoài miền, nhờ quản trị Workspace cho phép chia sẻ với service account. Không mở lại “Bất kỳ ai có đường liên kết” (lộ toàn bộ dữ liệu). |
| **500** “Chưa tạo cơ sở dữ liệu Firestore” / `NOT_FOUND` | Chưa tạo database `(default)` | Làm lại bước 2 (Firestore). |
| Không tạo được khóa service account | Tổ chức Google Cloud bật chính sách `iam.disableServiceAccountKeyCreation` | Nhờ quản trị tổ chức cho phép riêng project `dugiotih`. |
| Gửi phiếu nhưng dashboard không đổi | Trigger Apps Script chưa cài hoặc bị lỗi | Apps Script → *Lượt thực thi* xem lỗi; chạy `setup` kiểm tra cấu hình; chạy lại `installTriggers`. |

Nhật ký máy chủ: Vercel → Project → **Logs** (lọc `/api/sync`) – gói Hobby chỉ giữ log **1 giờ**, nên để xem lịch
sử hãy dùng mục *Lượt thực thi* (Executions) của Apps Script (mỗi lượt ghi kết quả và cảnh báo của `/api/sync`).
Nhật ký đăng nhập Microsoft: Entra admin center → **Sign-in logs** (lọc theo tên ứng dụng).

## Bảo trì định kỳ

- **Đổi client secret của Microsoft trước khi hết hạn:** App registration → *Certificates & secrets* → *New client
  secret* → dán *Value* mới vào Firebase (Authentication → Sign-in method → Microsoft) → Save → thử đăng nhập →
  xóa secret cũ trên Entra. Đặt lịch nhắc cho lần kế tiếp. Nhân tiện kiểm tra lại App registration vẫn là Single
  tenant (`signInAudience` = `AzureADMyOrg`, xem bước 1).
- **Khóa service account Firebase:** nếu nghi bị lộ, vào Google Cloud console → IAM → Service accounts → xóa khóa cũ,
  tạo khóa mới, cập nhật `FIREBASE_SERVICE_ACCOUNT` trên Vercel → *Redeploy*.
- **`SYNC_SECRET` / `CRON_SECRET`:** đổi trên Vercel (*Redeploy*) và cập nhật `SYNC_SECRET` trong Script Properties.
  Đổi `SYNC_SECRET` mỗi khi có người từng có quyền chỉnh sửa Google Sheet rời trường.

## Chi phí

- **Firebase gói Spark (miễn phí)** đủ dùng: 50.000 lượt đọc, 20.000 lượt ghi, 20.000 lượt xóa mỗi ngày, 1 GiB lưu
  trữ. Đăng nhập bằng Microsoft thuộc Firebase Authentication thông thường, không tính phí.
- Mỗi lần mở dashboard chỉ đọc `meta`, `staff` và các khối `dashboard_chunks` (hiện 3 khối cho 1.040 phiếu), cộng
  một lượt đọc `config/access` cho mỗi lần Security Rules kiểm tra: khoảng 5–10 lượt đọc. Mỗi lượt đồng bộ có thay
  đổi chỉ đẩy lại `meta` và khối bị đổi tới các dashboard đang mở.
- Đồng bộ chỉ ghi phần thay đổi; khi Sheet không đổi, mỗi lượt chỉ ghi vài tài liệu (`meta`, trạng thái, khóa).
  Apps Script gọi ~96 lượt/ngày → vài trăm lượt ghi/ngày. “Tự đồng bộ” trên các dashboard đang mở chỉ gọi khi dữ
  liệu đã cũ hơn khoảng đã chọn, và máy chủ bỏ qua lượt của người dùng nếu lượt trước vừa xong < 60 giây.
- Bộ sưu tập `phieu` để xem trong console/ứng dụng khác; dashboard **không** đọc nó (đọc toàn bộ tốn ~1 lượt/phiếu).
- **Microsoft Entra:** App registration không tốn phí.
- **Vercel Hobby** miễn phí nhưng Vercel quy định gói này **chỉ dành cho mục đích cá nhân, phi thương mại** – nhà
  trường nên cân nhắc gói **Pro** cho hệ thống dùng chính thức. Gói Hobby: Cron tối đa 1 lần/ngày (lệch tới 59 phút),
  log máy chủ giữ 1 giờ. **Apps Script** trong hạn mức miễn phí; đồng bộ thường xuyên do Apps Script đảm nhận.
