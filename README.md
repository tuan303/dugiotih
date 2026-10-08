# Dashboard dự giờ – Ngôi Sao Hoàng Mai

Bảng điều hành tổng hợp kết quả biểu mẫu **“Phiếu đánh giá giờ dạy”** (Google Form) của Trường Tiểu học,
THCS & THPT Ngôi Sao Hoàng Mai.

> [!NOTE]
> **Hai phiên bản.** `main` = **v1** – dashboard Tiểu học, mọi tài khoản được phép xem toàn bộ (đang chạy chính thức).
> Nhánh `toan-truong` = **v2 – Dashboard toàn trường**: 3 cấp (Tiểu học, THCS, THPT), phân quyền BGH liên cấp / BGH
> cấp / Tổ trưởng / cá nhân. Xem [v2 – Dashboard toàn trường](#v2--dashboard-toàn-trường). Các phần còn lại của tài
> liệu (đăng nhập Microsoft 365, cài đặt Firebase, Vercel, xử lý sự cố…) áp dụng cho cả hai, trừ khi mục v2 ghi khác.

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

- [v2 – Dashboard toàn trường](#v2--dashboard-toàn-trường)
  - [Điểm mới so với v1](#điểm-mới-so-với-v1) · [Phân quyền](#phân-quyền) ·
    [Dữ liệu Firestore v2](#dữ-liệu-firestore-v2) · [Biến môi trường v2](#biến-môi-trường-v2) ·
    [Chia sẻ Google Sheet cho máy chủ](#chia-sẻ-google-sheet-cho-máy-chủ) ·
    [Security Rules v2](#security-rules-v2-bản-dán-vào-firebase-console) · [Apps Script cho từng cấp](#apps-script-cho-từng-cấp) ·
    [Thử nghiệm trên Vercel Preview](#thử-nghiệm-trên-vercel-preview) · [Xem trước cục bộ](#xem-trước-cục-bộ-v2) ·
    [Chuyển sang v2](#chuyển-sang-v2) · [Xử lý sự cố v2](#xử-lý-sự-cố-v2)
- [Kiến trúc](#kiến-trúc)
- [Bảo mật đăng nhập Microsoft 365](#bảo-mật-đăng-nhập-microsoft-365)
- [Dữ liệu trong Firestore](#dữ-liệu-trong-firestore)
- [Cài đặt (làm theo thứ tự)](#cài-đặt-làm-theo-thứ-tự)
- [Quản lý quyền xem](#quản-lý-quyền-xem)
- [Phát triển cục bộ](#phát-triển-cục-bộ)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Bảo trì định kỳ](#bảo-trì-định-kỳ)
- [Chi phí](#chi-phí)

<!-- v2:begin -->
## v2 – Dashboard toàn trường

> [!NOTE]
> **Trạng thái:** nhánh `main` = **v1** (chỉ Tiểu học) đang chạy chính thức. Nhánh **`toan-truong`** = **v2**, chạy thử
> trên **Vercel Preview** cho tới khi BGH duyệt, sau đó làm theo [Chuyển sang v2](#chuyển-sang-v2).
> v2 ghi vào các bộ sưu tập Firestore **mới** (`v2_*`) và không đọc/ghi dữ liệu của v1 (`dashboard/*`,
> `dashboard_chunks/*`, `phieu/*`, `config/*`), nên hai bản chạy song song an toàn trên cùng project Firebase `dugiotih`.
> Các bước cài đặt chung (Microsoft Entra, Firebase Authentication, Firestore, service account, Vercel) ở phần
> [Cài đặt](#cài-đặt-làm-theo-thứ-tự) vẫn giữ nguyên; mục này chỉ mô tả những gì v2 thay đổi hoặc bổ sung.

### Điểm mới so với v1

- **Ba cấp**, mỗi cấp một Google Sheet riêng có cùng cấu trúc (trang **“Câu trả lời biểu mẫu 1”** – cùng 24 tiêu chí
  1.1…5.3 – và trang **“DS Nhân sự”**), mỗi cấp một màu nhận diện:

  | Cấp | Mã | Màu nhận diện |
  |---|---|---|
  | Tiểu học | `tih` | `#ffad00` |
  | THCS | `thcs` | `#2da037` |
  | THPT | `thpt` | `#23328C` |

  Cấp chưa có mã Sheet (hiện là THPT) bị tắt: không đồng bộ, dashboard hiện **“Chưa kết nối dữ liệu”**.
- **Phân quyền theo vai trò** thay cho “ai được vào là xem toàn bộ” của v1: BGH liên cấp, BGH cấp, Tổ trưởng, Giáo viên
  (xem [Phân quyền](#phân-quyền)). Mỗi người chỉ tải về đúng phần dữ liệu mình được xem – việc chặn được thực hiện
  bằng Firestore Security Rules, không chỉ ẩn trên giao diện.
- **Bộ chọn góc nhìn** trên dashboard, dựng từ vai trò của người đăng nhập (ví dụ BGH liên cấp:
  `Toàn trường · Tiểu học · THCS · THPT`; Tổ trưởng: `Tổ Toán – THCS`; mọi giáo viên: `Của tôi`). Dashboard nhớ góc
  nhìn đã chọn lần trước.
  - **Góc nhìn cấp / tổ:** đầy đủ các thẻ của v1 (Tổng quan, Tiêu chí, Giáo viên, Dự giờ & độ phủ, Nhật ký) trên dữ
    liệu của cấp/tổ đó, tô theo màu của cấp.
  - **Toàn trường** (chỉ BGH liên cấp): so sánh ba cấp – chỉ số chính, xu hướng, bản đồ nhiệt tiêu chí × cấp, độ phủ
    dự giờ, hoạt động dự giờ của BGH từng cấp.
  - **Của tôi** (mọi giáo viên): các tiết của mình được dự (điểm, xếp loại, nhận xét đầy đủ), điểm mạnh/yếu theo tiêu
    chí so với **trung bình ẩn danh** của tổ và của cấp, và danh sách **“Phiếu tôi đã dự”**.
- **Đọc Sheet theo tên trang (tab)** thay cho `gid`, và **nhận diện cột theo tiêu đề** (Sheet THCS có các cột
  “Họ và tên giáo viên tổ KHXH dự giờ” / “… dạy thuộc tổ KHXH” nằm sau cột nhận xét – v1 đọc theo vị trí nên không
  dùng được cho THCS).

### Phân quyền

| Vai trò | Xem được | Góc nhìn trên dashboard |
|---|---|---|
| **BGH liên cấp** | toàn bộ dữ liệu của cả 3 cấp + trang so sánh | Toàn trường · Tiểu học · THCS · THPT |
| **BGH cấp** | toàn bộ dữ liệu của cấp mình | tên cấp, vd. `THCS` |
| **Tổ trưởng** | toàn bộ phiếu của tổ mình (trong một cấp) | vd. `Tổ Toán – THCS` |
| **Giáo viên** (mọi nhân sự có email) | các tiết **mình dạy** được dự + các phiếu **mình đi dự**; so sánh với trung bình **ẩn danh** của tổ và của cấp – không bao giờ thấy phiếu của giáo viên khác | `Của tôi` |

Một người có thể giữ nhiều vai trò cùng lúc (vd. Phó hiệu trưởng THCS kiêm Tổ trưởng tổ Toán, có giảng dạy) → được
**hợp** các quyền: `THCS · Tổ Toán – THCS · Của tôi`. Cùng một email xuất hiện trong “DS Nhân sự” của nhiều cấp được
coi là **một người**.

Quyền được máy chủ tính lại **mỗi lượt đồng bộ** từ hai nguồn: suy ra tự động từ “DS Nhân sự” của từng cấp, rồi
bổ sung/sửa bằng trang “Phân quyền” (tùy chọn) và biến môi trường `ADMIN_EMAILS`.

> [!WARNING]
> **Người có quyền chỉnh sửa “DS Nhân sự” của bất kỳ cấp nào, hoặc Sheet “Phân quyền”, quyết định ai xem được dữ liệu
> gì** (ví dụ tự ghi chức danh “Hiệu trưởng” cho mình là thành BGH cấp). Giữ danh sách người được sửa các Sheet này ở
> mức tối thiểu, và kiểm tra lịch sử phiên bản của Sheet khi có nghi ngờ.

#### Vai trò tự động từ “DS Nhân sự”

Máy chủ đọc trang “DS Nhân sự” của từng cấp (các cột *Mã nhân sự, Họ và tên Nhân sự, Cấp, Tổ/Bộ phận, Chức danh,
Email, Thâm niên, Ghi chú…*). So khớp **không phân biệt chữ hoa/thường và dấu tiếng Việt**:

1. Chỉ xét nhân sự **đang làm việc** – dòng có cột *Ghi chú* (hoặc *Thâm niên*, *Trạng thái*, *Tình trạng*) chứa chữ
   “nghỉ” bị bỏ qua.
2. **BGH liên cấp:** *Tổ/Bộ phận* chứa “Ban lãnh đạo”, hoặc *Chức danh* chứa “Tổng hiệu trưởng”.
3. **BGH cấp** (của cấp có Sheet đó): *Tổ/Bộ phận* chứa “Ban giám hiệu”, hoặc *Chức danh* chứa “Hiệu trưởng”
   (gồm cả Phó hiệu trưởng), “BGH”, “Thành viên BGH”, “TV BGH”.
4. **Tổ trưởng:** *Chức danh* chứa “Tổ trưởng” (**không** tính Tổ phó, Phó tổ trưởng, Nhóm trưởng, “Tổ trưởng khối”,
   “Tổ trưởng công đoàn”) → tổ được nêu ngay trong chức danh nếu nhận ra (vd. “TV BGH - Tổ trưởng tổ KHCN THCS” →
   Tổ KHCN), nếu không thì tổ ở cột *Tổ/Bộ phận*.
5. **Giáo viên:** mọi dòng đang làm việc **có email** → được xem dữ liệu của chính mình.

Các quy tắc an toàn đi kèm:

- **Không** cấp vai trò lãnh đạo (BGH, tổ trưởng) cho chức danh **“nguyên …”** (đã thôi giữ chức – vd. “Nguyên Tổ
  trưởng Tổ 3”, “Nguyên Hiệu trưởng”) và chức danh hành chính/phục vụ (văn thư, thư ký, trợ lý, nhân viên, kế toán,
  thủ quỹ, lái xe, bảo vệ, tạp vụ, y tế) – **kể cả khi** dòng đó thuộc bộ phận “Ban giám hiệu”.
- Vai trò lãnh đạo chỉ được tự cấp khi cột *Cấp* của dòng **trống, “Liên cấp” hoặc có đúng cấp của Sheet**. Dòng ghi
  cấp khác (vd. “THPT” trong DS Nhân sự THCS) vẫn được xem dữ liệu của chính mình nhưng **không** tự nhận quyền BGH/tổ
  trưởng của cấp nào (lượt đồng bộ cảnh báo) – nếu cần, thêm dòng trong trang “Phân quyền”.
- **Một email chỉ thuộc về một người.** Email ghi cho hai người khác nhau (khác cả mã lẫn họ tên) → giữ cho người có
  họ tên khớp mẫu email của trường (tên gọi + chữ cái đầu của họ và tên đệm, vd. `nguyettt` ↔ Trịnh Thị Nguyệt;
  không xác định được thì người xuất hiện trước); người còn lại không được gắn email đó, không nhận vai trò nào và phiếu
  của họ không hiển thị cho ai cho tới khi “DS Nhân sự” được sửa (lượt đồng bộ cảnh báo, nêu tên cả hai).

**Tên tổ được chuẩn hóa** để tên trong “DS Nhân sự” khớp với cột “Giáo viên dạy thuộc Tổ” của biểu mẫu: bỏ hậu tố
cấp (“Tiểu học”, “TiH”, “THCS”, “THPT” – vd. “Tổ Toán THCS” → “Tổ Toán”) và gộp tên đồng nghĩa.

| Cấp | Tên tổ hiển thị trên dashboard (dùng đúng các tên này ở cột *Tổ* của trang “Phân quyền”) |
|---|---|
| Tiểu học | Tổ 1 … Tổ 5, Tổ Tiếng Anh (gộp “Ngoại ngữ”, “Toán - Tiếng Anh”, “Tiếng Anh”), Tổ KHCN, Tổ Năng khiếu, Tổ Thể thao, Tổ Bộ môn, Giáo viên thỉnh giảng, Ban Giám Hiệu |
| THCS, THPT | Tổ Toán, Tổ KHCN (gộp “KHTN”), Tổ Ngữ văn, Tổ Ngoại ngữ (gộp “Tiếng Anh/Trung/Nhật…”), Tổ KHXH (gộp “Xã hội”), Tổ Năng khiếu, Tổ Thể thao (gộp “Thể dục”), Tổ Công nghệ, Tổ Bộ môn, Giáo viên thỉnh giảng, Ban Giám Hiệu; tên khác giữ nguyên (đã bỏ hậu tố cấp) |

Muốn biết chính xác tên tổ của một cấp: xem bộ lọc “Tổ” trên dashboard của cấp đó.

#### Trang “Phân quyền” (tùy chọn)

Dùng để **bổ sung** quyền mà “DS Nhân sự” không thể hiện được, hoặc **thu hồi** quyền. Mẫu: [`docs/phan-quyen-mau.csv`](docs/phan-quyen-mau.csv).

| Cột | Giá trị |
|---|---|
| **Email** | địa chỉ email chính của tài khoản Microsoft 365 (không phân biệt hoa/thường) |
| **Vai trò** | một trong: `BGH liên cấp`, `BGH cấp`, `Tổ trưởng`, `Giáo viên`, `Không truy cập` (không phân biệt hoa/thường, có dấu hay không) |
| **Cấp** | `Tiểu học`, `THCS`, `THPT`; nhiều cấp cách nhau bằng dấu phẩy (vd. `Tiểu học, THCS`); `Liên cấp` = cả ba cấp. Bắt buộc với *BGH cấp* và *Tổ trưởng*; bỏ trống với *BGH liên cấp* |
| **Tổ** | tên tổ **như hiển thị trên dashboard** (bảng ở trên), vd. `Tổ 3`, `Tổ Tiếng Anh`, `Tổ Toán`, `Tổ KHXH`; nhiều tổ cách nhau bằng dấu phẩy. Bắt buộc với *Tổ trưởng* |
| **Ghi chú** | tự do (máy chủ không đọc) |

- Các dòng được **cộng dồn** với nhau và với vai trò tự động; một email có thể có nhiều dòng.
- **`Giáo viên`**: cấp phạm vi “Của tôi” cho email **không có** trong “DS Nhân sự” (vd. giáo viên thỉnh giảng). Khi đó
  chỉ ghép được các phiếu do chính email đó gửi (“Phiếu tôi đã dự”); muốn ghép cả các tiết người đó dạy, hãy thêm họ
  vào “DS Nhân sự” kèm **Mã nhân sự** và **Email**.
- **`Không truy cập`** thu hồi **mọi** quyền của email đó – kể cả quyền tự động từ “DS Nhân sự” và `ADMIN_EMAILS` (lượt
  đồng bộ sẽ cảnh báo trường hợp này) – dùng cho người đã nghỉ nhưng chưa được ghi chú “nghỉ”, hoặc tài khoản không
  được phép xem.
- Các cách viết thu hồi khác như “Không được xem”, “Ngừng truy cập”, “Khóa quyền”, “Thu hồi”, “Tạm dừng”, “Chặn”
  cũng được hiểu là `Không truy cập`; “Hiệu phó” được hiểu là `BGH cấp`.
- Dòng có **vai trò không nhận ra** (gõ sai) → **tạm thu hồi mọi quyền** của email đó cho tới khi sửa (an toàn: một
  dòng thu hồi gõ sai chữ không được phép để quyền vẫn còn). Dòng email không hợp lệ hoặc thiếu Cấp/Tổ bị **bỏ qua**.
  Mọi trường hợp đều được liệt kê trong phần cảnh báo
  (`warnings`) của kết quả đồng bộ – xem trong nhật ký Apps Script (`syncNow`), Vercel Logs, hoặc kết quả `curl`.
  Cảnh báo có thể nêu email/họ tên nên `/api/sync` chỉ trả chi tiết cho cron, Apps Script và `ADMIN_EMAILS`; người dùng
  khác bấm đồng bộ chỉ nhận số lượng cảnh báo (`warningCount`).
- `ADMIN_EMAILS` (biến môi trường trên Vercel) = danh sách email được coi là **BGH liên cấp** – dùng cho người quản
  trị (vd. cán bộ CNTT) và để có quyền ngay từ lần đồng bộ đầu tiên.
- Thay đổi có hiệu lực sau **lượt kiểm tra kế tiếp** (≤ 15 phút với Apps Script, hoặc bấm “Làm mới” trên dashboard).
  Khi quyền bị thu hồi, Security Rules từ chối các lượt đọc mới của người đó (dữ liệu đã tải trong tab đang mở chỉ
  mất khi tải lại trang).

**Tạo Sheet “Phân quyền” từ tệp mẫu:**

1. Tải [`docs/phan-quyen-mau.csv`](docs/phan-quyen-mau.csv) về máy (trên GitHub: mở tệp → nút *Download raw file*).
2. Google Drive → **Mới → Google Trang tính** → **Tệp → Nhập → Tải lên** → chọn tệp CSV → *Vị trí nhập*:
   **Thay thế bảng tính** (hoặc *Chèn trang tính mới*), *Loại dấu phân cách*: **Dấu phẩy** → *Nhập dữ liệu*.
   (Nhập thẳng vào Google Trang tính; đừng mở bằng Excel rồi lưu lại – dễ hỏng dấu tiếng Việt.)
3. **Đổi tên trang (tab)** thành đúng `Phân quyền` (hoặc đặt biến `ROLES_TAB` theo tên tab đang dùng).
4. Xóa 5 dòng ví dụ, điền dữ liệu thật. Giữ nguyên dòng tiêu đề.
5. Chia sẻ quyền **Người xem** cho service account rồi đặt **Bị hạn chế** (xem [Chia sẻ Google Sheet cho máy
   chủ](#chia-sẻ-google-sheet-cho-máy-chủ)). Chỉ cho người phụ trách phân quyền quyền chỉnh sửa.
6. Đặt `ROLES_SHEET_ID` = mã của Sheet này trên Vercel (đúng môi trường – Preview khi thử, Production khi chạy thật)
   → **Redeploy** → chạy một lượt đồng bộ.

#### Ghép giáo viên với phiếu (dữ liệu “Của tôi”)

Phiếu được ghép với **người thật** trong “DS Nhân sự” của mọi cấp – **kể cả** người đã nghỉ, dòng không có email và
người bị thu hồi quyền (các dòng cùng email, hoặc cùng mã + họ tên, là một người) – rồi mới chuyển cho **tài khoản được
phép** của người đó. Nhờ vậy phiếu của người không còn quyền **không** rơi sang đồng nghiệp trùng họ tên; phiếu đó chỉ
còn trong dữ liệu cấp/tổ.

**So họ tên** không phân biệt hoa/thường và vị trí đặt dấu (“Hoà” = “Hòa”) nhưng **giữ dấu thanh** (“Thúy” ≠ “Thùy” ≠
“Thủy”). Họ tên gõ không dấu (“Nguyen Thi Hoa”) chỉ khớp khi cách viết đó ứng với **đúng một** họ tên có dấu trong toàn
bộ DS Nhân sự.

- **Tiết mình dạy** (cột “Mã nhân viên của thầy cô dạy” + họ tên giáo viên dạy):
  1. mã **và** họ tên cùng khớp → chắc chắn;
  2. họ tên khớp **đúng một** người thuộc cấp của phiếu (nhân sự ghi cấp “Liên cấp” khớp mọi cấp) → người đó, kể cả
     khi mã gõ sai (họ tên chọn từ danh sách thả xuống của biểu mẫu nên đáng tin hơn);
  3. họ tên không khớp ai trong cấp nhưng mã thuộc **đúng một** người có cùng tên gọi → người đó (họ tên gõ sai). Mã bị
     ghi cho hai người khác nhau → không dùng mã đó;
  4. trùng tên nhiều người hoặc không khớp → **không ghép** (phiếu vẫn có trong dashboard cấp/tổ).
- **Phiếu mình đi dự:** cột “Địa chỉ email” (người gửi phiếu) là căn cứ chính; người được nêu ở ô họ tên người dự chỉ
  được tính thêm khi **cả mã lẫn họ tên** người dự cùng chỉ người đó (vd. thư ký gửi hộ). Phiếu không có email khớp →
  mã/họ tên người dự theo cùng quy tắc trên.
- **Họ tên GV dạy trùng họ tên người dự** (điền nhầm một ô – trên dữ liệu thật có ~40 phiếu): không dùng họ tên đó cho
  cả hai vai trò. Người dự theo email/mã người dự; người dạy theo **mã GV dạy** (mã phải là của chính người mang họ tên
  đó, hoặc của người có tổ trong DS khớp “tổ GV dạy” trên phiếu); không có mã mà người dự là người khác → họ tên đó là
  của GV dạy. Còn lại → không ghép GV dạy. `npm run dry-run` in danh sách các phiếu này để sửa trên Sheet.

Trong dữ liệu cấp/tổ, mỗi phiếu mang **khóa người đã ghép** (`tp`/`op`, không phải email): hai giáo viên **trùng họ
tên** (vd. hai giáo viên trùng họ tên trong cùng một tổ) hiển thị thành hai dòng riêng (kèm mã nhân sự) trên thẻ Giáo viên,
độ phủ tính riêng từng người, và giáo viên có tên trong DS của nhiều cấp chỉ được tính **một lần** ở độ phủ toàn trường.

Tổ của một giáo viên (dùng cho trung bình tổ và danh sách độ phủ) lấy theo **phiếu**: tổ ghi nhiều nhất ở các tiết
người đó dạy; chưa được dự thì theo các phiếu người đó đi dự; chưa có phiếu nào thì theo “DS Nhân sự”.

Để ghép đúng: điền đủ **Mã nhân sự** và **Email** trong “DS Nhân sự”, và bật **“Thu thập địa chỉ email”** trong cài
đặt Google Form.

**Riêng tư:** phạm vi cá nhân chỉ chứa phiếu của chính người đó. Với phiếu mình đi dự, vẫn thấy tên, lớp, bài dạy, điểm
và nhận xét của giáo viên được dự (do chính mình viết), nhưng **email, mã nhân sự và khóa người của người khác bị loại
bỏ**.

**Số liệu đối sánh** (TB tổ / TB cấp trong “Của tôi” và trong góc nhìn tổ) là số tổng hợp ẩn danh, được công bố sao cho
**không ai lấy hiệu hai lần công bố liên tiếp mà suy ra được điểm của một tiết dạy**:

- chỉ tính phiếu của **năm học hiện tại** (từ 01/08) và **gửi trước 00:00 thứ Hai tuần này** (giờ Việt Nam) – phiếu
  của tuần đang diễn ra chưa được tính;
- nhóm đã có số liệu → **giữ nguyên** cho tới khi có thêm **≥ 5 phiếu mới (đã chốt) của ≥ 3 giáo viên khác nhau**; sửa
  hoặc xóa phiếu cũ chỉ thể hiện ở lần công bố sau. Vì vậy số liệu đối sánh đổi **tối đa một lần mỗi tuần**;
- điểm làm tròn **0,1**, tỷ lệ xếp loại làm tròn **5 %**, không công bố số đếm từng loại;
- tổ/cấp có **dưới 3 giáo viên** hoặc **dưới 5 tiết** được dự → không công bố điểm;
- trạng thái công bố lưu ở `v2_config/state.bench` (chỉ máy chủ); `?force=1` **không** bỏ qua quy tắc này.

Dashboard ghi rõ “năm học …, đến hết dd/mm” bên dưới số liệu đối sánh. Giáo viên dạy ở hai cấp có nút chọn cấp để
so sánh: tiết ở cấp nào so với số liệu của cấp đó.

### Dữ liệu Firestore v2

| Đường dẫn | Nội dung | Ai đọc được |
|---|---|---|
| `v2_meta/global` | `version: 2`, `syncedAtMs`, `levels: [{cap, label, color, enabled, count, syncedAtMs, stale}]` (`stale` = lượt này không đọc được Sheet của cấp đó, đang giữ dữ liệu lần trước), `trigger` (`cron`, `webhook`, `user` – **không** ghi email người bấm đồng bộ), `durationMs` | người có tài liệu `v2_access` |
| `v2_access/{email viết thường}` | `email`, `name`, `roles: { bghAll, bghCaps: [cap], toTruong: [{cap, to, label}], person: {key, caps} \| null }`, `scopes: [scopeId]`, `updatedAtMs` | **chỉ chính chủ** |
| `v2_scopes/{scopeId}` | một “phạm vi” dữ liệu, chung: `kind`, `label`, `count`, `chunkIds`, `syncedAtMs`, `hash`. **Cấp** (`kind: 'level'`): `cap`, `color`, `crit` (tiêu chí), `staff` (giáo viên – tính độ phủ; `k` = khóa người), `bgh`, `sheetUrl` (chỉ khi Sheet đã riêng tư). **Tổ** (`'to'`): `cap`, `to`, `color`, `crit`, `staff` (thành viên tổ), `benchmarks` (trung bình **ẩn danh** đã công bố của tổ và cấp). **Cá nhân** (`'person'`): `caps`, `tos`, `crit` (theo từng cấp), `benchmarks`. `benchmarks = { levels: {cấp: B}, tos: {cấp: {tổ: B}} }`, `B = { n, teachers, avg, dom, crit, pct, asOf, sy }` hoặc `{ n, teachers, suppressed: true }` | người có `scopeId` trong `v2_access.scopes` của mình |
| `v2_scopes/{scopeId}/chunks/c000, c001…` | `{ i, n, data, hash }` – `data` là chuỗi JSON các phiếu dạng gọn (mỗi phiếu có `cap`; phiếu trong phạm vi cấp/tổ có `tp`/`op` = khóa người dạy/người dự đã ghép; phiếu trong phạm vi cá nhân có thêm `rel`: `t` tiết mình dạy, `o` phiếu mình dự, `to` cả hai) | như trên |
| `v2_config/state`, `v2_config/lock` | mã băm lần đồng bộ trước, số liệu đối sánh đã công bố (`bench`), người kích hoạt lượt gần nhất (`lastTrigger`), giới hạn tần suất, khóa chống chạy trùng | **chỉ máy chủ** |
| `v2_config/staff_<cấp>`, `v2_config/roles` | bản lưu gần nhất của “DS Nhân sự” từng cấp và của trang “Phân quyền” – dùng khi lượt sau không đọc được Sheet | **chỉ máy chủ** |

Mã phạm vi (`scopeId`): `L_tih`, `L_thcs`, `L_thpt` (cả cấp) · `T_<cấp>_<tổ>` (một tổ) · `P_<mã>` (một người; mã là
giá trị băm của email, không đọc ra được email). Ai được phạm vi nào:

```
BGH liên cấp → mọi L_* của cấp đang bật      BGH cấp → L_<cấp>
Tổ trưởng    → T_<cấp>_<tổ>                  Mỗi nhân sự ghép được với phiếu → P_<mã của mình>
```

Tổ trưởng đồng thời là BGH của chính cấp đó không nhận thêm `T_…` (đã nằm trong `L_<cấp>`). Dashboard chỉ tải các
phạm vi **rộng nhất** của người dùng rồi lọc tiếp ở trình duyệt.

Mỗi lượt đồng bộ (đọc song song mọi Sheet) chỉ ghi tài liệu thay đổi (so mã băm từng phạm vi, từng khối, từng tài
liệu quyền), xóa phạm vi/tài liệu quyền không còn, mỗi lô ≤ 400 thao tác **và ≤ 6 MiB** (Firestore từ chối yêu cầu
ghi lớn hơn 10 MiB; phạm vi quá lớn được ghi các khối ở lô trước, tài liệu phạm vi ở lô sau cùng); quyền bị thu hẹp được ghi **trước** dữ liệu,
quyền mở rộng ghi **sau** khi phạm vi mới đã có. Khóa và giới hạn tần suất giống v1 (lưu ở `v2_config`). Các chốt an
toàn:

- Sheet của một cấp lỗi (mạng, quyền, sai tên tab) hoặc bỗng trả về 0 phiếu trong khi lần trước có phiếu → **giữ dữ
  liệu cũ** của cấp đó (`stale`) và cảnh báo; mọi cấp đều lỗi → dừng, không ghi gì.
- “DS Nhân sự” / trang “Phân quyền” không đọc được → dùng bản lưu gần nhất (`v2_config/staff_<cấp>`, `v2_config/roles`);
  trang “Phân quyền” chưa từng đọc được lần nào → **dừng** để không cấp nhầm quyền đã bị thu hồi.
- Lượt đồng bộ tính ra 0 tài khoản có quyền trong khi trước đó có → dừng, tránh thu hồi nhầm hàng loạt.
- `?force=1` (chỉ với `CRON_SECRET`) bỏ qua mã băm, giới hạn tần suất và hai chốt “0 phiếu” / “0 tài khoản” (ghi lại
  toàn bộ ≈ 1.200 tài liệu với dữ liệu 10/2026 – chỉ dùng khi thật cần; quy tắc công bố số liệu đối sánh vẫn giữ nguyên).

Chi phí đọc: mở dashboard ≈ 1 (`v2_access`) + 1 (`v2_meta/global`) + số phạm vi + số khối dữ liệu, cộng 1 lượt đọc
`v2_access` mỗi lần Security Rules kiểm tra một phạm vi – vẫn rất nhỏ so với hạn mức miễn phí 50.000 lượt đọc/ngày.

### Biến môi trường v2

Đặt ở Vercel → Project → **Settings → Environment Variables**. Mỗi biến có ô chọn môi trường: khi **thử trên
Preview** phải tích **Preview**; khi [chuyển sang v2](#chuyển-sang-v2) phải tích **Production**. Bản v1 đang chạy
trên Production bỏ qua các biến chỉ dành cho v2, nên tích cả hai môi trường ngay từ đầu cũng an toàn. Mẫu đầy đủ:
[`.env.example`](.env.example).

| Biến | Bắt buộc | Mục đích |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` (hoặc 3 biến `FIREBASE_*`) | ✔ | như v1; dùng chung cho cả hai phiên bản |
| `SHEET_ID_TIH` | ✔ (hoặc `SHEET_ID`) | mã Sheet Tiểu học. Để trống → dùng `SHEET_ID` của v1 |
| `SHEET_ID_THCS` | ✔ | mã Sheet THCS |
| `SHEET_ID_THPT` | – | mã Sheet THPT. **Để trống = cấp THPT tắt** (“Chưa kết nối dữ liệu”) |
| `SHEET_FORM_TAB_TIH`, `SHEET_FORM_TAB_THCS`, `SHEET_FORM_TAB_THPT` | – | tên trang câu trả lời nếu khác `Câu trả lời biểu mẫu 1` |
| `SHEET_STAFF_TAB_TIH`, `SHEET_STAFF_TAB_THCS`, `SHEET_STAFF_TAB_THPT` | – | tên trang nhân sự nếu khác `DS Nhân sự`; `none` = không đọc (cấp đó chỉ có quyền từ trang “Phân quyền” / `ADMIN_EMAILS`) |
| `ROLES_SHEET_ID` | – | mã Sheet “Phân quyền”. Để trống = chỉ dùng phân quyền tự động |
| `ROLES_TAB` | – | tên trang trong Sheet phân quyền (mặc định `Phân quyền`) |
| `ADMIN_EMAILS` | – | email được coi là BGH liên cấp, cách nhau bằng dấu phẩy |
| `ALLOWED_DOMAINS` | – | tên miền được **bấm đồng bộ** từ dashboard (mặc định `hoangmaistarschool.edu.vn`; `none` = tắt). **Không** quyết định ai xem được dữ liệu. Người có email trong `ADMIN_EMAILS` hoặc đã có tài liệu `v2_access` cũng bấm được. Tài khoản cùng tên miền nhưng **chưa có** `v2_access` (vd. học sinh) chỉ nhận kết quả tối thiểu `{ ok, skipped, syncedAtMs }` – không có số phiếu, số tài khoản hay cảnh báo |
| `SYNC_SECRET` | ✔ cho Apps Script | như v1 – **cùng một giá trị** cho Apps Script của mọi Sheet |
| `CRON_SECRET` | ✔ cho Cron | như v1 (Vercel Cron chỉ chạy trên Production) |

Biến chỉ v1 dùng: `SHEET_GID_FORM`, `SHEET_GID_STAFF`, `ALLOWED_EMAILS`, `ACCESS_FROM_SHEET` – giữ nguyên cho tới khi
chuyển hẳn sang v2.

### Chia sẻ Google Sheet cho máy chủ

Máy chủ đọc **mọi** Sheet (Tiểu học, THCS, THPT, “Phân quyền”) bằng **service account** của Firebase, nên chỉ cần
chia sẻ quyền **Người xem** cho đúng một tài khoản: **`client_email` của service account** (dạng
`dashboard-sync@dugiotih.iam.gserviceaccount.com` nếu tạo theo [bước 2](#2-firebase-console-httpsconsolefirebasegooglecom--project-dugiotih)).
Cách tìm địa chỉ này: Google Cloud console (project `dugiotih`) → **IAM & Admin → Service Accounts** → cột *Email*;
hoặc mở tệp JSON khóa → giá trị `"client_email"`. **Chỉ chia sẻ địa chỉ email, không gửi tệp JSON khóa** cho ai.

> [!IMPORTANT]
> **Bật Google Sheets API (bắt buộc, làm một lần):** mở
> https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=dugiotih → **Enable** (Bật).
> Máy chủ đọc Sheet bằng **Google Sheets API** nên luôn lấy **đủ mọi dòng**, kể cả khi ai đó đang bật **bộ lọc** trên
> Sheet. Nếu API chưa bật, máy chủ tạm đọc qua gviz – cách này **chỉ thấy các dòng đang hiển thị** (Sheet đang lọc
> 28/647 dòng thì chỉ đồng bộ được 28) – và mỗi lượt đồng bộ sẽ kèm cảnh báo nhắc bật API. Ngoài ra, nếu số phiếu của
> một cấp đột ngột giảm quá nửa so với lần trước, máy chủ **giữ nguyên dữ liệu cũ** và cảnh báo (thường do Sheet đang
> lọc hoặc bị xóa nhầm); muốn chấp nhận con số mới thì đồng bộ bằng `CRON_SECRET` kèm `?force=1`.

Với **từng** Sheet, làm theo đúng thứ tự (chia sẻ trước rồi mới khóa, để bản v1 đang đọc Sheet Tiểu học không bị
gián đoạn):

1. Mở Sheet → **Chia sẻ** → thêm `client_email`, quyền **Người xem**, bỏ chọn *Thông báo cho mọi người* → **Gửi**.
2. **Chia sẻ → Quyền truy cập chung → Bị hạn chế** → *Xong*. Từ lúc này ai có link mà không được chia sẻ riêng sẽ
   không mở được Sheet; máy chủ vẫn đọc bằng service account.
3. Chạy ngay một lượt đồng bộ (bấm đồng bộ trên dashboard, `syncNow` trong Apps Script, hoặc `curl` – xem
   [Thử nghiệm trên Vercel Preview](#thử-nghiệm-trên-vercel-preview)) và kiểm tra thành công. Nếu báo không đọc được
   Sheet: kiểm tra lại địa chỉ đã chia sẻ ở bước 1 (phải đúng `client_email` của service account đang đặt trên Vercel).

> [!IMPORTANT]
> Sheet còn ở chế độ **“Bất kỳ ai có đường liên kết”** thì ai có link đọc được toàn bộ phiếu và “DS Nhân sự” (kể cả
> email) mà không cần đăng nhập – vượt qua mọi phân quyền của dashboard. **Bắt buộc** đặt **Bị hạn chế** cho mọi
> Sheet trước khi đưa v2 cho giáo viên dùng. Nếu Google Workspace của trường chặn chia sẻ ra ngoài miền, nhờ
> quản trị Workspace cho phép chia sẻ với `…@dugiotih.iam.gserviceaccount.com`.

### Security Rules v2 (bản dán vào Firebase console)

`firestore.rules` chỉ còn quy tắc của **v2** (các bộ sưu tập `v2_*`), có chú thích tiếng Việt cho từng quy tắc. Dữ liệu
v1 cũ (`dashboard/*`, `dashboard_chunks/*`, `phieu/*`, `config/*`) **không còn ai đọc được** – v1 cho mọi tài khoản của
trường xem toàn bộ phiếu Tiểu học, giữ lại sẽ vượt qua phân quyền v2. **Chỉ dán khối này SAU khi bản v2 đã lên
Production** (bản v1 cần quy tắc cũ để chạy). Cách triển khai: `npx firebase-tools deploy
--only firestore:rules,firestore:indexes` (xem [bước 4](#4-triển-khai-security-rules-và-chỉ-mục)), hoặc Firebase console
→ **Firestore Database → Rules** → xóa toàn bộ nội dung cũ → dán khối dưới đây → **Publish**. Khối này giống hệt
`firestore.rules` nhưng đã bỏ chú thích; khi sửa rules, sửa `firestore.rules` trước rồi cập nhật lại khối này.

<!-- BEGIN RULES (sinh từ firestore.rules, đã bỏ chú thích) -->
```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    function isMicrosoftUserWithEmail() {
      return request.auth != null
        && request.auth.token.get('firebase', {}).get('sign_in_provider', '') == 'microsoft.com'
        && request.auth.token.get('email', '') is string
        && request.auth.token.get('email', '').size() > 0;
    }

    function myEmail() {
      return request.auth.token.email.lower();
    }

    function isV2User() {
      return isMicrosoftUserWithEmail() && myEmail().matches('[^/@]+@[^/@]+');
    }

    function myAccessPath() {
      return /databases/$(database)/documents/v2_access/$(myEmail());
    }

    function hasV2Access() {
      return isV2User() && exists(myAccessPath());
    }

    function canReadScope(scopeId) {
      return hasV2Access()
        && get(myAccessPath()).data.get('scopes', []) is list
        && scopeId in get(myAccessPath()).data.get('scopes', []);
    }

    match /v2_access/{email} {
      allow get: if isV2User() && email == myEmail();
      allow list, write: if false;
    }

    match /v2_meta/{docId} {
      allow get: if docId == 'global' && hasV2Access();
      allow list, write: if false;
    }

    match /v2_scopes/{scopeId} {
      allow get: if canReadScope(scopeId);
      allow list, write: if false;

      match /chunks/{chunkId} {
        allow read: if canReadScope(scopeId);
        allow write: if false;
      }
    }

    match /v2_config/{docId} {
      allow read, write: if false;
    }

    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```
<!-- END RULES -->

Chỉ mục (tùy chọn, để tiết kiệm dung lượng): `firestore.indexes.json` tắt đánh chỉ mục trường `data` của các khối dữ
liệu (`dashboard_chunks`, `chunks`) và các trường lớn `crit`, `staff`, `benchmarks` của `v2_scopes`. Làm tay: Firestore
→ **Indexes → Single field → Add exemption**, mỗi dòng một collection/field như trên, bỏ chọn mọi kiểu chỉ mục.

Có thể thử bằng **Rules Playground** (Firestore → Rules): lượt *get* `v2_access/<email>` với người dùng đăng nhập
bằng `microsoft.com` có đúng email đó → *Allowed*; email khác → *Denied*. Cách chắc chắn nhất vẫn là đăng nhập thật
bằng vài tài khoản có vai trò khác nhau.

### Apps Script cho từng cấp

Cùng một `apps-script/Code.gs` + `apps-script/appsscript.json` cài **riêng trên từng Sheet** có biểu mẫu (Tiểu học,
THCS, và THPT khi có). Mỗi lượt gọi `/api/sync` đồng bộ **tất cả** các cấp, nên một phiếu gửi vào Sheet THCS cũng làm
mới dữ liệu toàn trường.

Với **mỗi** Sheet:

- [ ] Mở Sheet → **Tiện ích mở rộng → Apps Script**. Sheet Tiểu học đã có script của v1: dán đè `Code.gs` bản mới
      (tương thích cả máy chủ v1 lẫn v2).
- [ ] Dán `apps-script/Code.gs` vào tệp `Code.gs`; ⚙ **Cài đặt dự án** → bật *Hiển thị tệp kê khai
      “appsscript.json”* → dán `apps-script/appsscript.json`.
- [ ] ⚙ Cài đặt dự án → **Thuộc tính tập lệnh**:
  - `SYNC_URL` = `https://<tên-miền>/api/sync` (tên miền Production; khi thử v2 xem mục dưới);
  - `SYNC_SECRET` = giống hệt biến `SYNC_SECRET` trên Vercel (**cùng một giá trị cho mọi Sheet**);
  - *(tùy chọn)* `SCHEDULE_MINUTES` = `1`, `5`, `10`, `15` (mặc định) hoặc `30`; `0` = không cài trigger định kỳ trên
    Sheet này (chỉ đồng bộ khi có phiếu mới).
- [ ] Chạy **`installTriggers`** → cấp quyền (trigger “Khi gửi biểu mẫu” + trigger định kỳ).
- [ ] Chạy **`syncNow`** → xem *Nhật ký thực thi*: mỗi dòng ghi kèm tên Sheet và tóm tắt kết quả đồng bộ.
      **`setup`** in hướng dẫn và trạng thái; **`removeTriggers`** tạm dừng đồng bộ tự động của Sheet đó.

Vì mỗi lượt đã kiểm tra cả trường, nên giữ trigger định kỳ trên **một** Sheet và đặt `SCHEDULE_MINUTES=0` trên các
Sheet còn lại (trigger “Khi gửi biểu mẫu” vẫn chạy ở mọi Sheet). Để mặc định 15 phút ở cả ba Sheet cũng không tốn
Firestore: lượt định kỳ khi Sheet **không đổi** chỉ đọc 2 tài liệu và **không ghi gì** (xem *Chi phí*); chỉ tốn thêm
lượt gọi Vercel và Google Sheets API.

### Thử nghiệm trên Vercel Preview

Mỗi lần đẩy nhánh `toan-truong` lên GitHub, Vercel tự tạo một bản **Preview** (không ảnh hưởng Production). Bản
Preview dùng **chung** Firebase project và ghi vào `v2_*`.

1. **Đẩy nhánh:** `git push -u origin toan-truong`. Vercel → Project → **Deployments** → bản mới nhất của nhánh
   `toan-truong` → mục *Domains* có **địa chỉ cố định của nhánh** dạng
   `dugiotih-pq6b-git-toan-truong-<tên-scope>.vercel.app` (không đổi giữa các lần đẩy). Luôn thử qua địa chỉ này,
   không dùng địa chỉ riêng của từng bản build (đổi mỗi lần đẩy).
2. **Biến môi trường:** Settings → Environment Variables → với mọi biến v2 **và** các biến dùng chung
   (`FIREBASE_SERVICE_ACCOUNT`, `SYNC_SECRET`, `CRON_SECRET`, `ALLOWED_DOMAINS`) → *Edit* → tích **Preview** (có thể
   giới hạn riêng nhánh `toan-truong`) → *Save*. Sau đó Deployments → bản Preview → ⋯ → **Redeploy**. Thiếu
   `FIREBASE_SERVICE_ACCOUNT` ở Preview thì `/api/sync` trả 500 kèm danh sách *tên* biến đang thấy – dùng để đối chiếu.
3. **Firebase → Authentication → Settings → Authorized domains → Add domain:** địa chỉ nhánh ở bước 1 (không có
   `https://`). Thiếu bước này → `auth/unauthorized-domain` khi đăng nhập.
4. **Security Rules:** dán khối [Security Rules v2](#security-rules-v2-bản-dán-vào-firebase-console) → *Publish*.
5. **Vercel Deployment Protection:** mặc định Vercel bắt đăng nhập **tài khoản Vercel** (thành viên của project) mới
   mở được link Preview (trang “Authentication Required”), và chặn cả lời gọi `/api/sync` từ Apps Script/`curl`. Chọn
   một cách:
   - cho người thử (BGH): mở **địa chỉ cố định của nhánh** ở bước 1 (`…-git-toan-truong-…vercel.app`, **không** phải
     địa chỉ riêng của bản build) → thanh công cụ Vercel → **Share** → tạo *shareable link* từ chính trang đó. Kiểm
     tra tên miền trong link là địa chỉ nhánh (đã thêm vào *Authorized domains* ở bước 3) trước khi gửi BGH – link tạo
     cho địa chỉ riêng của bản build sẽ báo `auth/unauthorized-domain` khi đăng nhập và hết hiệu lực sau lần đẩy kế tiếp;
   - hoặc Settings → **Deployment Protection** → tắt *Vercel Authentication* cho Preview (dashboard vẫn bắt đăng nhập
     Microsoft 365 và dữ liệu vẫn được Security Rules bảo vệ; chỉ trang tĩnh là ai cũng tải được);
   - cho Apps Script/`curl`: Settings → Deployment Protection → **Protection Bypass for Automation** → tạo mã, rồi gửi
     kèm header `x-vercel-protection-bypass: <mã>` hoặc thêm `?x-vercel-protection-bypass=<mã>` vào cuối URL.
     Mã này là bí mật – không commit.
6. **Đồng bộ lần đầu** (Vercel Cron **không** chạy trên Preview), một trong các cách:
   - đăng nhập bản Preview bằng tài khoản có email trong `ADMIN_EMAILS` (hoặc thuộc `ALLOWED_DOMAINS`) → màn hình
     “Tài khoản chưa được cấp quyền / chưa có dữ liệu” → **Đồng bộ ngay**;
   - `curl`:
     ```bash
     curl -X POST -H "Authorization: Bearer <CRON_SECRET>" -H "x-vercel-protection-bypass: <mã bypass>" \
       https://dugiotih-pq6b-git-toan-truong-<tên-scope>.vercel.app/api/sync
     ```
   - *(tùy chọn, để dữ liệu Preview tự cập nhật)* trên Sheet **THCS** (v1 không dùng Sheet này) cài Apps Script với
     `SYNC_URL = https://<địa chỉ nhánh>/api/sync?x-vercel-protection-bypass=<mã bypass>`. Sheet Tiểu học **giữ**
     `SYNC_URL` trỏ về Production để v1 vẫn được đồng bộ. Nhớ đổi lại khi chuyển sang v2.
7. **Thử từng vai trò:** đăng nhập lần lượt bằng tài khoản BGH liên cấp, BGH cấp, Tổ trưởng, giáo viên; kiểm tra bộ
   chọn góc nhìn và dữ liệu đúng phạm vi. Muốn xem nhanh mọi vai trò không cần nhiều tài khoản: dùng
   [xem trước cục bộ](#xem-trước-cục-bộ-v2).

### Xem trước cục bộ (v2)

```bash
cp .env.example .env              # điền SHEET_ID_TIH, SHEET_ID_THCS (+ ROLES_SHEET_ID, FIREBASE_SERVICE_ACCOUNT khi Sheet đã riêng tư)
npm run dry-run                   # đọc các Sheet, KHÔNG ghi Firestore → tạo dev-data-v2.json
# hoặc: npm run dry-run -- --tih <mã> --thcs <mã> [--thpt <mã>] [--roles <mã>] [--admin <email>] [--out tệp.json] [--no-write]
# hoặc: npm run dry-run -- --tables <bảng.json>   (bảng gviz đã lưu: { tih: {form, staff}, thcs: {…}, roles? } – khi máy
#        không có service account mà Sheet đã riêng tư; tệp chứa dữ liệu thật, để NGOÀI thư mục dự án)
python3 -m http.server 8080 --bind 127.0.0.1
# mở http://127.0.0.1:8080/?local&as=admin    (hoặc as=bgh_tih, bgh_thcs, to_tih, to_thcs, gv_tih, gv_thcs)
npm test                          # kiểm thử offline (scripts/*.test.mjs)
```

- `npm run dry-run` chạy toàn bộ logic đồng bộ v2 trên kho dữ liệu trong bộ nhớ và in: số phiếu từng cấp, danh sách tổ
  đã chuẩn hóa (số phiếu theo biểu mẫu và số nhân sự theo “DS Nhân sự” – để phát hiện tổ lệch tên), vai trò (BGH liên
  cấp, BGH cấp, tổ trưởng), tỉ lệ ghép phiếu ↔ nhân sự, **danh sách phiếu cần sửa trên Sheet** (họ tên GV dạy trùng
  họ tên người dự), kích thước các phạm vi, lô ghi lớn nhất và cảnh báo. Không ghi gì lên Firestore.
  `ADMIN_EMAILS` trống → bí danh `admin` dùng một email giả.
- `?local` chỉ có tác dụng trên `localhost`/`127.0.0.1`: đọc `./dev-data-v2.json` và **bỏ qua đăng nhập**;
  `?as=<bí danh>` chọn danh tính – bí danh là các khóa trong `users` của tệp
  (`{ meta, users: { <bí danh>: { email, access } }, scopes: { <scopeId>: { doc, chunks } } }`); dry-run chọn người
  thật có phiếu cho từng bí danh.
- `dev-data-v2.json` chứa dữ liệu thật (phiếu, email, mã nhân sự) – đã nằm trong `.gitignore` và `.vercelignore`.
  Cảnh báo về `python3 -m http.server` ở [Phát triển cục bộ](#phát-triển-cục-bộ) vẫn áp dụng (luôn `--bind 127.0.0.1`).

### Chuyển sang v2

Khi BGH đã duyệt bản Preview:

- [ ] **Biến môi trường:** tích **Production** cho mọi biến v2 (`SHEET_ID_TIH`, `SHEET_ID_THCS`, `SHEET_ID_THPT`,
      `ROLES_SHEET_ID`, `ADMIN_EMAILS`…). Kiểm tra `FIREBASE_SERVICE_ACCOUNT`, `SYNC_SECRET`, `CRON_SECRET` đã có ở
      Production (đã có từ v1).
- [ ] **Security Rules:** bản v1+v2 đã được *Publish* (bước 4 của mục thử nghiệm). Nếu chưa, dán ngay **trước** khi
      merge – thiếu rules v2, mọi người dùng v2 bị `permission-denied`.
- [ ] **Sheet riêng tư:** mọi Sheet (Tiểu học, THCS, THPT, “Phân quyền”) đã chia sẻ cho service account và đặt
      **Bị hạn chế** ([hướng dẫn](#chia-sẻ-google-sheet-cho-máy-chủ)).
- [ ] **Merge:** GitHub → *Pull requests* → *New* → base `main` ← compare `toan-truong` → *Merge* (hoặc
      `git checkout main && git merge toan-truong && git push`). Vercel tự build và đưa lên Production.
- [ ] **Firebase Authentication → Settings → User actions:** **Email enumeration protection** đang **bật** (xem
      [Bảo mật đăng nhập Microsoft 365](#bảo-mật-đăng-nhập-microsoft-365)).
- [ ] **Đồng bộ:** `curl -H "Authorization: Bearer <CRON_SECRET>" 'https://<tên-miền-production>/api/sync'`
      (**không** cần `?force=1`: bản Preview đã ghi `v2_*` trên cùng database, lượt thường chỉ ghi phần thay đổi)
      → kiểm tra `v2_meta/global`, `v2_access`, `v2_scopes` trong Firebase console.
- [ ] **Apps Script:** dán `Code.gs` mới lên **mọi** Sheet cấp; đặt `SYNC_URL` của mọi Sheet về tên miền
      **Production** (bỏ tham số bypass nếu đã dùng khi thử); chạy `installTriggers` rồi `syncNow` trên từng Sheet.
- [ ] **Kiểm tra từng vai trò** trên tên miền Production; báo giáo viên rằng mỗi người chỉ thấy dữ liệu của mình.
- [ ] **Quay lui nếu cần:** Vercel → Deployments → bản Production cũ (v1) → ⋯ → **Promote to Production** /
      *Instant Rollback*. Dữ liệu v1 vẫn còn nguyên nên v1 chạy lại ngay.
- [ ] **Sau 1–2 tuần ổn định – dọn v1:**
  - Firebase console → Firestore → xóa các bộ sưu tập `dashboard`, `dashboard_chunks`, `phieu`, `config`
    (⋮ → *Delete collection*). **Không hoàn tác được**; sau bước này không quay lui về v1 được nữa.
  - Có thể bỏ phần v1 trong `firestore.rules` và trong khối dán ở trên.
  - Xóa các biến chỉ v1 dùng: `SHEET_GID_FORM`, `SHEET_GID_STAFF`, `ALLOWED_EMAILS`, `ACCESS_FROM_SHEET`
    (giữ `SHEET_ID` nếu chưa đặt `SHEET_ID_TIH`).
  - Xóa địa chỉ Preview khỏi *Authorized domains* của Firebase nếu không còn dùng.

### Xử lý sự cố (v2)

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| “Tài khoản chưa được cấp quyền / chưa có dữ liệu” | Chưa đồng bộ lần nào; email không có trong “DS Nhân sự” (hoặc có ghi chú “nghỉ”) và không có trong trang “Phân quyền”/`ADMIN_EMAILS`; email trong Sheet khác email đăng nhập Microsoft 365; bị đặt “Không truy cập” | Đồng bộ; kiểm tra cột Email của “DS Nhân sự”; thêm dòng vào trang “Phân quyền” rồi đồng bộ lại |
| Thiếu góc nhìn tổ / cấp mong đợi | Chức danh trong “DS Nhân sự” không khớp quy tắc tự động; tên tổ ở trang “Phân quyền” không đúng tên hiển thị | Thêm/sửa dòng ở trang “Phân quyền” (tên tổ đúng như bộ lọc “Tổ” của dashboard) |
| “Của tôi” trống hoặc thiếu tiết | Mã nhân sự / họ tên trong phiếu khác “DS Nhân sự”; biểu mẫu không thu thập email người gửi | Sửa Mã nhân sự, họ tên cho thống nhất; bật “Thu thập địa chỉ email” trong Google Form |
| Một cấp hiện “Chưa kết nối dữ liệu” | Biến `SHEET_ID_<CẤP>` trống ở môi trường đang chạy (Preview/Production) | Đặt biến, tích đúng môi trường, *Redeploy*, đồng bộ |
| Đồng bộ báo không đọc được Sheet / trang | Sheet chưa chia sẻ cho service account; tên tab khác mặc định | Chia sẻ Người xem cho `client_email`; đặt `SHEET_FORM_TAB_<CẤP>` / `SHEET_STAFF_TAB_<CẤP>` / `ROLES_TAB` đúng tên tab |
| Đồng bộ dừng: “Không đọc được tab Phân quyền … chưa có bản lưu trước” | Đã đặt `ROLES_SHEET_ID` nhưng Sheet chưa chia sẻ cho service account, hoặc tab không tên `Phân quyền` | Chia sẻ Sheet; đổi tên tab hoặc đặt `ROLES_TAB`; hoặc tạm xóa `ROLES_SHEET_ID` |
| Đồng bộ dừng: “Không tính được quyền cho ai …” | Mọi “DS Nhân sự” cùng lỗi/trống trong khi trước đó đã có người được cấp quyền | Kiểm tra các tab “DS Nhân sự”; nếu thật sự muốn thu hồi hết, chạy `curl` với `CRON_SECRET` và `?force=1` |
| Cảnh báo “Email … được ghi cho 2 người khác nhau” | Cột Email của “DS Nhân sự” chép nhầm email của người khác | Sửa email của dòng sai; người đó có quyền ở lượt đồng bộ kế tiếp |
| Cảnh báo “… ghi Cấp “THPT” – không tự cấp vai trò lãnh đạo” | Dòng BGH/tổ trưởng trong DS Nhân sự của cấp này ghi cấp khác | Sửa cột Cấp, hoặc thêm dòng vai trò trong trang “Phân quyền” |
| Số liệu đối sánh (TB tổ/cấp) trong “Của tôi” chưa đổi dù có phiếu mới | Đúng thiết kế: chỉ tính các tuần đã kết thúc và chỉ công bố lại khi có ≥ 5 phiếu mới của ≥ 3 GV | Chờ sang tuần sau |
| Số phiếu ít hơn trên Sheet; bỏ bộ lọc trên Sheet thì số phiếu tăng | Google Sheets API chưa bật → máy chủ đọc qua gviz, chỉ thấy các dòng đang hiển thị | Bật Google Sheets API cho project `dugiotih` ([mục Chia sẻ Google Sheet](#chia-sẻ-google-sheet-cho-máy-chủ)), rồi đồng bộ lại |
| Cảnh báo “số phiếu giảm bất thường từ … xuống …” | Sheet đang bật bộ lọc (khi API chưa bật) hoặc nhiều dòng bị xóa | Bật Google Sheets API / bỏ lọc rồi đồng bộ lại; nếu thật sự đã xóa, đồng bộ bằng `CRON_SECRET` kèm `?force=1` |
| Một cấp ghi “giữ dữ liệu cũ” (`stale`) trong cảnh báo | Lượt này không đọc được phiếu của cấp đó, hoặc Sheet bỗng trả 0 phiếu | Xem nội dung cảnh báo; sửa quyền chia sẻ / tên tab; nếu Sheet thật sự đã được làm trống, chạy `?force=1` |
| Bấm “Đồng bộ ngay” bị 403 “chưa được cấp quyền xem dashboard nên không thể yêu cầu đồng bộ” | Email không thuộc `ALLOWED_DOMAINS` (vd. đặt `none`), không có trong `ADMIN_EMAILS` và chưa có quyền xem | Thêm email vào `ADMIN_EMAILS` hoặc chờ lượt đồng bộ của Apps Script |
| `permission-denied` trên bản v2 | Chưa dán Security Rules v2 | Dán khối [Security Rules v2](#security-rules-v2-bản-dán-vào-firebase-console) → *Publish* |
| `auth/unauthorized-domain` trên Preview | Địa chỉ nhánh chưa có trong *Authorized domains* | Thêm địa chỉ nhánh (bước 3 của mục thử nghiệm) |
| Trang “Authentication Required” của Vercel; Apps Script báo 401 kèm HTML | Vercel Deployment Protection chặn link Preview | Dùng *shareable link* (tạo từ địa chỉ nhánh) / tắt Vercel Authentication cho Preview / dùng mã *Protection Bypass for Automation* (bước 5) |

<!-- v2:end -->

## Kiến trúc

```
Google Form ─► Google Sheet (dữ liệu gốc: trang “Câu trả lời biểu mẫu” + trang “DS Nhân sự”)
                   │
                   │  Ba nguồn kích hoạt đồng bộ:
                   │   ① Apps Script gắn với Sheet: ngay khi có phiếu mới + kiểm tra định kỳ 15 phút/lần (Bearer SYNC_SECRET)
                   │   ② Vercel Cron: mỗi ngày ~06:00 giờ VN (vercel.json), luôn chạy đầy đủ    (Bearer CRON_SECRET)
                   │   ③ Dashboard: nút “Làm mới” (không còn “Tự đồng bộ” từ trình duyệt)      (Bearer Firebase ID token)
                   ▼
        /api/sync  (Vercel Function, Node.js)
        đọc Sheet (Sheets API) → dấu vân tay trùng lượt trước? → BỎ QUA (2 lượt đọc, 0 ghi)
                                                  khác → so sánh mã băm → CHỈ ghi phần thay đổi
                   ▼
        Cloud Firestore (project dugiotih)
                   ▼  onSnapshot (realtime), kiểm tra quyền bằng Security Rules
        index.html  –  đăng nhập Microsoft 365 (Firebase Auth, nhà cung cấp microsoft.com)
```

v2 khác ở chỗ: mỗi cấp một Google Sheet (cộng Sheet “Phân quyền” tùy chọn); mỗi lượt `/api/sync` đọc **mọi** Sheet,
tính quyền và ghi các phạm vi dữ liệu vào `v2_*`; dashboard đọc `v2_access/<email>` rồi chỉ các phạm vi được phép.
Mã máy chủ v2: `server/sync.js` (lõi đồng bộ), `server/roles.js` (phân quyền), `server/scopes.js` (ghép phiếu ↔ người,
dựng phạm vi).

| Thành phần | Tệp |
|---|---|
| Dashboard (trang tĩnh, không cần build) | `index.html` |
| Logic dùng chung máy chủ/trình duyệt (đọc bảng gviz, chuẩn hóa, chia khối, dựng lại bản ghi) | `lib/shared.js` |
| API đồng bộ | `api/sync.js` và thư mục `server/` |
| Script gắn vào Google Sheet (cài trên Sheet của từng cấp) | `apps-script/Code.gs`, `apps-script/appsscript.json` |
| Mẫu trang “Phân quyền” (v2) | `docs/phan-quyen-mau.csv` |
| Security Rules & chỉ mục Firestore | `firestore.rules`, `firestore.indexes.json`, `firebase.json`, `.firebaserc` |
| Cấu hình Vercel (Cron, thời gian chạy hàm, header) | `vercel.json` |
| Chạy thử đồng bộ không ghi Firestore, kiểm thử offline | `scripts/dry-run.mjs`, `scripts/sync.test.mjs` |
| Mẫu biến môi trường | `.env.example` |
| Tệp không được tải lên khi deploy bằng Vercel CLI / không được commit | `.vercelignore`, `.gitignore` |

`dashboard-du-gio.html` (bản dashboard cũ dạng một tệp), `dev-data.json` và `dev-data-v2.json` (dữ liệu xem trước
của v1/v2) chứa thông tin không được công khai nên đã nằm trong `.gitignore`.

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
| `/api/sync` (nút “Làm mới”, “Thử đồng bộ lần đầu”) | xác minh Firebase ID token bằng Admin SDK, yêu cầu `sign_in_provider = microsoft.com` và email; được phép nếu email/tên miền có trong `config/access` hoặc trong biến môi trường (`ALLOWED_EMAILS`, `ALLOWED_DOMAINS`) – nhờ đó có thể đồng bộ ngay cả trước lần đồng bộ đầu tiên. |

Ở cả hai nơi, email phải có **đúng một** dấu `@` và được so khớp chính xác (không nhận tên miền con hay tên miền
giả dạng như `…@hoangmaistarschool.edu.vn.evil.com`).

**Lớp bảo vệ duy nhất chống nOAuth là thiết lập Single tenant** – ID token của Firebase không mang Tenant ID của
Microsoft nên mã nguồn không tự kiểm tra được. Hãy kiểm tra lại thiết lập này mỗi khi đổi client secret (xem
[bước 1](#1-microsoft-entra--tạo-app-registration)).

**Bắt buộc với v2: bật “Email enumeration protection”.** Ở v2, quyền xem gắn với **email trong token** (tài liệu
`v2_access/<email>`). Khi tính năng này **tắt**, người đã đăng nhập có thể tự đổi email tài khoản Firebase của mình
(API `accounts:update` / `updateEmail`) thành email của một thành viên BGH mà không cần xác minh – token mới vẫn là
nhà cung cấp `microsoft.com` và Security Rules sẽ cho đọc dữ liệu của BGH. Firebase console → **Authentication →
Settings → User actions** → bật **Email enumeration protection** (project tạo sau 09/2023 bật sẵn – vẫn cần kiểm tra).
Khi bật, đổi email phải qua `verifyBeforeUpdateEmail` (cần bấm liên kết gửi vào hộp thư của email mới). Có thể kiểm
tra: gọi `accounts:update` bằng idToken của một tài khoản thử với email mới → phải nhận `OPERATION_NOT_ALLOWED`.
(Phòng thủ sâu hơn, nếu sau này cần: dùng blocking function của Identity Platform / custom claims do máy chủ đặt để
gắn quyền với định danh Microsoft bất biến thay vì email.)

**Dashboard v2 không lưu dữ liệu xuống máy:** Firestore dùng bộ nhớ đệm trong bộ nhớ (`memoryLocalCache`); bộ nhớ đệm
IndexedDB còn sót lại của v1 bị xóa khi mở trang và khi đăng xuất. Tài khoản không thuộc tên miền trường vẫn đăng nhập
được (nếu Entra cho phép, vd. khách B2B) nhưng chỉ thấy “chưa được cấp quyền” trừ khi có trong `ADMIN_EMAILS` /
trang “Phân quyền”.

## Dữ liệu trong Firestore

> Bảng dưới là dữ liệu của **v1**. v2 dùng các bộ sưu tập riêng `v2_*` – xem [Dữ liệu Firestore v2](#dữ-liệu-firestore-v2).

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

Liên kết *Preview* của Vercel (mỗi nhánh/commit một tên miền khác) mặc định không nằm trong *Authorized domains* nên
không đăng nhập được. Để thử v2 trên Preview, thêm **địa chỉ cố định của nhánh** vào *Authorized domains* – xem
[Thử nghiệm trên Vercel Preview](#thử-nghiệm-trên-vercel-preview).

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

> v2: cài cùng script này trên Sheet của **từng cấp** – xem [Apps Script cho từng cấp](#apps-script-cho-từng-cấp).

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

Kết quả mẫu (v1): `{"ok":true,"count":1040,"added":1040,"updated":0,"removed":0,"chunksWritten":3,…,"trigger":"cron"}`.
v2 trả `{"ok":true,"count":…,"added":…,"updated":…,"removed":…,"levels":{"tih":{"enabled":true,"count":…,"added":…},…},"scopes":…,"scopesWritten":…,"accessCount":…,…}`.
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

> Mục này mô tả **v1**. Ở v2, quyền xem do vai trò quyết định – xem [Phân quyền](#phân-quyền).

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
cp .env.example .env                          # SHEET_ID_TIH, SHEET_ID_THCS (+ ROLES_SHEET_ID, FIREBASE_SERVICE_ACCOUNT khi Sheet riêng tư); .env đã nằm trong .gitignore
npm run dry-run                               # đọc các Sheet, KHÔNG ghi Firestore → tạo dev-data-v2.json
# hoặc: npm run dry-run -- --tih <mã> --thcs <mã> [--thpt <mã>] [--roles <mã>] [--admin <email>] [--tables bảng.json] [--out tệp.json] [--no-write]
python3 -m http.server 8080 --bind 127.0.0.1  # chỉ máy này truy cập được; rồi mở http://127.0.0.1:8080/?local&as=admin
npm test                                      # kiểm thử offline (scripts/*.test.mjs)
npm run test:vercel                           # như trên, với --no-experimental-require-module (giống Vercel)
```

> [!WARNING]
> `python3 -m http.server` phục vụ **mọi tệp** trong thư mục, kể cả `.env` và `dev-data-v2.json`. Luôn dùng
> `--bind 127.0.0.1`; nếu không, mọi máy cùng mạng (vd. Wi-Fi của trường) tải được `http://<IP-máy-bạn>:8080/.env`.
> Trong `.env` cục bộ chỉ đặt những gì cần: `SHEET_ID_*`/`ROLES_SHEET_ID` cho dry-run, `FIREBASE_SERVICE_ACCOUNT` khi
> Sheet đã riêng tư; **không** đặt `SYNC_SECRET`/`CRON_SECRET` trừ khi chạy `vercel dev`.

- `npm run dry-run`: xem [Xem trước cục bộ (v2)](#xem-trước-cục-bộ-v2). Nếu có `FIREBASE_SERVICE_ACCOUNT` (hoặc 3 biến
  `FIREBASE_*`), lệnh đọc Sheet bằng service account đó – bắt buộc khi Sheet đã ở chế độ “Bị hạn chế”; nếu không, chỉ
  đọc được Sheet công khai (hoặc dùng `--tables` với bảng đã lưu). Lệnh không ghi gì lên Firestore.
- `?local&as=<bí danh>` (chỉ có tác dụng trên `localhost`/`127.0.0.1`) đọc `./dev-data-v2.json`
  (`{ meta, users: { <bí danh>: { email, access } }, scopes: { <scopeId>: { doc, chunks } } }`) và **bỏ qua đăng nhập**;
  bí danh: `admin`, `bgh_tih`, `bgh_thcs`, `to_tih`, `to_thcs`, `gv_tih`, `gv_thcs`, `khong-quyen`. Nút “Làm mới” đọc lại
  tệp. `dev-data-v2.json` chứa dữ liệu thật nên đã nằm trong `.gitignore`/`.vercelignore`.
- Mở `http://localhost:8080/` (không có `?local`) để thử đăng nhập Microsoft thật với dữ liệu Firestore thật
  (`localhost` có sẵn trong *Authorized domains*).
- Chạy cả `/api/sync` cục bộ: `npx vercel link` (một lần, chọn đúng project) rồi `npx vercel dev` (đọc biến môi
  trường từ `.env`). Không thêm script `dev` gọi `vercel dev` vào `package.json` – Vercel CLI sẽ từ chối chạy
  (“must not recursively invoke itself”).
- Deploy lên Production chỉ qua GitHub (push lên `main`). Nếu buộc phải deploy bằng Vercel CLI, `.vercelignore` là
  thứ ngăn `.env`, `dev-data*.json` bị tải lên thành tệp công khai – giữ nguyên tệp này.
- Không dùng Firestore emulator (cần Java); `npm test` kiểm thử phần đồng bộ với kho dữ liệu trong bộ nhớ
  (`server/memory-store.js` – mô phỏng cả giới hạn 500 thao tác và 10 MiB mỗi lô). `firestore.rules` không có kiểm thử
  tự động – sau khi sửa rules, hãy thử đăng nhập thật hoặc dùng *Rules Playground* trong Firebase console.

## Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
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
| “Tài khoản chưa được cấp quyền” ngay sau khi đăng nhập bằng tài khoản có email khác tên miền trường | Đã chọn tài khoản Microsoft có email khác (vd. tài khoản khách) mà email đó không có trong `ADMIN_EMAILS` / trang “Phân quyền” | Đăng xuất, chọn đúng tài khoản của trường (hoặc cấp quyền cho email đó). |
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
- **Đọc (v2):** mở dashboard ≈ 1 (`v2_access`) + 1 (`v2_meta/global`) + số phạm vi + số khối (BGH liên cấp ≈ 6–10,
  giáo viên ≈ 3–4), cộng một lượt đọc `v2_access` mỗi lần Security Rules kiểm tra một phạm vi. Dashboard v2 không giữ
  bộ nhớ đệm trên ổ đĩa nên mỗi lần mở trang đọc lại các tài liệu này – vẫn rất nhỏ so với 50.000 lượt/ngày.
- **Chỉ đồng bộ khi Google Sheet có dữ liệu mới:** mỗi lượt gọi (trừ cron và `?force=1`) đọc Sheet rồi tính *dấu vân
  tay* (SHA-256) của mọi đầu vào – dữ liệu thô các tab, chế độ chia sẻ, cấu hình Sheet/tab/ADMIN_EMAILS/tên miền, thang
  xếp loại, phiên bản mã (`VERCEL_GIT_COMMIT_SHA`) và tuần chốt số liệu đối sánh. Trùng với lượt đầy đủ gần nhất →
  trả `skipped: "unchanged"` sau **2 lượt đọc** (`v2_config/state` + khóa), **0 lượt ghi**, không ghi `v2_meta/global`
  nên các tab đang mở cũng không phải đọc lại. Người dùng bấm “Làm mới”: thêm 2 lượt đọc (giới hạn 60 s), 1 lượt
  `v2_access` nếu không thuộc ADMIN_EMAILS, và 1 lượt ghi giờ kiểm tra vào khóa (để bấm lại trong 60 s không đọc lại Sheet).
  Khi có thay đổi, máy chủ đọc lại Sheet sau khi giữ khóa (không dùng bản đọc trước khóa – tránh ghi đè lượt mới hơn). Tab đọc lỗi, dùng dữ liệu cũ, lượt dở dang hoặc đang có lượt khác giữ khóa
  → không bỏ qua. Cron 06:00 luôn chạy đầy đủ (kiểm tra, tự sửa sai lệch). Sau mỗi lần triển khai mã mới và đầu mỗi tuần
  (công bố lại số liệu đối sánh) lượt kế tiếp tự chạy đầy đủ một lần. Trình duyệt không còn tự gọi đồng bộ.
- **Ghi (v2):** mỗi lượt đồng bộ chỉ ghi phần thay đổi. Một phiếu mới ghi lại phạm vi cấp, phạm vi tổ, phạm vi cá nhân
  của người dạy và người dự (mỗi phạm vi 1 tài liệu + khối bị đổi) + `v2_meta/global` + `v2_config/state` + khóa:
  khoảng **8–12 lượt ghi/phiếu** (đo trên dữ liệu thật: trung bình 11). Số liệu đối sánh chỉ được công bố lại tối đa
  **một lần mỗi tuần** cho mỗi tổ/cấp → lượt đồng bộ đầu tiên của tuần ghi lại các phạm vi tổ và cá nhân (≈ 320 tài
  liệu với dữ liệu hiện tại). Ngày cao điểm (~120 phiếu) ≈ 1.300 lượt ghi; lượt bỏ qua vì Sheet không đổi **không ghi
  gì**; lượt đầy đủ không có thay đổi (cron 06:00, lượt đầu sau mỗi lần triển khai) chỉ ghi `meta`, `state` và khóa (4 lượt).
  Lần đồng bộ đầu tiên, mất `v2_config/state` hoặc `?force=1` đọc + ghi lại **toàn bộ** (≈ 1.200 lượt đọc + 1.200
  lượt ghi với dữ liệu 10/2026) – chỉ dùng khi thật cần; muốn chạy ngay một lượt thường thì bấm “Làm mới”.
- Khi bản v1 và v2 cùng chạy (thời gian thử Preview), hai bản dùng chung hạn mức của project `dugiotih`.
- (v1) Bộ sưu tập `phieu` để xem trong console/ứng dụng khác; dashboard **không** đọc nó (đọc toàn bộ tốn ~1 lượt/phiếu).
  v2 không ghi `phieu`.
- **Microsoft Entra:** App registration không tốn phí.
- **Vercel Hobby** miễn phí nhưng Vercel quy định gói này **chỉ dành cho mục đích cá nhân, phi thương mại** – nhà
  trường nên cân nhắc gói **Pro** cho hệ thống dùng chính thức. Gói Hobby: Cron tối đa 1 lần/ngày (lệch tới 59 phút),
  log máy chủ giữ 1 giờ. **Apps Script** trong hạn mức miễn phí; đồng bộ thường xuyên do Apps Script đảm nhận.
