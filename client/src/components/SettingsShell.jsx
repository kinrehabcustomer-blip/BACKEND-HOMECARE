import SearchSelect from './SearchSelect.jsx';

/**
 * โครงหน้าตั้งค่าแบบเมนูซ้าย + แผงขวา (ผู้ใช้ขอ 19 พ.ย. 2569 — แบบเดียวกับหน้า "บัญชีธนาคาร / เครื่อง EDC")
 * ใช้สองที่: หน้าตั้งค่า (SettingsPage) และเมนู "หมวดหมู่" (CategoriesPage)
 *
 * groups = [{ label, items: [{ key, label, icon? }] }] · icon = svg ตกแต่งหน้าชื่อในเมนูซ้าย (aria-hidden) · active = key ที่เลือกอยู่ · onSelect(key)
 * จอแคบ (≤ 900px): เมนูซ้ายซ่อน ใช้ช่องเลือกหัวข้อ (.set-picker · จัดกลุ่มตามหัวกลุ่ม) แทน — ผู้ใช้ขอ 20 พ.ย. 2569
 *   เดิมเป็นแถบเลื่อนแนวนอนที่หัวข้อท้ายๆ ถูกตัดขอบ ("หมวดเหตุกา…") ไม่รู้ว่ามีอะไรอีก และไม่เห็นหัวกลุ่ม
 *   ช่องเลือกรวมเป็นการ์ดเดียวกับแถบค้นหา/ตัวกรองของแผง (ถ้ามี) — จัดด้วย CSS ไม่ได้ย้ายตัวกรองออกจากแผง
 */
export default function SettingsShell({ groups, active, onSelect, label = 'หมวดการตั้งค่า', children }) {
  return (
    <div className="set-shell">
      <div className="set-picker">
        <span className="set-picker-label">{label}</span>
        <SearchSelect value={active} searchable={false} aria-label={label} onChange={(e) => onSelect(e.target.value)}>
          {groups.filter((g) => g.items.length > 0).map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map((it) => <option key={it.key} value={it.key}>{it.label}</option>)}
            </optgroup>
          ))}
        </SearchSelect>
      </div>
      <nav className="set-nav" aria-label={label}>
        {groups.filter((g) => g.items.length > 0).map((g) => (
          <div className="set-nav-group" key={g.label}>
            <p className="set-nav-head">{g.label}</p>
            {g.items.map((it) => (
              <button
                key={it.key}
                type="button"
                className={`set-nav-item${it.key === active ? ' is-on' : ''}`}
                aria-current={it.key === active ? 'page' : undefined}
                onClick={() => onSelect(it.key)}
              >
                {/* icon = ไอคอนตกแต่งหน้าชื่อ (ไม่บังคับ — หน้าตั้งค่าส่งมา ดีไซน์ v2) */}
                {it.icon}
                {it.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="set-main">{children}</div>
    </div>
  );
}

/** หัวแผงขวา — ชื่อ + คำอธิบาย · action = ปุ่มด้านขวา (เช่น "+ เพิ่มหมวดหลัก") */
export function SettingsPaneHead({ title, desc, action = null }) {
  return (
    <header className="set-pane-head">
      <div>
        <h2>{title}</h2>
        {desc && <p className="muted">{desc}</p>}
      </div>
      {action}
    </header>
  );
}
