/** โยนตอนเซสชันหมดอายุ/ยังไม่ login — หน้าเว็บใช้แยกว่าควรเด้งไปหน้า login ไหม */
export class UnauthorizedError extends Error {}

/**
 * ตัวรับแจ้งว่าเซสชันใช้ไม่ได้แล้ว — AuthProvider ลงทะเบียนไว้ตอนแอปเริ่มทำงาน
 *
 * ต้องแจ้งจากจุดนี้จุดเดียว เพราะไม่มีทางรู้ล่วงหน้าว่าคนใช้จะค้างอยู่หน้าไหนตอนเซสชันหมดอายุ
 * ปล่อยให้แต่ละหน้าดักเอง = ต้องไปแก้ทุกหน้า แล้วหน้าที่เขียนเพิ่มทีหลังจะตกหล่นเสมอ
 * ซึ่งเป็นสิ่งที่เกิดขึ้นมาแล้ว: เคยมีตัวช่วยให้หน้าเรียกใช้ แต่ไม่มีหน้าไหนเรียกเลยสักหน้า
 * ทิ้งแท็บไว้ข้ามคืนแล้วกลับมากด จึงได้แถบแดง "เซสชันหมดอายุ" ค้างอยู่ ทุกปุ่มพัง
 * และไม่มีอะไรพาไปหน้า login — ต้องพิมพ์ URL เอง
 */
let onUnauthorized = null;
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

/**
 * เลิกรอเมื่อไร — fetch ไม่มีเวลาหมดอายุในตัว ถ้าไม่กำหนดเองมันรอได้ไม่จำกัด
 *
 * 30 วินาที: รูปที่ย่อแล้วอยู่ราว 100–300 KB (ดู lib/image.js) ต่อให้อยู่บน 3G ในอาคาร
 * ก็ยังส่งจบทัน แต่ไม่ปล่อยให้ค้างจนคนเลิกรอไปเอง
 */
const TIMEOUT_MS = 30_000;

/**
 * empty = true บอกว่า "เรียกอันนี้แล้วไม่มีอะไรให้คืนกลับมาก็ถูกแล้ว"
 * DELETE เป็นแบบนั้นโดยธรรมชาติอยู่แล้ว จึงไม่ต้องประกาศ (ดูเงื่อนไข 204 ด้านล่าง)
 */
