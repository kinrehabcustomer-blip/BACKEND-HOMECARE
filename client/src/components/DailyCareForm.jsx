import { useMemo, useState } from 'react';
import { DAILY_SECTIONS, dailyValueText, isFilled } from '../lib/dailyCare.js';
import { compressImage } from '../lib/image.js';
import { todayTH } from '../labels.js';
import TimeSelect from './TimeSelect.jsx';
import FileButton from './FileButton.jsx';

/**
 * ฟอร์มบันทึกรายงานแบบมีโครงสร้าง — วาดทุกช่องจากนิยามที่ส่งเข้ามาทาง sections
 *
 * ใช้ได้กับทุกชุดช่องที่ประกาศไว้ใน lib/dailyCare.js (ดูแลประจำวัน / กายภาพบำบัด)
 * ตัวฟอร์มไม่รู้จักช่องไหนเป็นพิเศษเลย — เพิ่มฟอร์มใหม่ = เพิ่มนิยาม ไม่ต้องแตะไฟล์นี้
 *
 * ปุ่มชิปแทน <select> เกือบทั้งฟอร์ม เพราะพนักงานกรอกจากมือถือขณะอยู่หน้างาน
 * การกดชิปหนึ่งครั้งจบเร็วกว่าเปิด dropdown แล้วเลื่อนหา และเห็นทุกตัวเลือกพร้อมกัน
 * (กดชิปที่เลือกอยู่ซ้ำ = ยกเลิกการเลือก — ไม่มีทางกรอกผิดแล้วลบไม่ออก)
 *
 * ก่อนบันทึกมีหน้าตรวจทานสรุปสิ่งที่กรอกไว้ทั้งใบ ไม่ใช่กดส่งจากกลางฟอร์มที่มองไม่เห็นด้านบน
 */

/** ค่าเริ่มต้นของฟอร์ม — ทุกช่อง undefined = ยังไม่กรอก (ไม่ใช่ '' เพื่อให้แยกจาก "ล้างค่า" ได้) */
function toForm(report, sections) {
  const out = {
    report_date: report?.report_date ?? todayTH(),
    report_time: report?.report_time ?? '',
    report_type: report?.report_type ?? 'routine',
  };
  for (const s of sections) {
    for (const f of s.fields) {
      if (f.key in out) continue;
      // รูป: undefined = ยังไม่แตะ (ไม่ส่งคีย์ไป รูปเดิมอยู่ครบ) · null = สั่งลบ · ข้อความ = รูปใหม่
      out[f.key] = f.type === 'photo' ? undefined : (report?.[f.key] ?? (f.type === 'multi' ? [] : ''));
    }
  }
  return out;
}

/** ฟอร์ม -> payload ที่ API รับ (ตัวเลขต้องเป็น number, ช่องว่างเป็น null) */
function toPayload(form, sections) {
  const out = { report_date: form.report_date || null, report_time: form.report_time || null };

  for (const s of sections) {
    for (const f of s.fields) {
      const v = form[f.key];
      if (f.type === 'number') out[f.key] = v === '' || v == null ? null : Number(v);
      else if (f.type === 'multi') out[f.key] = v?.length ? v : null;
      else if (f.type === 'bool') out[f.key] = v === '' || v == null ? null : v;
      else if (f.type === 'photo') { if (v !== undefined) out[f.key] = v; }
      else out[f.key] = typeof v === 'string' && v.trim() ? v.trim() : null;
    }
  }

  // ประเภทรายงานเป็น NOT NULL ในตาราง — ไม่ปล่อยให้กลายเป็น null จากกฎช่องว่างด้านบน
  out.report_type = form.report_type || 'routine';
  return out;
}

