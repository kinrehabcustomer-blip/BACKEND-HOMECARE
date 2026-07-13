async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) return null;

  const data = await res.json();
  if (!res.ok) {
    // รวม error ของแต่ละ field จาก zod ให้เป็นข้อความเดียวที่อ่านรู้เรื่อง
    const fields = data.details?.map((d) => `${d.field}: ${d.message}`).join('\n');
    throw new Error(fields ? `${data.error}\n${fields}` : (data.error ?? 'เรียก API ไม่สำเร็จ'));
  }
  return data;
}

export const api = {
  meta: () => request('/employees/meta'),
  summary: () => request('/employees/summary'),

  listEmployees: (params) => request(`/employees?${new URLSearchParams(params)}`),
  getEmployee: (id) => request(`/employees/${id}`),
  createEmployee: (body) => request('/employees', { method: 'POST', body }),
  updateEmployee: (id, body) => request(`/employees/${id}`, { method: 'PATCH', body }),
  resignEmployee: (id, resign_date) =>
    request(`/employees/${id}`, { method: 'DELETE', body: { resign_date } }),
  deleteEmployee: (id) => request(`/employees/${id}?hard=true`, { method: 'DELETE' }),

  addCertificate: (id, body) => request(`/employees/${id}/certificates`, { method: 'POST', body }),
  deleteCertificate: (id, certificateId) =>
    request(`/employees/${id}/certificates/${certificateId}`, { method: 'DELETE' }),
};