async function request(path, { empty = false, credentialCheck = false, ...options } = {}) {
  /* พนักงานภาคสนามใช้งานจากมือถือ ซึ่งเข้าจุดอับสัญญาณ/ลิฟต์/ชั้นใต้ดินเป็นเรื่องปกติ
     ในจุดอับ request จะออกไปแล้วเงียบหายไปเลย ไม่ตอบและไม่ error
     ผลคือปุ่มค้างอยู่ที่ "กำลังบันทึก…" และ disabled ตลอดกาล กดซ้ำก็ไม่ได้
     ไม่มีอะไรบอกว่าเกิดอะไรขึ้น และข้อมูลก็ไม่ได้ถูกบันทึกจริง
     — นี่คือที่มาของอาการ "กดปุ่มไม่ติด / กดบันทึกแล้วไม่ save" ที่เจอหน้างาน */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  let text;
  try {
    res = await fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // ส่งคุกกี้ session ไปด้วยทุก request
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
      // อยู่หลัง spread — เวลาหมดอายุเป็นสิ่งที่ผู้เรียกเขียนทับไม่ได้
      signal: controller.signal,
    });

    /* 204 = ไม่มีเนื้อหาให้คืน ซึ่งถูกต้องสำหรับ DELETE และ logout
       แต่ถ้ามาจาก POST/PATCH ที่ผู้เรียกรอ object กลับไปใช้ต่อ (เช่น เอา id ของที่เพิ่งสร้างไปเปิดหน้าถัดไป)
       การคืน null เงียบๆ จะไปพังที่จุดใช้งานแทน ด้วยข้อความอย่าง
       "Cannot read properties of null (reading 'customer_id')" ซึ่งคนหน้างานอ่านไม่รู้เรื่อง
       ให้ล้มตรงนี้พร้อมข้อความไทยดีกว่า — ล้มใกล้ต้นเหตุและบอกได้ว่าเกิดอะไรขึ้น */
    if (res.status === 204) {
      if (empty || options.method === 'DELETE') return null;
      throw new Error('เซิร์ฟเวอร์ตอบกลับไม่สมบูรณ์ — กรุณาลองใหม่อีกครั้ง');
    }

    // อ่านเป็นข้อความก่อนแล้วค่อย parse — บาง response ตอบ body ว่าง (เช่น server หลุดกลางคัน
    // หรือ proxy ตัดการเชื่อมต่อ) ถ้าเรียก res.json() ตรงๆ จะพังด้วยข้อความที่ผู้ใช้อ่านไม่รู้เรื่อง
    // อ่าน body ให้จบในนี้ด้วย จะได้ยังอยู่ในความคุ้มครองของ timeout (ตัว body เองก็ค้างได้)
    text = await res.text();
  } catch (err) {
    /* ข้อความดิบของเบราว์เซอร์เป็นภาษาอังกฤษและไม่เหมือนกันสักตัว
       — Chrome: "Failed to fetch" · Safari บน iPhone: "Load failed" · Firefox: "NetworkError…"
       คนใช้งานอ่านแล้วแยกไม่ออกว่าเป็นที่สัญญาณตัวเองหรือระบบพัง และไม่รู้ว่าต้องทำอะไรต่อ
       ต้องบอกด้วยว่าข้อมูลที่กรอกไว้ยังอยู่ ไม่งั้นคนจะไม่กล้ากดซ้ำเพราะกลัวบันทึกซ้ำซ้อน */
    if (err.name === 'AbortError') {
      throw new Error('เชื่อมต่อนานเกินไป — สัญญาณอาจอ่อน ลองกดใหม่อีกครั้ง (ข้อมูลที่กรอกไว้ยังอยู่ครบ)');
    }
    // fetch โยน TypeError เมื่อต่อไม่ติดจริงๆ เท่านั้น
    if (err instanceof TypeError) {
      throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจสอบสัญญาณอินเทอร์เน็ตแล้วลองใหม่ (ข้อมูลที่กรอกไว้ยังอยู่ครบ)');
    }
    /* ที่เหลือคือ error ที่เราโยนเองในบล็อกนี้ (เช่น 204 ที่ไม่ควรว่าง) — ต้องปล่อยผ่านไปตามเดิม
       ถ้าเหมารวมว่าเป็นปัญหาเน็ตทั้งหมด ข้อความจะเพี้ยนเป็น "ตรวจสอบสัญญาณอินเทอร์เน็ต"
       ทั้งที่ต่อติดดีอยู่ แล้วคนจะไล่ผิดทาง (ดักไว้ตรงนี้เพราะโค้ดที่เติมทีหลังก็จะเจอกับดักเดิม) */
    throw err;
  } finally {
    // ยกเลิกตัวนับทุกทาง ไม่งั้น request ที่จบเร็วจะทิ้ง timer ค้างไว้เต็มไปหมด
    clearTimeout(timer);
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* ตอบกลับมาแต่ไม่ใช่ JSON — มักเป็นหน้า HTML ของ proxy/gateway (502/504)
         หรือหน้าล็อกอินของไวไฟสาธารณะที่ดักไว้กลางทาง ซึ่งเจอบ่อยเวลาออกไปทำงานนอกสถานที่
         ปล่อยให้ JSON.parse พังเองจะได้ข้อความแบบ "Unexpected token '<'" ที่ไม่ช่วยอะไรเลย */
      throw new Error(
        res.ok
          ? 'เซิร์ฟเวอร์ตอบกลับมาไม่ถูกรูปแบบ — กรุณาลองใหม่อีกครั้ง'
          : `เชื่อมต่อไม่สำเร็จ (HTTP ${res.status}) — ถ้ากำลังใช้ไวไฟสาธารณะ ให้เข้าสู่ระบบไวไฟให้เรียบร้อยก่อนแล้วลองใหม่`,
      );
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      const err = new UnauthorizedError(data?.error ?? 'กรุณาเข้าสู่ระบบ');
      /* ส่งข้อความของ server ต่อไปให้หน้า login แสดง — มันบอกได้ตรงกว่าที่เราจะเขียนเอง
         ("เซสชันหมดอายุ" / "บัญชีนี้ใช้งานไม่ได้แล้ว" เป็นคนละเรื่องที่ต้องทำคนละอย่าง)
         credentialCheck = การตรวจรหัสผ่านตอน login ซึ่ง 401 แปลว่า "กรอกผิด" ไม่ใช่ "เซสชันหลุด"
         เหมารวมจะกลายเป็นกรอกรหัสผิดแล้วโดนล้างเซสชันทิ้ง แล้วข้อความบอกผิดเรื่อง */
      if (!credentialCheck) onUnauthorized?.(err.message);
      throw err;
    }

    // รวม error ของแต่ละ field จาก zod ให้เป็นข้อความเดียวที่อ่านรู้เรื่อง
    const fields = data?.details?.map((d) => `${d.field}: ${d.message}`).join('\n');
    const head = fields ? `${data.error}\n${fields}` : (data?.error ?? `เรียก API ไม่สำเร็จ (HTTP ${res.status})`);
    /* technical = ตัวจริงของ error ฝั่ง server (ส่งมาเฉพาะกรณี 500 ที่ไม่รู้จัก)
       ต่อท้ายให้เห็นบนหน้าจอเลย คนหน้างานจะได้ก๊อป/แคปส่งต่อได้โดยไม่ต้องไปเปิด log ของ server */
    const error = new Error(data?.technical ? `${head}\n${data.technical}` : head);

    // แนบรายละเอียดรายช่องไว้ด้วย ให้ฟอร์มเอาไปแปะข้อความใต้ช่องที่ผิดได้ตรงจุด
    // (ยังคงข้อความรวมไว้เหมือนเดิม — หน้าที่ยังไม่ได้ใช้ fields จะไม่เปลี่ยนพฤติกรรม)
    if (data?.details) error.fields = data.details;
    throw error;
  }

  if (!data) throw new Error('เซิร์ฟเวอร์ตอบกลับไม่สมบูรณ์ — กรุณาลองใหม่อีกครั้ง');
  return data;
}

