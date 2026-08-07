import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import PasswordInput from './PasswordInput.jsx';

/** ฟอร์มเปลี่ยนรหัสผ่าน — ใช้ในหน้าตั้งค่า */
export default function ChangePasswordForm() {
  const { user, setUser } = useAuth();

  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (password !== confirm) return setError('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');

    setBusy(true);
    setError(null);
    try {
      await api.changePassword({ current_password: current, new_password: password });
      setUser({ ...user, must_change_password: false }); // แถบเตือนบนหน้าจอจะหายไปทันที
      setCurrent('');
      setPassword('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form narrow" onSubmit={handleSubmit}>
      {done && <p className="notice">เปลี่ยนรหัสผ่านเรียบร้อยแล้ว ครั้งต่อไปเข้าสู่ระบบด้วยรหัสผ่านใหม่</p>}
      {error && <p className="error">{error}</p>}

      <label>
        รหัสผ่านปัจจุบัน
        <PasswordInput
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => {
            setCurrent(e.target.value);
            setDone(false);
          }}
        />
      </label>

      <label>
        รหัสผ่านใหม่
        <PasswordInput
          autoComplete="new-password"
          required
          minLength={8}
          placeholder="อย่างน้อย 8 ตัวอักษร"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>

      <label>
        ยืนยันรหัสผ่านใหม่
        <PasswordInput
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>

      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'กำลังบันทึก…' : 'เปลี่ยนรหัสผ่าน'}
        </button>
      </div>
    </form>
  );
}
