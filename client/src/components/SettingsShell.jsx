/**
 * โครงหน้าตั้งค่าแบบเมนูซ้าย + แผงขวา (ผู้ใช้ขอ 19 พ.ย. 2569 — แบบเดียวกับหน้า "บัญชีธนาคาร / เครื่อง EDC")
 * ใช้สองที่: หน้าตั้งค่า (SettingsPage) และเมนู "หมวดหมู่" (CategoriesPage)
 *
 * groups = [{ label, items: [{ key, label }] }] · active = key ที่เลือกอยู่ · onSelect(key)
 * จอแคบ (≤ 900px) เมนูกลายเป็นแถบเลื่อนแนวนอนด้านบน (ซ่อนหัวกลุ่ม) — แผงขวาเต็มความกว้าง
 */
export default function SettingsShell({ groups, active, onSelect, label = 'หมวดการตั้งค่า', children }) {
  return (
    <div className="set-shell">
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
