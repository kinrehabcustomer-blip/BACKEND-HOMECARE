import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { api } from '../api.js';
import { ACCEPTED, compressImage, formatFileSize } from '../lib/image.js';

/**
 * ช่องใส่รูปพนักงาน — ฝังในฟอร์มพนักงาน ใช้ปุ่มบันทึกร่วมกับฟอร์ม
 *
 * รูปไม่ถูกอัปโหลดทันทีที่เลือก แต่รอให้พ่อแม่สั่ง save() ตอนกดบันทึก — แบบเดียวกับใบรับรอง/ผลงาน
 * เพราะพนักงานใหม่ยังไม่มีรหัส (EMP-xxxx) จนกว่าจะบันทึกสำเร็จ จึงยังไม่มีที่ให้แนบรูป
 *
 * `saved` = สภาพรูปที่อยู่ในฐานข้อมูลตอนนี้ ({ has_photo, updated_at }) — พนักงานใหม่ส่ง null มา
 */
const PhotoField = forwardRef(function PhotoField({ employeeId, saved }, ref) {
  const [image, setImage] = useState(null);   // data URL ของรูปที่เพิ่งเลือก (ย่อแล้ว) — null = ยังไม่ได้เลือก
  const [removed, setRemoved] = useState(false); // กด "เอารูปออก" กับรูปเดิมไว้ รอมีผลตอนบันทึก
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileInput = useRef(null);

  const hasSaved = Boolean(saved?.has_photo);
  const preview = image ?? (hasSaved && !removed ? api.employeePhotoUrl(employeeId, saved.updated_at) : null);
  const dirty = Boolean(image) || (removed && hasSaved);

  /** ฟอร์มพนักงานเรียกตอนกดปุ่มบันทึก — ไม่ได้แตะรูปเลยก็ไม่ต้องยิงอะไร */
  useImperativeHandle(ref, () => ({
    async save(targetId) {
      if (image) await api.setEmployeePhoto(targetId, image);
      else if (removed && hasSaved) await api.setEmployeePhoto(targetId, null);

      setImage(null);
      setRemoved(false);
      if (fileInput.current) fileInput.current.value = '';
    },
  }));

  async function pickImage(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setBusy(true);
    try {
      setImage(await compressImage(file));
      setRemoved(false); // เลือกรูปใหม่ = ไม่ได้จะลบรูปแล้ว
    } catch (err) {
      setError(err.message);
      e.target.value = '';
    } finally {
      setBusy(false);
    }
  }

  /** มีรูปที่เพิ่งเลือกอยู่ = ยกเลิกการเลือก · ไม่มี = สั่งลบรูปเดิม (มีผลตอนกดบันทึก) */
  function clearImage() {
    if (image) {
      setImage(null);
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setRemoved(true);
  }

  return (
    <div className="photo-field">
      {preview ? (
        <img className="photo-preview" src={preview} alt="รูปพนักงาน" />
      ) : (
        <div className="photo-preview is-blank">ยังไม่มีรูป</div>
      )}

      <div className="photo-side">
        {error && <p className="error">{error}</p>}

        <div className="photo-actions">
          <label className="btn">
            {busy ? 'กำลังย่อรูป…' : preview ? '📎 เปลี่ยนรูป' : '📎 เลือกไฟล์รูป'}
            <input ref={fileInput} type="file" accept={ACCEPTED} hidden disabled={busy} onChange={pickImage} />
          </label>

          {preview && (
            <button type="button" className="btn danger-ghost" onClick={clearImage} disabled={busy}>
              เอารูปออก
            </button>
          )}
          {/* กดลบรูปเดิมพลาดแล้วเอากลับได้ ตราบใดที่ยังไม่กดบันทึก */}
          {removed && hasSaved && !image && (
            <button type="button" className="btn" onClick={() => setRemoved(false)} disabled={busy}>
              เอารูปเดิมกลับ
            </button>
          )}
        </div>

        <p className="muted">
          รองรับ JPG, PNG และ WebP — ระบบย่อรูปให้อัตโนมัติก่อนอัปโหลด
          {image && ` · ขนาดหลังย่อ ${formatFileSize(Math.round((image.length * 3) / 4))}`}
        </p>
        {dirty && <p className="muted">รูปจะถูกบันทึกเมื่อกดปุ่มบันทึกด้านล่าง</p>}
      </div>
    </div>
  );
});

export default PhotoField;
