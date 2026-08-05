import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import CustomerCases from './CustomerCases.jsx';
import {
  GENDER_LABELS, TITLE_LABELS, MARITAL_STATUS_LABELS, PATIENT_STATUS_LABELS,
  formatDate, ageFromBirthDate,
} from '../labels.js';

const FOCUSABLE = 'a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** อายุจากวันเกิดแม่นกว่าเลขที่กรอกไว้เมื่อหลายปีก่อน — ใช้ช่อง age เป็นตัวสำรองเมื่อไม่รู้วันเกิด */
function displayAge(c) {
  const age = ageFromBirthDate(c.birth_date) ?? c.age;
  return age != null ? `${age} ปี` : null;
}

/** ที่อยู่เต็มจากส่วนย่อย — ประกอบตอนแสดง ไม่เก็บซ้ำ */
const fullAddress = (c) =>
  [c.address, c.subdistrict, c.district, c.province, c.postal_code].filter(Boolean).join(' ') || null;

function Field({ label, value, mono }) {
  const empty = value == null || value === '' || value === false;
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className={`field-value ${mono ? 'mono' : ''} ${empty ? 'is-empty' : ''}`}>
        {empty ? 'ไม่ได้ระบุ' : value}
      </span>
    </div>
  );
}

/**
 * แก้ช่องติดต่อที่เปลี่ยนบ่อยที่สุดได้ตรงนี้เลย ไม่ต้องออกไปหน้าฟอร์มเต็ม
 * เลือกสามช่องนี้เพราะเป็นสิ่งที่แก้กันจริงในงานประจำวัน (เปลี่ยนเบอร์ ย้าย Line เพิ่มอีเมล)
 */
function QuickEdit({ customer, onDone, onCancel }) {
  const toast = useToast();
  const [form, setForm] = useState({
    phone: customer.phone ?? '',
    line_id: customer.line_id ?? '',
    email: customer.email ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm((prev) => ({ ...prev, [key]: e.target.value })),
  });

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // ช่องว่างต้องเป็น null ไม่ใช่ "" ไม่งั้นไม่ผ่าน validation ของเบอร์โทร/อีเมล
      const payload = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, v.trim() === '' ? null : v.trim()]),
      );
      const updated = await api.updateCustomer(customer.customer_id, payload);
      toast('บันทึกแล้ว');
      onDone(updated);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="quick-edit" onSubmit={handleSubmit}>
      {error && <p className="error">{error}</p>}
      <div className="grid cols-2">
        <label>เบอร์มือถือ<input inputMode="tel" {...field('phone')} /></label>
        <label>Line ID<input {...field('line_id')} /></label>
        <label className="span-2">Email<input type="email" {...field('email')} /></label>
      </div>
      <div className="quick-edit-actions">
        <button className="btn" type="button" onClick={onCancel} disabled={saving}>ยกเลิก</button>
        <button className="btn primary" type="submit" disabled={saving}>
          {saving ? 'กำลังบันทึก…' : 'บันทึก'}
        </button>
      </div>
    </form>
  );
}

