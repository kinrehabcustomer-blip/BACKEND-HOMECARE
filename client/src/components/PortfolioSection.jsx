import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import ConfirmButton from './ConfirmButton.jsx';
import { api } from '../api.js';
import FileButton from './FileButton.jsx';
import { compressImage, formatFileSize } from '../lib/image.js';

const BLANK = { title: '', description: '' };

/**
 * ผลงานของพนักงาน (โปรไฟล์) — ฝังในฟอร์มพนักงาน ใช้ปุ่มบันทึกร่วมกับฟอร์ม
 *
 * ผลงานใหม่: กด "+ เพิ่ม" เก็บเข้าคิว (ยังไม่แตะ DB) แล้วพ่อแม่สั่ง save() ตอนกดบันทึก
 * ผลงานที่บันทึกแล้ว: ลบได้ทันที (แก้ไขไม่ได้ — ลบแล้วอัปโหลดใหม่ ง่ายกว่าและตรงกับการใช้งานจริง)
 */
const PortfolioSection = forwardRef(function PortfolioSection({ employeeId }, ref) {
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState(BLANK);
  const [image, setImage] = useState(null); // data URL ของรูปที่เลือกไว้ (ย่อแล้ว)
  const [pending, setPending] = useState([]); // ผลงานที่กด "+ เพิ่ม" ไว้ รอบันทึกพร้อมฟอร์ม
  const [editing, setEditing] = useState(null); // { portfolio_id, title, description } ของชิ้นที่กำลังแก้
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileInput = useRef(null);

  const reload = () => {
    if (!employeeId) return Promise.resolve(); // พนักงานใหม่ยังไม่มีรหัส
    return api.listPortfolio(employeeId).then(setItems).catch((err) => setError(err.message));
  };

  useEffect(() => {
    reload();
  }, [employeeId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** ฟอร์มพนักงานเรียกตอนกดปุ่มบันทึก — บันทึกทั้งที่อยู่ในคิวและที่กรอกค้างไว้ */
  useImperativeHandle(ref, () => ({
    /** มีผลงานที่ยังไม่ได้บันทึกค้างอยู่ไหม — ฟอร์มใช้เตือนก่อนออกจากหน้า */
    dirty: () => pending.length > 0 || draft.title.trim() !== '' || Boolean(image),

    async save(targetId) {
      const queue = [...pending];
      if (draft.title.trim() && image) queue.push({ ...draft, image, key: 'draft' });

      try {
        while (queue.length) {
          const { key, ...payload } = queue[0];
          await api.addPortfolio(targetId, {
            ...payload,
            description: payload.description || null,
          });
          queue.shift(); // ตัดออกทีละชิ้น ถ้าพังกลางคันชิ้นที่ลงไปแล้วจะไม่ถูกส่งซ้ำ
        }
        setDraft(BLANK);
        clearImage();
      } finally {
        setPending(queue.filter((c) => c.key !== 'draft'));
      }
    },
  }));

  async function pickImage(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setBusy(true);
    try {
      setImage(await compressImage(file));
    } catch (err) {
      setError(err.message);
      e.target.value = '';
    } finally {
      setBusy(false);
    }
  }

  const clearImage = () => {
    setImage(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  /** "+ เพิ่ม" — เก็บเข้าคิวในหน้าจอเท่านั้น ยังไม่แตะฐานข้อมูล */
  function stage() {
    if (!draft.title.trim()) {
      setError('กรุณากรอกชื่อผลงานก่อนกดเพิ่ม');
      return;
    }
    if (!image) {
      setError('ผลงานต้องมีรูป — กรุณาแนบไฟล์รูปก่อน');
      return;
    }

    setError(null);
    setPending((list) => [...list, { ...draft, image, key: crypto.randomUUID() }]);
    setDraft(BLANK);
    clearImage();
  }

  const unstage = (key) => setPending((list) => list.filter((c) => c.key !== key));

  /** ดึงผลงานในคิวกลับมาแก้ — เก็บที่กรอกค้างไว้เข้าคิวก่อน ไม่ให้ข้อมูลหาย */
  function editPending(key) {
    const target = pending.find((c) => c.key === key);
    if (!target) return;

    setError(null);
    setPending((list) => {
      const rest = list.filter((c) => c.key !== key);
      return draft.title.trim() && image
        ? [...rest, { ...draft, image, key: crypto.randomUUID() }]
        : rest;
    });

    const { key: _, image: img, ...fields } = target;
    setDraft(fields);
    setImage(img);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function remove(item) {
    await api.deletePortfolio(employeeId, item.portfolio_id);
    reload();
  }

  /** แก้ชื่อ/คำอธิบายของผลงานที่บันทึกแล้ว — มีผลทันที (เป็นการแก้ของที่มีอยู่จริง) */
  async function saveEdit() {
    if (!editing.title.trim()) {
      setError('กรุณากรอกชื่อผลงาน');
      return;
    }

    setError(null);
    setBusy(true);
    try {
      await api.updatePortfolio(employeeId, editing.portfolio_id, {
        title: editing.title,
        description: editing.description || null,
      });
      setEditing(null);
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>ผลงาน</h2>
      {error && <p className="error">{error}</p>}

      {items.length === 0 && pending.length === 0 && <p className="muted">ยังไม่มีผลงาน</p>}

      {/* ผลงานที่บันทึกแล้ว */}
      <div className="portfolio-grid">
        {items.map((item) => {
          const isEditing = editing?.portfolio_id === item.portfolio_id;

          return (
            <figure className="portfolio-item" key={item.portfolio_id}>
              <a
                href={api.portfolioImageUrl(employeeId, item.portfolio_id)}
                target="_blank"
                rel="noreferrer"
                title="กดเพื่อดูรูปเต็ม"
              >
                <img src={api.portfolioImageUrl(employeeId, item.portfolio_id)} alt={item.title} />
              </a>

              {isEditing ? (
                /* แก้ได้เฉพาะชื่อกับคำอธิบาย — รูปเปลี่ยนไม่ได้ (ลบแล้วอัปโหลดใหม่) */
                <>
                  <figcaption className="portfolio-edit">
                    <input
                      autoFocus
                      placeholder="ชื่อผลงาน"
                      value={editing.title}
                      onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                    />
                    <input
                      placeholder="คำอธิบาย (ไม่บังคับ)"
                      value={editing.description}
                      onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                    />
                  </figcaption>
                  <div className="portfolio-actions">
                    <button type="button" className="btn primary" onClick={saveEdit} disabled={busy}>
                      {busy ? 'กำลังบันทึก…' : 'บันทึก'}
                    </button>
                    <button type="button" className="btn" onClick={() => setEditing(null)} disabled={busy}>
                      ยกเลิก
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <figcaption>
                    <strong>{item.title}</strong>
                    {item.description && <p className="muted">{item.description}</p>}
                    <p className="muted">{formatFileSize(item.image_size)}</p>
                  </figcaption>
                  <div className="portfolio-actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        setEditing({
                          portfolio_id: item.portfolio_id,
                          title: item.title,
                          description: item.description ?? '',
                        })
                      }
                      disabled={busy}
                    >
                      แก้ไข
                    </button>
                    <ConfirmButton
                      className="btn danger-ghost"
                      disabled={busy}
                      title={`ลบผลงาน "${item.title}"?`}
                      detail="รูปที่แนบไว้จะถูกลบไปด้วย และกู้คืนไม่ได้"
                      confirmLabel="ลบผลงาน"
                      onConfirm={() => remove(item)}
                    >
                      ลบ
                    </ConfirmButton>
                  </div>
                </>
              )}
            </figure>
          );
        })}

        {/* ผลงานที่รอบันทึก */}
        {pending.map((item) => (
          <figure className="portfolio-item pending" key={item.key}>
            <img src={item.image} alt={item.title} />
            <figcaption>
              <strong>{item.title}</strong>
              {item.description && <p className="muted">{item.description}</p>}
              <span className="badge probation">รอบันทึก</span>
            </figcaption>
            <div className="portfolio-actions">
              <button type="button" className="btn" onClick={() => editPending(item.key)} disabled={busy}>
                แก้ไข
              </button>
              <button type="button" className="btn danger-ghost" onClick={() => unstage(item.key)} disabled={busy}>
                เอาออก
              </button>
            </div>
          </figure>
        ))}
      </div>

      {/* ช่องกรอกผลงานใหม่ */}
      <div className="portfolio-form">
        <input
          placeholder="ชื่อผลงาน"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
        <input
          placeholder="คำอธิบาย (ไม่บังคับ)"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />

        {image ? (
          <div className="portfolio-preview">
            <img src={image} alt="ตัวอย่างผลงาน" />
            <span className="muted">{formatFileSize(Math.round((image.length * 3) / 4))}</span>
            <button type="button" className="inline-link danger" onClick={clearImage}>เอารูปออก</button>
          </div>
        ) : (
          <FileButton ref={fileInput} busy={busy} onPick={pickImage}>เลือกไฟล์รูปผลงาน</FileButton>
        )}

        <button className="btn" type="button" onClick={stage} disabled={busy}>+ เพิ่ม</button>
      </div>

      {pending.length > 0 && (
        <p className="muted cert-hint">
          มี {pending.length} ผลงานรอบันทึก — จะถูกบันทึกพร้อมกันเมื่อกดปุ่มบันทึกด้านล่าง
        </p>
      )}
    </>
  );
});

export default PortfolioSection;