/** ปุ่มชิปเลือกค่าเดียว — กดซ้ำที่ค่าเดิม = ยกเลิก */
function Chips({ options, value, onPick, disabled }) {
  return (
    <div className="chip-row">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          className={`chip ${value === o.value ? 'is-on' : ''}`}
          onClick={() => onPick(value === o.value ? '' : o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ field, value, onChange, disabled }) {
  if (field.type === 'choice') {
    return (
      <div className={`care-field ${field.highlight ? 'is-key' : ''}`}>
        <span className="field-label">{field.label}</span>
        <Chips options={field.options} value={value} onPick={onChange} disabled={disabled} />
      </div>
    );
  }

  if (field.type === 'multi') {
    const list = value ?? [];
    return (
      <div className="care-field">
        <span className="field-label">{field.label}</span>
        <div className="chip-row">
          {field.options.map((o) => {
            const on = list.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                disabled={disabled}
                className={`chip ${on ? 'is-on' : ''}`}
                onClick={() => onChange(on ? list.filter((v) => v !== o.value) : [...list, o.value])}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (field.type === 'bool') {
    // สามสถานะ: ทำแล้ว / ไม่ได้ทำ / ยังไม่ระบุ — ไม่ใช้ checkbox เพราะมันแยก "ไม่ได้ทำ" กับ "ยังไม่ได้กรอก" ไม่ได้
    return (
      <div className="care-field">
        <span className="field-label">{field.label}</span>
        <Chips
          options={[
            { value: true, label: field.yes ?? 'ทำแล้ว' },
            { value: false, label: field.no ?? 'ไม่ได้ทำ' },
          ]}
          value={value}
          onPick={onChange}
          disabled={disabled}
        />
      </div>
    );
  }

  if (field.type === 'number') {
    return (
      <label className="care-num">
        {field.label} <span className="muted">({field.unit})</span>
        <input
          type="number"
          inputMode="decimal"
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        {field.hint && <span className="care-hint">{field.hint}</span>}
      </label>
    );
  }

  if (field.type === 'time') {
    return (
      <div className="care-field care-time">
        <span className="field-label">{field.label}</span>
        <TimeSelect label={field.label} value={value} disabled={disabled} onChange={onChange} />
      </div>
    );
  }

  return (
    <label className="report-text">
      {field.label}
      <textarea
        rows={field.rows ?? 2}
        value={value}
        placeholder={field.placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** รูปแผล — ย่อในเบราว์เซอร์ก่อนส่ง (เหมือนเซลฟี่เช็คอิน) ที่นี่เก็บเป็น data URL ในฟอร์ม */
function PhotoField({ field, value, existingUrl, onChange, disabled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function pick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      onChange(await compressImage(file));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // ยังไม่แตะ = โชว์รูปเดิมที่บันทึกไว้ · สั่งลบแล้ว (null) = ไม่โชว์อะไร · มีรูปใหม่ = โชว์รูปใหม่
  const src = value === undefined ? existingUrl : value;

  return (
    <div className="care-field">
      <span className="field-label">{field.label}</span>
      {src ? (
        <div className="checkin-photo-preview">
          <img src={src} alt="รูปแผล" />
          <button type="button" className="btn tiny danger-ghost" disabled={disabled} onClick={() => onChange(null)}>
            เอารูปออก
          </button>
        </div>
      ) : (
        <FileButton icon="camera" capture="environment" busy={busy} onPick={pick}>
          ถ่ายรูป / เลือกรูป
        </FileButton>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Section({ section, form, set, disabled, photoUrl }) {
  // หมวดที่พับไว้ต้องกางเองถ้าใบนี้มีข้อมูลอยู่แล้ว ไม่งั้นเปิดมาแก้จะไม่เห็นว่ากรอกอะไรไว้
  const hasData = section.fields.some((f) => isFilled(form[f.key]));
  const [open, setOpen] = useState(!section.collapsed || hasData);

  const body = (
    <div className={`care-grid ${section.columns === 4 ? 'cols-4' : ''}`}>
      {section.fields.map((f) =>
        f.type === 'photo' ? (
          <PhotoField
            key={f.key}
            field={f}
            value={form[f.key]}
            existingUrl={photoUrl}
            disabled={disabled}
            onChange={(v) => set(f.key, v)}
          />
        ) : (
          <Field key={f.key} field={f} value={form[f.key]} disabled={disabled} onChange={(v) => set(f.key, v)} />
        ),
      )}
    </div>
  );

  return (
    <section className={`care-section ${section.highlight ? 'is-key' : ''}`}>
      <button type="button" className="care-section-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{section.title}</span>
        <span className="care-toggle">{open ? '−' : '+'}</span>
      </button>
      {section.hint && open && <p className="care-hint">{section.hint}</p>}
      {open && body}
    </section>
  );
}

/** หน้าตรวจทานก่อนส่ง — เห็นทั้งใบในหน้าเดียวว่ากำลังจะบันทึกอะไร */
function Review({ form, sections }) {
  const filled = useMemo(
    () =>
      sections.map((s) => ({
        ...s,
        rows: s.fields
          .map((f) => [f, dailyValueText(f, form[f.key] === '' ? null : form[f.key])])
          .filter(([, text]) => text != null),
      })).filter((s) => s.rows.length > 0),
    [form, sections],
  );

  return (
    <div className="care-review">
      {filled.map((s) => (
        <div key={s.key} className="care-review-block">
          <h5>{s.title}</h5>
          <ul>
            {s.rows.map(([f, text]) => (
              <li key={f.key}>
                <span className="field-label">{f.label}</span>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default function DailyCareForm({
  initial,
  sections = DAILY_SECTIONS,
  busy,
  error,
  photoUrl = null,
  onSubmit,
  onCancel,
}) {
  const [form, setForm] = useState(() => toForm(initial, sections));
  const [reviewing, setReviewing] = useState(false);
  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  // ยังไม่ได้กรอกอะไรเลย = ยังส่งไม่ได้ (server ปฏิเสธใบเปล่าอยู่แล้ว แต่รู้ตั้งแต่ก่อนกดดีกว่า)
  const blank = !sections.some((s) =>
    s.fields.some((f) => f.key !== 'report_type' && f.key !== 'shift' && isFilled(form[f.key])),
  );

  return (
    <form
      className="report-form care-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reviewing) return setReviewing(true);
        onSubmit(toPayload(form, sections));
      }}
    >
      {error && <p className="error">{error}</p>}

      <div className="grid cols-2 report-when">
        <label>วันที่<input type="date" value={form.report_date} max={todayTH()} disabled={busy} onChange={(e) => set('report_date', e.target.value)} /></label>
        <label>เวลาบันทึก
          <TimeSelect label="เวลาบันทึก" value={form.report_time} disabled={busy} onChange={(v) => set('report_time', v)} />
        </label>
      </div>

      {reviewing ? (
        <>
          <h4 className="report-form-head">ตรวจทานก่อนส่ง</h4>
          <Review form={form} sections={sections} />
        </>
      ) : (
        sections.map((s) => (
          <Section key={s.key} section={s} form={form} set={set} disabled={busy} photoUrl={photoUrl} />
        ))
      )}

      <div className="quick-edit-actions">
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => (reviewing ? setReviewing(false) : onCancel())}
        >
          {reviewing ? 'กลับไปแก้' : 'ยกเลิก'}
        </button>
        <button className="btn primary" type="submit" disabled={busy || blank}>
          {busy ? 'กำลังบันทึก…' : reviewing ? 'ยืนยันและส่งรายงาน' : 'ตรวจทานก่อนส่ง'}
        </button>
      </div>
    </form>
  );
}
