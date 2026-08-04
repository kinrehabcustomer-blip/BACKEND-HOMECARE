import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from '../api.js';
import FileButton from './FileButton.jsx';
import { ACCEPTED, compressImage, formatFileSize } from '../lib/image.js';
import { formatDate } from '../labels.js';

const BLANK_CERT = { name: '', issuer: '', issued_date: '', expiry_date: '' };

/**
 * ส่วนใบรับรอง/ใบประกอบวิชาชีพ — ฝังอยู่ในฟอร์มพนักงาน ไม่มีปุ่มบันทึกของตัวเอง
 *
 * ใบใหม่: กรอกในช่องทิ้งไว้ได้เลย ปุ่ม "บันทึก" ของฟอร์มพนักงานจะบันทึกให้พร้อมกันทีเดียว
 * ใบที่บันทึกแล้ว: แนบ/เปลี่ยน/ลบรูป และลบใบ มีผลทันที เพราะเป็นการแก้ของที่มีอยู่จริง
 */
const CertificateSection = forwardRef(function CertificateSection({ employeeId }, ref) {
  const [certificates, setCertificates] = useState([]);
  const [cert, setCert] = useState(BLANK_CERT);
  const [image, setImage] = useState(null); // data URL ของรูปที่เลือกไว้ (ย่อแล้ว)
  const [pending, setPending] = useState([]); // ใบที่กด "+ เพิ่ม" ไว้ รอบันทึกพร้อมฟอร์ม
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileInput = useRef(null);

  const reload = () => {
    if (!employeeId) return Promise.resolve(); // พนักงานใหม่ยังไม่มีรหัส จึงยังไม่มีใบรับรองให้โหลด
    return api.listCertificates(employeeId).then(setCertificates).catch((err) => setError(err.message));
  };

  useEffect(() => {
    reload();
  }, [employeeId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** แปลงค่าในช่องกรอกเป็นข้อมูลพร้อมส่ง (ช่องว่าง -> null) */
  const toPayload = (c) =>
    Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === '' ? null : v]));

  /**
   * ฟอร์มพนักงาน (พ่อแม่) เรียกตอนกดปุ่มบันทึก
   * บันทึกทั้งใบที่กด "+ เพิ่ม" ไว้ และใบที่ยังค้างอยู่ในช่องกรอก (กันผู้ใช้ลืมกดเพิ่มแล้วข้อมูลหาย)
   */
  useImperativeHandle(ref, () => ({
    async save(targetId) {
      const queue = [...pending];
      if (cert.name.trim()) queue.push({ ...cert, image });

      try {
        while (queue.length) {
          const { key, image: img, ...rest } = queue[0];
          await api.addCertificate(targetId, { ...toPayload(rest), image: img });
          queue.shift(); // ตัดออกทีละใบ ถ้าพังกลางคันใบที่ลงไปแล้วจะไม่ถูกส่งซ้ำ
        }
        setCert(BLANK_CERT);
        clearImage();
      } finally {
        setPending(queue);
      }
    },
  }));

  /** "+ เพิ่ม" — เก็บใบเข้าคิวในหน้าจอเท่านั้น ยังไม่แตะฐานข้อมูล */
  function stageCertificate() {
    // ตรวจเองเพราะปุ่มนี้ไม่ใช่ submit ของฟอร์ม (ซ้อน <form> ในฟอร์มไม่ได้) จึงไม่มี required ช่วย
    if (!cert.name.trim()) {
      setError('กรุณากรอกชื่อใบรับรองก่อนกดเพิ่ม');
      return;
    }

    setError(null);
    setPending((list) => [...list, { ...cert, image, key: crypto.randomUUID() }]);
    setCert(BLANK_CERT);
    clearImage();
  }

  const unstage = (key) => setPending((list) => list.filter((c) => c.key !== key));

  /**
   * "แก้ไข" ใบที่รอบันทึกอยู่ — ดึงกลับมาใส่ช่องกรอกเพื่อแก้ แล้วกด "+ เพิ่ม" ใส่คิวใหม่
   * ถ้ากำลังกรอกใบอื่นค้างอยู่ในช่อง จะเก็บใบนั้นเข้าคิวให้ก่อน ไม่ให้ข้อมูลที่พิมพ์ไว้หาย
   */
  function editPending(key) {
    const target = pending.find((c) => c.key === key);
    if (!target) return;

    setError(null);
    setPending((list) => {
      const rest = list.filter((c) => c.key !== key);
      return cert.name.trim() ? [...rest, { ...cert, image, key: crypto.randomUUID() }] : rest;
    });

    const { key: _, image: img, ...fields } = target;
    setCert(fields);
    setImage(img);
    if (fileInput.current) fileInput.current.value = '';
  }

  /** ย่อรูปทันทีที่เลือก จะได้เห็นพรีวิวและรู้ขนาดจริงก่อนบันทึก */
  async function pickImage(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setBusy(true);
    try {
      setImage(await compressImage(file));
    } catch (err) {
      setError(err.message);
      e.target.value = ''; // ล้างไฟล์ที่เลือกไม่สำเร็จ ไม่งั้นเลือกไฟล์เดิมซ้ำจะไม่ทำงาน
    } finally {
      setBusy(false);
    }
  }

  const clearImage = () => {
    setImage(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  /** แนบ/เปลี่ยนรูปของใบที่บันทึกไปแล้ว — มีผลทันที */
  async function attachImage(certificateId, file) {
    setError(null);
    setBusy(true);
    try {
      await api.setCertificateImage(employeeId, certificateId, await compressImage(file));
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeImage(certificateId) {
    if (!confirm('ลบรูปของใบรับรองนี้? (ตัวใบรับรองยังอยู่)')) return;
    await api.setCertificateImage(employeeId, certificateId, null);
    reload();
  }

  async function removeCertificate(c) {
    if (!confirm(`ลบใบรับรอง "${c.name}"?${c.has_image ? '\nรูปที่แนบไว้จะถูกลบไปด้วย' : ''}`)) return;
    await api.deleteCertificate(employeeId, c.certificate_id);
    reload();
  }

  return (
    <>
      <h2>ใบรับรอง / ใบประกอบวิชาชีพ</h2>
      {error && <p className="error">{error}</p>}

      {certificates.length === 0 && <p className="muted">ยังไม่มีใบรับรอง</p>}

      {/* ใบที่บันทึกแล้ว */}
      {certificates.map((c) => (
        <div className="cert" key={c.certificate_id}>
          {c.has_image ? (
            <a
              className="cert-thumb"
              href={api.certificateImageUrl(employeeId, c.certificate_id)}
              target="_blank"
              rel="noreferrer"
              title="กดเพื่อดูรูปเต็ม"
            >
              <img src={api.certificateImageUrl(employeeId, c.certificate_id)} alt={`รูป ${c.name}`} />
            </a>
          ) : (
            <label className="cert-thumb empty" title="แนบรูปใบรับรอง">
              <span>+ แนบรูป</span>
              <input
                type="file"
                accept={ACCEPTED}
                hidden
                disabled={busy}
                onChange={(e) => e.target.files?.[0] && attachImage(c.certificate_id, e.target.files[0])}
              />
            </label>
          )}

          <div className="cert-info">
            <strong>{c.name}</strong>
            <p className="muted">
              {c.issuer ?? 'ไม่ระบุผู้ออก'} · ออกเมื่อ {formatDate(c.issued_date)}
              {c.expiry_date && ` · หมดอายุ ${formatDate(c.expiry_date)}`}
            </p>
            {c.has_image && (
              <p className="muted">
                รูป {formatFileSize(c.image_size)}
                {' · '}
                <label className="inline-link">
                  เปลี่ยนรูป
                  <input
                    type="file"
                    accept={ACCEPTED}
                    hidden
                    disabled={busy}
                    onChange={(e) => e.target.files?.[0] && attachImage(c.certificate_id, e.target.files[0])}
                  />
                </label>
                {' · '}
                <button
                  type="button"
                  className="inline-link danger"
                  onClick={() => removeImage(c.certificate_id)}
                >
                  ลบรูป
                </button>
              </p>
            )}
          </div>

          <button
            type="button"
            className="btn danger-ghost"
            onClick={() => removeCertificate(c)}
            disabled={busy}
          >
            ลบ
          </button>
        </div>
      ))}

      {/* ใบที่กด "+ เพิ่ม" ไว้ — ยังไม่มีอยู่จริงในฐานข้อมูล จะถูกบันทึกพร้อมฟอร์ม */}
      {pending.map((c) => (
        <div className="cert pending" key={c.key}>
          {c.image ? (
            <img className="cert-thumb" src={c.image} alt={`รูป ${c.name}`} />
          ) : (
            <div className="cert-thumb empty"><span>ไม่มีรูป</span></div>
          )}

          <div className="cert-info">
            <strong>{c.name}</strong>
            <p className="muted">
              {c.issuer || 'ไม่ระบุผู้ออก'} · ออกเมื่อ {formatDate(c.issued_date)}
              {c.expiry_date && ` · หมดอายุ ${formatDate(c.expiry_date)}`}
            </p>
          </div>

          <span className="badge probation">รอบันทึก</span>
          <button type="button" className="btn" onClick={() => editPending(c.key)} disabled={busy}>
            แก้ไข
          </button>
          <button type="button" className="btn danger-ghost" onClick={() => unstage(c.key)} disabled={busy}>
            เอาออก
          </button>
        </div>
      ))}

      {/* ช่องกรอกใบใหม่ — กด "+ เพิ่ม" เพื่อใส่ทีละหลายใบ (ยังไม่บันทึก) */}
      <div className="cert-form">
        <input
          placeholder="ชื่อใบรับรอง"
          value={cert.name} onChange={(e) => setCert({ ...cert, name: e.target.value })}
        />
        <input
          placeholder="ผู้ออกใบรับรอง"
          value={cert.issuer} onChange={(e) => setCert({ ...cert, issuer: e.target.value })}
        />
        <input
          type="date" title="วันที่ออก"
          value={cert.issued_date} onChange={(e) => setCert({ ...cert, issued_date: e.target.value })}
        />
        <input
          type="date" title="วันหมดอายุ"
          value={cert.expiry_date} onChange={(e) => setCert({ ...cert, expiry_date: e.target.value })}
        />
        <button className="btn" type="button" onClick={stageCertificate} disabled={busy}>
          + เพิ่ม
        </button>
      </div>

      <div className="cert-upload">
        {image ? (
          <>
            <img className="cert-preview" src={image} alt="ตัวอย่างรูปที่จะแนบ" />
            <div>
              <p className="muted">
                รูปพร้อมแนบ · {formatFileSize(Math.round((image.length * 3) / 4))} (ย่อให้อัตโนมัติแล้ว)
              </p>
              <button type="button" className="inline-link danger" onClick={clearImage}>
                เอารูปออก
              </button>
            </div>
          </>
        ) : (
          <FileButton ref={fileInput} busy={busy} onPick={pickImage}>
            แนบรูปใบรับรอง <span className="file-btn-hint">(ไม่บังคับ)</span>
          </FileButton>
        )}
      </div>

      {pending.length > 0 && (
        <p className="muted cert-hint">
          มี {pending.length} ใบรอบันทึก — จะถูกบันทึกพร้อมกันเมื่อกดปุ่มบันทึกด้านล่าง
        </p>
      )}
    </>
  );
});

export default CertificateSection;
