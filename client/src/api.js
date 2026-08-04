/** โยนตอนเซสชันหมดอายุ/ยังไม่ login — หน้าเว็บใช้แยกว่าควรเด้งไปหน้า login ไหม */
export class UnauthorizedError extends Error {}

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // ส่งคุกกี้ session ไปด้วยทุก request
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) return null;

  // อ่านเป็นข้อความก่อนแล้วค่อย parse — บาง response ตอบ body ว่าง (เช่น server หลุดกลางคัน
  // หรือ proxy ตัดการเชื่อมต่อ) ถ้าเรียก res.json() ตรงๆ จะพังด้วยข้อความที่ผู้ใช้อ่านไม่รู้เรื่อง
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (res.status === 401) throw new UnauthorizedError(data?.error ?? 'กรุณาเข้าสู่ระบบ');

    // รวม error ของแต่ละ field จาก zod ให้เป็นข้อความเดียวที่อ่านรู้เรื่อง
    const fields = data?.details?.map((d) => `${d.field}: ${d.message}`).join('\n');
    throw new Error(fields ? `${data.error}\n${fields}` : (data?.error ?? `เรียก API ไม่สำเร็จ (HTTP ${res.status})`));
  }

  if (!data) throw new Error('เซิร์ฟเวอร์ตอบกลับไม่สมบูรณ์ — กรุณาลองใหม่อีกครั้ง');
  return data;
}

export const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
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
  /** สรุปค่าตอบแทนรายเดือนต่อพนักงาน (payroll) */
  attendanceReport: (month) => request(`/cases/attendance/report${month ? `?month=${month}` : ''}`),
  /** แปลงที่อยู่เป็นพิกัด (ผ่าน server) — คืน { lat, lng, formatted } */
  geocodeAddress: (address) => request('/cases/geocode', { method: 'POST', body: { address } }),
  /** อ่านพิกัด + ที่อยู่ จากลิงก์ Google Maps ที่วางมา */
  resolveMapLink: (url) => request('/cases/resolve-map-link', { method: 'POST', body: { url } }),
  /** ค้นหาสถานที่จากการพิมพ์ชื่อ/ที่อยู่ — คืนรายการให้เลือก */
  searchPlace: (query) => request('/cases/search-place', { method: 'POST', body: { query } }),
  /** admin แก้กะ (ปิดกะค้าง/แก้เวลา/เคลียร์ธง) */
  adjustVisit: (caseId, visitId, body) =>
    request(`/cases/${caseId}/visits/${visitId}/adjust`, { method: 'PATCH', body }),
  /** URL รูปเซลฟี่เช็คอินของกะ (ฝั่ง admin) — ใส่ใน <img src> ได้ */
  visitCheckinPhotoUrl: (caseId, visitId) => `/api/cases/${caseId}/visits/${visitId}/photo`,

  // ---------- ใบแจ้งหนี้ ----------
  listInvoices: (params = {}) => request(`/invoices?${new URLSearchParams(params)}`),
  invoiceSummary: () => request('/invoices/summary'),
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
  addVisit: (id, body) => request(`/cases/${id}/visits`, { method: 'POST', body }),
  updateVisit: (id, visitId, body) => request(`/cases/${id}/visits/${visitId}`, { method: 'PATCH', body }),
  deleteVisit: (id, visitId) => request(`/cases/${id}/visits/${visitId}`, { method: 'DELETE' }),
  assignCase: (id, employee_id) => request(`/cases/${id}/assign`, { method: 'POST', body: { employee_id } }),
  unassignCase: (id) => request(`/cases/${id}/unassign`, { method: 'POST' }),
  startCase: (id) => request(`/cases/${id}/start`, { method: 'POST' }),
  closeCase: (id, end_date) => request(`/cases/${id}/close`, { method: 'POST', body: { end_date } }),
  cancelCase: (id, reason) => request(`/cases/${id}/cancel`, { method: 'POST', body: { reason } }),
  reopenCase: (id) => request(`/cases/${id}/reopen`, { method: 'POST' }),
};