export default function CustomerModal({ customerId, siblings = [], onNavigate, onClose, onChanged }) {
  const [customer, setCustomer] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const boxRef = useRef(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setCustomer(null);
    setError(null);
    setEditing(false); // เปลี่ยนคนแล้วต้องปิดโหมดแก้ ไม่งั้นค่าที่ค้างอยู่จะไปทับข้อมูลคนใหม่

    api
      .getCustomer(customerId)
      .then((data) => !cancelled && setCustomer(data))
      .catch((err) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
    };
  }, [customerId]);

  /*
   * ล็อกไม่ให้หน้าหลังเลื่อนตาม + คืนโฟกัสกลับไปที่แถวเดิมตอนปิด (ไม่ใช่ดีดกลับไปต้นหน้า)
   * ต้องแยกเป็น effect ที่ทำงานครั้งเดียวตลอดอายุกล่อง — ถ้าไปรวมกับ effect ที่มี deps
   * โฟกัสจะถูกคืนออกไปข้างนอกทุกครั้งที่ deps เปลี่ยน (เช่น ตอนกดเข้าโหมดแก้ด่วน)
   */
  useEffect(() => {
    const previous = document.activeElement;
    boxRef.current?.focus();
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, []);

  /* ปิดด้วย Esc + ขังโฟกัสไว้ในกล่อง — ถ้าไม่ขัง Tab จะวิ่งไปโดนลิงก์ที่อยู่หลังฉาก */
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        // กำลังแก้อยู่ Esc ควรยกเลิกการแก้ก่อน ไม่ใช่ปิดทั้งกล่องจนสิ่งที่พิมพ์ไว้หาย
        if (editing) setEditing(false);
        else onClose();
        return;
      }

      if (e.key !== 'Tab') return;

      const items = [...(boxRef.current?.querySelectorAll(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === boxRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, editing]);

  // ตำแหน่งของคนนี้ในรายการหน้าปัจจุบัน — ใช้ทำปุ่มดูคนก่อนหน้า/ถัดไป
  const index = siblings.indexOf(customerId);
  const prevId = index > 0 ? siblings[index - 1] : null;
  const nextId = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;

  /** แก้ด่วนสำเร็จ — เอาข้อมูลใหม่มาแสดงทันที แล้วบอกหน้ารายการให้ดึงใหม่ */
  const handleSaved = (updated) => {
    setCustomer((prev) => ({ ...prev, ...updated }));
    setEditing(false);
    onChanged?.();
  };

  async function handleDelete() {
    if (
      !confirm(
        `ลบลูกค้า ${customerId}?\nเคสที่เคยให้บริการจะยังอยู่ในระบบ (ข้อมูลผู้ป่วยถูกบันทึกไว้ในเคสแล้ว) แต่จะไม่เชื่อมกับลูกค้ารายนี้อีก`,
      )
    ) {
      return;
    }

    setDeleting(true);
    try {
      await api.deleteCustomer(customerId);
      toast(`ลบลูกค้า ${customerId} แล้ว`);
      onChanged?.();
      onClose();
    } catch (err) {
      // ก่อนหน้านี้ไม่มี catch — ลบไม่สำเร็จแล้วเงียบสนิท ผู้ใช้เห็น popup ค้างอยู่โดยไม่รู้ว่าเกิดอะไรขึ้น
      setError(err.message);
      setDeleting(false);
    }
  }

  const genderAge = customer
    ? [GENDER_LABELS[customer.gender], displayAge(customer)].filter(Boolean).join(' / ')
    : '';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="ข้อมูลลูกค้า"
        tabIndex={-1}
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
      >
        {!customer && !error && <p className="muted modal-loading">กำลังโหลด…</p>}
        {!customer && error && <pre className="error modal-loading">{error}</pre>}

        {customer && (
          <>
            <header className="modal-head">
              <div>
                <p className="mono muted">{customer.customer_id}</p>
                <h2>
                  {[TITLE_LABELS[customer.title], customer.name].filter(Boolean).join('')}
                  {customer.nickname && <span className="muted"> ({customer.nickname})</span>}
                </h2>
                {customer.name_en && <p className="muted">{customer.name_en}</p>}
              </div>

              <div className="modal-head-actions">
                {/* ไล่ดูทีละคนได้โดยไม่ต้องปิด-เปิดใหม่ (เฉพาะคนที่อยู่ในหน้ารายการปัจจุบัน) */}
                {siblings.length > 1 && (
                  <span className="modal-nav">
                    <button className="btn icon-btn" disabled={!prevId} onClick={() => onNavigate?.(prevId)} title="คนก่อนหน้า" aria-label="คนก่อนหน้า">‹</button>
                    <button className="btn icon-btn" disabled={!nextId} onClick={() => onNavigate?.(nextId)} title="คนถัดไป" aria-label="คนถัดไป">›</button>
                  </span>
                )}
                <button className="modal-close" onClick={onClose} aria-label="ปิด">×</button>
              </div>
            </header>

            <div className="modal-body">
              {/* error ที่เกิดหลังโหลดข้อมูลได้แล้ว (เช่น ลบไม่สำเร็จ) — ต้องมีที่ยืนของตัวเอง
                  ไม่งั้นจะถูกกลืนหายไปเพราะเงื่อนไขด้านบนแสดงเฉพาะตอนยังไม่มีข้อมูล */}
              {error && <p className="error">{error}</p>}

              {/* ข้อมูลติดต่อขึ้นก่อนทุกอย่าง — คนส่วนใหญ่เปิด popup นี้มาหาเบอร์โทร */}
              <section>
                <div className="section-head">
                  <h3>ข้อมูลติดต่อ</h3>
                  {!editing && <button className="btn tiny" onClick={() => setEditing(true)}>แก้ด่วน</button>}
                </div>

                {editing ? (
                  <QuickEdit customer={customer} onDone={handleSaved} onCancel={() => setEditing(false)} />
                ) : (
                  <>
                    <div className="field-grid">
                      <Field
                        label="เบอร์มือถือ"
                        value={customer.phone && <a className="link" href={`tel:${customer.phone}`}>{customer.phone}</a>}
                      />
                      <Field
                        label="เบอร์บ้าน"
                        value={customer.home_phone && <a className="link" href={`tel:${customer.home_phone}`}>{customer.home_phone}</a>}
                      />
                      <Field label="Line ID" value={customer.line_id} />
                      <Field
                        label="Email"
                        value={customer.email && <a className="link" href={`mailto:${customer.email}`}>{customer.email}</a>}
                      />
                    </div>
                    <Field label="ที่อยู่" value={fullAddress(customer)} />
                  </>
                )}
              </section>

              <section>
                <h3>ข้อมูลพื้นฐาน</h3>
                <div className="field-grid">
                  <Field label="เพศ / อายุ" value={genderAge} />
                  <Field label="วันเกิด" value={customer.birth_date && formatDate(customer.birth_date)} />
                  <Field label="สถานภาพ" value={MARITAL_STATUS_LABELS[customer.marital_status]} />
                  <Field label="เลขบัตรประชาชน" value={customer.national_id} mono />
                  <Field label="เลข Passport" value={customer.passport_no} mono />
                  <Field label="สัญชาติ" value={customer.nationality} />
                  <Field label="อาชีพ" value={customer.occupation} />
                </div>
              </section>

              <section>
                <h3>ผู้ดูแล / ญาติที่ติดต่อได้</h3>
                <div className="field-grid">
                  <Field label="ชื่อผู้ดูแล" value={customer.emergency_contact_name} />
                  <Field
                    label="เบอร์ผู้ดูแล"
                    value={
                      customer.emergency_contact_phone &&
                      <a className="link" href={`tel:${customer.emergency_contact_phone}`}>{customer.emergency_contact_phone}</a>
                    }
                  />
                </div>
              </section>

              <section>
                <h3>อื่นๆ</h3>
                <div className="field-grid">
                  <Field label="ประเภทลูกค้า" value={customer.customer_type} />
                  <Field label="รู้จักผ่านช่องทาง" value={customer.referral_source} />
                </div>
                <Field label="หมายเหตุ" value={customer.note} />
              </section>

              {/* ผู้รับการดูแลใต้ลูกค้ารายนี้ — ลูกค้าหนึ่งคนดูแลได้หลายคน (พ่อ+แม่) */}
              <section>
                <h3>ผู้รับการดูแล ({customer.patients?.length ?? 0})</h3>
                {(customer.patients?.length ?? 0) === 0 ? (
                  <p className="muted">ยังไม่มีผู้รับการดูแลในความดูแลของลูกค้ารายนี้</p>
                ) : (
                  customer.patients.map((p) => {
                    const age = ageFromBirthDate(p.birth_date) ?? p.age;
                    const meta = [
                      p.relation_to_customer,
                      GENDER_LABELS[p.gender],
                      age != null && `${age} ปี`,
                    ].filter(Boolean).join(' · ');
                    return (
                      <div className="history-item" key={p.patient_id}>
                        <div>
                          <strong>
                            <Link className="link" to={`/patients/${p.patient_id}`}>
                              {p.name}{p.nickname && ` (${p.nickname})`}
                            </Link>
                          </strong>
                          <p className="muted">
                            <span className="mono">{p.patient_id}</span>
                            {meta && ` · ${meta}`}
                          </p>
                        </div>
                        <span className={`badge ${p.status}`}>{PATIENT_STATUS_LABELS[p.status]}</span>
                      </div>
                    );
                  })
                )}
              </section>

              <section>
                <h3>เคสที่เคยใช้บริการ ({customer.cases.length})</h3>
                {/* popup เป็นตัวอย่างย่อ — โชว์ 3 เคสล่าสุด ที่เหลือดูที่หน้าเต็ม */}
                <CustomerCases cases={customer.cases} limit={3} />
              </section>

              <section className="modal-meta">
                <Field label="สร้างเมื่อ" value={formatDate(customer.created_at)} />
                <Field label="แก้ไขล่าสุด" value={formatDate(customer.updated_at)} />
              </section>
            </div>

            <footer className="modal-foot">
              {/* ปุ่มลบดันไปชิดซ้ายสุด แยกออกจากกลุ่มปุ่มที่กดกันจริง — ไม่ให้มือไปโดนตอนเล็งปุ่มข้างๆ */}
              <button className="btn danger-ghost foot-danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'กำลังลบ…' : 'ลบลูกค้า'}
              </button>
              <Link className="btn" to={`/cases/new?customer_id=${customer.customer_id}`}>
                + เปิดเคส
              </Link>
              <Link className="btn" to={`/customers/${customer.customer_id}`}>เปิดหน้าเต็ม</Link>
              <Link className="btn primary" to={`/customers/${customer.customer_id}/edit`}>แก้ไขทั้งหมด</Link>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