export const api = {
  login: (email, password) =>
    request('/auth/login', { method: 'POST', credentialCheck: true, body: { email, password } }),
  // POST เดียวในระบบที่ตอบ 204 อย่างถูกต้อง (ล้างคุกกี้แล้วจบ ไม่มีอะไรให้คืน)
  logout: () => request('/auth/logout', { method: 'POST', empty: true }),
  me: () => request('/auth/me'),

  forgotPassword: (email) => request('/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword: (body) => request('/auth/reset-password', { method: 'POST', body }),
  changePassword: (body) => request('/auth/change-password', { method: 'POST', body }),

  meta: () => request('/employees/meta'),
  summary: () => request('/employees/summary'),

  listEmployees: (params) => request(`/employees?${new URLSearchParams(params)}`),
  getEmployee: (id) => request(`/employees/${id}`),
  createEmployee: (body) => request('/employees', { method: 'POST', body }),
  updateEmployee: (id, body) => request(`/employees/${id}`, { method: 'PATCH', body }),
  resignEmployee: (id, resign_date) =>
    request(`/employees/${id}`, { method: 'DELETE', body: { resign_date } }),
  deleteEmployee: (id) => request(`/employees/${id}?hard=true`, { method: 'DELETE' }),

  /** แนบรูปพนักงานทับของเดิม — ส่ง image: null เพื่อลบรูป (คืนข้อมูลพนักงานที่อัปเดตแล้ว) */
  setEmployeePhoto: (id, image) => request(`/employees/${id}/photo`, { method: 'PUT', body: { image } }),

  /**
   * URL รูปพนักงาน — ใส่ตรงๆ ใน <img src> ได้ (เบราว์เซอร์แนบคุกกี้ session ไปเอง)
   * version = updated_at ของพนักงาน: เปลี่ยนรูปแล้ว URL เปลี่ยนตาม เบราว์เซอร์จึงไม่หยิบรูปเก่าที่แคชไว้มาโชว์
   */
  employeePhotoUrl: (id, version) =>
    `/api/employees/${id}/photo${version ? `?v=${encodeURIComponent(version)}` : ''}`,

  listCertificates: (id) => request(`/employees/${id}/certificates`),
  addCertificate: (id, body) => request(`/employees/${id}/certificates`, { method: 'POST', body }),
  deleteCertificate: (id, certificateId) =>
    request(`/employees/${id}/certificates/${certificateId}`, { method: 'DELETE' }),

  /** แนบรูปทับของเดิม — ส่ง image: null เพื่อลบรูป (ใบรับรองยังอยู่) */
  setCertificateImage: (id, certificateId, image) =>
    request(`/employees/${id}/certificates/${certificateId}/image`, { method: 'PUT', body: { image } }),

  /** URL ของรูป — ใส่ตรงๆ ใน <img src> ได้ (เบราว์เซอร์แนบคุกกี้ session ไปเอง) */
  certificateImageUrl: (id, certificateId) =>
    `/api/employees/${id}/certificates/${certificateId}/image`,

  // ---------- ผลงาน (โปรไฟล์พนักงาน) ----------
  listPortfolio: (id) => request(`/employees/${id}/portfolio`),
  addPortfolio: (id, body) => request(`/employees/${id}/portfolio`, { method: 'POST', body }),
  /** แก้ได้เฉพาะชื่อกับคำอธิบาย — รูปเปลี่ยนไม่ได้ */
  updatePortfolio: (id, portfolioId, body) =>
    request(`/employees/${id}/portfolio/${portfolioId}`, { method: 'PATCH', body }),
  deletePortfolio: (id, portfolioId) =>
    request(`/employees/${id}/portfolio/${portfolioId}`, { method: 'DELETE' }),
  portfolioImageUrl: (id, portfolioId) =>
    `/api/employees/${id}/portfolio/${portfolioId}/image`,

  // ---------- แพ็คเกจบริการ (ตารางเรท: เกรด × รูปแบบ × CG/NA/PN) ----------
  packageMatrix: () => request('/packages/matrix'),

  createGrade: (body) => request('/packages/grades', { method: 'POST', body }),
  updateGrade: (id, body) => request(`/packages/grades/${id}`, { method: 'PATCH', body }),
  deleteGrade: (id) => request(`/packages/grades/${id}`, { method: 'DELETE' }),

  createFormat: (body) => request('/packages/formats', { method: 'POST', body }),
  updateFormat: (id, body) => request(`/packages/formats/${id}`, { method: 'PATCH', body }),
  deleteFormat: (id) => request(`/packages/formats/${id}`, { method: 'DELETE' }),

  /** บันทึกราคาหลายช่องพร้อมกัน — คืนตารางเรทใหม่ทั้งชุด */
  saveRates: (rates) => request('/packages/rates', { method: 'PATCH', body: { rates } }),

  // ---------- แพ็คเกจกายภาพบำบัด (เหมาจำนวนครั้ง — ตกเฉลี่ย/ส่วนลด คำนวณมาจากฝั่ง server) ----------
  listPhysioPackages: () => request('/physio/packages'),
  createPhysioPackage: (body) => request('/physio/packages', { method: 'POST', body }),
  updatePhysioPackage: (id, body) => request(`/physio/packages/${id}`, { method: 'PATCH', body }),
  deletePhysioPackage: (id) => request(`/physio/packages/${id}`, { method: 'DELETE' }),
  /** จัดลำดับใหม่ (ส่ง id ทั้งชุดตามลำดับที่ต้องการ) — คืนรายการที่เรียงแล้ว */
  reorderPhysioPackages: (order) => request('/physio/reorder', { method: 'PATCH', body: { order } }),

  // ---------- ลูกค้า ----------
  listCustomers: (params) => request(`/customers?${new URLSearchParams(params)}`),
  getCustomer: (id) => request(`/customers/${id}`),
  createCustomer: (body) => request('/customers', { method: 'POST', body }),
  updateCustomer: (id, body) => request(`/customers/${id}`, { method: 'PATCH', body }),
  deleteCustomer: (id) => request(`/customers/${id}`, { method: 'DELETE' }),

  // ---------- ผู้รับการดูแล (Patient) — แฟ้มถาวรของคนที่ถูกดูแล ผูกใต้ลูกค้า ----------
  listPatients: (params) => request(`/patients?${new URLSearchParams(params)}`),
  getPatient: (id) => request(`/patients/${id}`),
  createPatient: (body) => request('/patients', { method: 'POST', body }),
  updatePatient: (id, body) => request(`/patients/${id}`, { method: 'PATCH', body }),
  deletePatient: (id) => request(`/patients/${id}`, { method: 'DELETE' }),

  // ---------- ของฉัน (พนักงานภาคสนาม — เห็นเฉพาะเคส/กะตัวเอง) ----------
  myCases: () => request('/my/cases'),
  myCase: (id) => request(`/my/cases/${id}`),
  myCalendar: ({ year, month }) => request(`/my/calendar?${new URLSearchParams({ year, month })}`),

  // ตารางงาน + เช็คอิน/เอาท์
  myToday: () => request('/my/today'),
  myAttendance: (month) => request(`/my/attendance${month ? `?month=${month}` : ''}`),
  /** สรุปค่าตอบแทนรายเดือนของตัวเอง — คืนแถวเดียว (ตัวเลขของผู้เรียกเท่านั้น) */
  myAttendanceReport: (month) => request(`/my/attendance/report${month ? `?month=${month}` : ''}`),
  checkIn: (visitId, body) => request(`/my/visits/${visitId}/check-in`, { method: 'POST', body }),
  checkOut: (visitId, body) => request(`/my/visits/${visitId}/check-out`, { method: 'POST', body }),
  /** URL รูปเซลฟี่ตอนเช็คอิน — ใส่ใน <img src> ได้ (คุกกี้ session ไปด้วยอัตโนมัติ) */
  visitPhotoUrl: (visitId) => `/api/my/visits/${visitId}/photo`,

  // ---------- เคส ----------
  caseSummary: ({ year, month } = {}) => {
    const params = new URLSearchParams();
    if (year) params.set('year', year);
    if (year && month) params.set('month', month); // เดือนไม่มีความหมายถ้าไม่ระบุปี
    return request(`/cases/summary${params.size ? `?${params}` : ''}`);
  },
  casePeriods: () => request('/cases/periods'),
  assignableEmployees: () => request('/cases/assignable-employees'),

  listCases: (params) => request(`/cases?${new URLSearchParams(params)}`),
  getCase: (id) => request(`/cases/${id}`),
  createCase: (body) => request('/cases', { method: 'POST', body }),
  updateCase: (id, body) => request(`/cases/${id}`, { method: 'PATCH', body }),
  deleteCase: (id) => request(`/cases/${id}`, { method: 'DELETE' }),

  // ตารางงานรายเดือน — เคสที่ช่วงวันให้บริการคาบเกี่ยวเดือนที่ขอ (employee_id เว้นว่าง = ทุกคน)
  caseCalendar: ({ year, month, employee_id }) => {
    const params = new URLSearchParams({ year, month });
    if (employee_id) params.set('employee_id', employee_id);
    return request(`/cases/calendar?${params}`);
  },

  // ---------- การมาทำงาน / เช็คอิน (ฝั่ง admin) ----------
  attendance: ({ month, employee_id } = {}) => {
    const params = new URLSearchParams();
    if (month) params.set('month', month);
    if (employee_id) params.set('employee_id', employee_id);
    return request(`/cases/attendance${params.size ? `?${params}` : ''}`);
  },
  attendanceExceptions: () => request('/cases/attendance/exceptions'),
  /** คิวกะที่ทำงานจบแล้วแต่ยังไม่ได้อนุมัติค่าจ้าง */
  pendingApprovals: ({ month, employee_id } = {}) => {
    const params = new URLSearchParams();
    if (month) params.set('month', month);
    if (employee_id) params.set('employee_id', employee_id);
    return request(`/cases/attendance/pending${params.size ? `?${params}` : ''}`);
  },
  /** อนุมัติ/ไม่อนุมัติค่าจ้างของกะที่เลือก — approve=false ต้องมีเหตุผล */
  decidePay: (visit_ids, approve, reason = null) =>
    request('/cases/attendance/decide', { method: 'POST', body: { visit_ids, approve, reason } }),
  /** อนุมัติค่าจ้างของกะที่ทำจบแล้วทั้งเคสในครั้งเดียว */
  approveCasePay: (caseId) => request(`/cases/${caseId}/approve-pay`, { method: 'POST' }),
  /** สรุปค่าตอบแทนรายเดือนต่อพนักงาน (payroll) — ไม่ส่ง employee_id = ทุกคน */
  attendanceReport: (month, employee_id) => {
    const params = new URLSearchParams();
    if (month) params.set('month', month);
    if (employee_id) params.set('employee_id', employee_id);
    return request(`/cases/attendance/report${params.size ? `?${params}` : ''}`);
  },
  /** แปลงที่อยู่เป็นพิกัด (ผ่าน server) — คืน { lat, lng, formatted } */
  geocodeAddress: (address) => request('/cases/geocode', { method: 'POST', body: { address } }),
  /** อ่านพิกัด + ที่อยู่ จากลิงก์ Google Maps ที่วางมา */
  resolveMapLink: (url) => request('/cases/resolve-map-link', { method: 'POST', body: { url } }),
  /**
   * ค้นหาสถานที่จากการพิมพ์ชื่อ/ที่อยู่ — คืนรายการให้เลือก
   * near = พิกัดที่หน้าเว็บมีอยู่แล้ว (ไม่บังคับ) ส่งไปเพื่อให้ผลใกล้จุดนั้นขึ้นก่อน
   */
  searchPlace: (query, near) =>
    request('/cases/search-place', {
      method: 'POST',
      body: { query, near_lat: near?.lat ?? null, near_lng: near?.lng ?? null },
    }),
  /** admin แก้กะ (ปิดกะค้าง/แก้เวลา/เคลียร์ธง) */
  adjustVisit: (caseId, visitId, body) =>
    request(`/cases/${caseId}/visits/${visitId}/adjust`, { method: 'PATCH', body }),
  /** URL รูปเซลฟี่เช็คอินของกะ (ฝั่ง admin) — ใส่ใน <img src> ได้ */
  visitCheckinPhotoUrl: (caseId, visitId) => `/api/cases/${caseId}/visits/${visitId}/photo`,

  // ---------- แจ้งเตือนอัตโนมัติ ----------
  /** ดูว่าตอนนี้มีของค้างอะไรบ้าง (ไม่ส่งอีเมล) */
  digestPreview: () => request('/notify/digest-preview'),
  /**
   * ส่งสรุปของค้างทางอีเมลเดี๋ยวนี้ — ปกติ cron ส่งให้เองวันละครั้ง ปุ่มนี้ไว้ทดสอบ/ส่งซ้ำ
   * เป็น POST เพราะสั่งให้ระบบ "ทำอะไรบางอย่าง" (ส่งอีเมลจริง) ไม่ใช่แค่อ่านข้อมูล
   * ทาง GET เหลือไว้ให้ cron เท่านั้นและไม่รับคุกกี้แล้ว
   */
  sendDailyDigest: () => request('/notify/daily-digest', { method: 'POST' }),

  // ---------- ใบแจ้งหนี้ ----------
  listInvoices: (params = {}) => request(`/invoices?${new URLSearchParams(params)}`),
  /** ยอดสรุปใบแจ้งหนี้ — ส่งตัวกรองชุดเดียวกับ listInvoices เพื่อให้ตัวเลขตรงกับรายการที่แสดงอยู่ */
  invoiceSummary: (params = {}) => request(`/invoices/summary?${new URLSearchParams(params)}`),
  /**
   * รายได้ตามช่วงเวลาสำหรับกราฟ — นับเฉพาะใบที่ชำระแล้ว ยึดวันที่รับเงิน
   * bucket: 'day' (ปริยาย 30 วัน) | 'week' (ปริยาย 12 สัปดาห์) · ช่องที่ไม่มีรายได้คืนมาเป็น 0 ครบทุกช่อง
   */
  invoiceRevenue: ({ bucket = 'day', points } = {}) => {
    const params = new URLSearchParams({ bucket });
    if (points) params.set('points', points);
    return request(`/invoices/revenue?${params}`);
  },
  getInvoice: (id) => request(`/invoices/${id}`),
  createInvoice: (body) => request('/invoices', { method: 'POST', body }),
  updateInvoice: (id, body) => request(`/invoices/${id}`, { method: 'PATCH', body }),
  refreshInvoice: (id) => request(`/invoices/${id}/refresh`, { method: 'POST' }),
  issueInvoice: (id) => request(`/invoices/${id}/issue`, { method: 'POST' }),
  payInvoice: (id, body) => request(`/invoices/${id}/pay`, { method: 'POST', body }),
  cancelInvoice: (id) => request(`/invoices/${id}/cancel`, { method: 'POST' }),
  deleteInvoice: (id) => request(`/invoices/${id}`, { method: 'DELETE' }),

  // วันนัดให้บริการของเคส — ทุกตัวคืน "รายการวันนัดล่าสุดทั้งหมด" กลับมา ไม่ต้องดึงซ้ำเอง
  listVisits: (id) => request(`/cases/${id}/visits`),
  /** เพิ่มกะทีละวัน — คืน { visits, added, skipped, conflicts } */
  addVisit: (id, body) => request(`/cases/${id}/visits`, { method: 'POST', body }),
  /** ลงกะหลายวันในครั้งเดียว — ส่ง { dates: [...] } หรือ { from, to, weekdays } · คืนรูปแบบเดียวกับ addVisit */
  addVisits: (id, body) => request(`/cases/${id}/visits/bulk`, { method: 'POST', body }),
  /** ตรวจก่อนบันทึกว่าวันที่เลือกไว้ชนกับงานอื่นไหม — คืน { conflicts, duplicates } (ไม่บันทึกอะไร) */
  previewVisits: (id, body) => request(`/cases/${id}/visits/preview`, { method: 'POST', body }),
  /** ลบกะของวันที่ระบุ — คืน { visits, deleted, kept } (kept = กะที่เช็คอินแล้ว จึงไม่ลบให้) */
  deleteVisitsOn: (id, dates) =>
    request(`/cases/${id}/visits?${new URLSearchParams({ dates: dates.join(',') })}`, { method: 'DELETE' }),
  updateVisit: (id, visitId, body) => request(`/cases/${id}/visits/${visitId}`, { method: 'PATCH', body }),
  deleteVisit: (id, visitId) => request(`/cases/${id}/visits/${visitId}`, { method: 'DELETE' }),
  /** ประวัติการทำรายการของเคส (ใครจับคู่/ปิด/ยกเลิก เมื่อไหร่) — ใหม่สุดอยู่บน */
  listCaseEvents: (id) => request(`/cases/${id}/events`),
  assignCase: (id, employee_id) => request(`/cases/${id}/assign`, { method: 'POST', body: { employee_id } }),
  unassignCase: (id) => request(`/cases/${id}/unassign`, { method: 'POST' }),
  startCase: (id) => request(`/cases/${id}/start`, { method: 'POST' }),
  /** ปิดเคส — force = ยืนยันแล้วว่ารู้ว่ายังมีกะค้าง (ไม่ส่ง = server จะตอบ 409 พร้อมบอกว่าค้างอะไร) */
  closeCase: (id, end_date, force = false) =>
    request(`/cases/${id}/close`, { method: 'POST', body: { end_date, force } }),
  cancelCase: (id, reason) => request(`/cases/${id}/cancel`, { method: 'POST', body: { reason } }),
  reopenCase: (id) => request(`/cases/${id}/reopen`, { method: 'POST' }),
};
