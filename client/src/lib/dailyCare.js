/**
 * นิยามของ "แบบบันทึกการดูแลประจำวัน" — โครงสร้างเดียวใช้ทั้งตอนกรอกและตอนแสดงผล
 *
 * ฟอร์มนี้มี 80 กว่าช่อง ถ้าเขียน JSX ทีละช่องสองรอบ (ฟอร์ม + หน้าดู) จะกลายเป็นสองพันบรรทัด
 * ที่ต้องแก้คู่กันตลอดไป และวันหนึ่งจะมีช่องที่กรอกได้แต่ไม่โผล่ในหน้าดู (หรือกลับกัน)
 * ประกาศไว้ที่เดียวแล้วให้ทั้งสองฝั่งวาดจากตัวนี้ — เพิ่มช่องใหม่ = แก้ไฟล์นี้ไฟล์เดียว
 *
 * รหัสของตัวเลือกต้องตรงกับ CHECK ในตาราง + zod ฝั่ง server เป๊ะ (คำไทยอยู่ที่นี่ที่เดียว)
 */

/** ประเภทเคสที่ใช้ฟอร์มเต็ม — เคสอื่นใช้ฟอร์มสั้น (สัญญาณชีพ + อาการ) เหมือนเดิม */
const DAILY_CASE_TYPES = ['elderly_care', 'bedridden_care', 'post_op_care'];

/**
 * เคสนี้ใช้แบบบันทึกประจำวันไหม — ต้องเป็นงานดูแลต่อเนื่องสาย Homecare เท่านั้น
 * กายภาพบำบัด/เฝ้าไข้/พาไปหาหมอ เป็นงานครั้งคราว ไม่มี NG/ขับถ่าย/เปลี่ยนท่าให้บันทึกทุกเวร
 * เคสเก่าที่ service_kind ยังว่างถือเป็น Homecare (เกณฑ์เดียวกับที่ใช้ตัดสินเรื่องตารางกะ)
 */
export const usesDailyRecord = (c) =>
  Boolean(c) &&
  DAILY_CASE_TYPES.includes(c.case_type) &&
  c.service_kind !== 'physio' &&
  c.physio_package_id == null;

const opts = (...pairs) => pairs.map(([value, label]) => ({ value, label }));

const DONE_NA = opts(['done', 'ทำแล้ว'], ['not_done', 'ไม่ได้ทำ'], ['na', 'ไม่เกี่ยวข้อง']);
const DEVICE_STATE = opts(['ok', 'ปกติ'], ['problem', 'ผิดปกติ'], ['na', 'ไม่มี']);

/** เหตุการณ์ผิดปกติที่พบบ่อย — เลือกได้หลายข้อพร้อมกัน (ล้มแล้วมีเลือดออกก็ติ๊กทั้งสอง) */
export const INCIDENT_TYPES = opts(
  ['fall', 'ล้ม / เกือบล้ม'],
  ['breathing', 'หายใจลำบาก'],
  ['spo2', 'ออกซิเจนต่ำผิดปกติ'],
  ['consciousness', 'ระดับความรู้สึกตัวเปลี่ยน'],
  ['fever', 'ไข้'],
  ['seizure', 'ชัก'],
  ['vomiting', 'อาเจียน'],
  ['sputum', 'เสมหะผิดปกติ'],
  ['bleeding', 'เลือดออก'],
  ['tube', 'สาย NG/PEG/Foley/Trach มีปัญหา'],
  ['urine', 'ปัสสาวะลดลงผิดปกติ'],
  ['wound', 'แผล/รอยแดงใหม่'],
  ['med_error', 'ความผิดพลาดเรื่องยา'],
  ['equipment', 'อุปกรณ์ขัดข้อง'],
  ['other', 'อื่นๆ'],
);

/**
 * หมวดของฟอร์ม
 *   collapsed: true = พับไว้ก่อน (หมวดที่มีเฉพาะบางเคส เช่น เจาะคอ/ให้อาหารทางสาย)
 *              เปิดเองอัตโนมัติถ้าใบนั้นมีข้อมูลอยู่แล้ว
 *   highlight: true = กรอบเน้น (คำถามที่สำคัญที่สุดของฟอร์ม)
 *
 * ชนิดช่อง: choice (เลือกหนึ่ง) · multi (เลือกหลาย) · bool (ทำแล้ว/ไม่ได้ทำ) ·
 *          number (ตัวเลข + หน่วย) · text (ข้อความ) · photo (รูป)
 */
export const DAILY_SECTIONS = [
  {
    key: 'work',
    title: 'ข้อมูลการปฏิบัติงาน',
    fields: [
      {
        key: 'shift',
        label: 'เวร',
        type: 'choice',
        options: opts(['day', 'เช้า 07:00–19:00'], ['night', 'ดึก 19:00–07:00'], ['other', 'อื่นๆ']),
      },
      {
        key: 'report_type',
        label: 'ประเภทรายงาน',
        type: 'choice',
        options: opts(['routine', 'รอบปกติ'], ['change', 'อาการเปลี่ยน'], ['incident', 'เหตุการณ์ผิดปกติ']),
      },
    ],
  },

  {
    key: 'general',
    title: 'สภาพทั่วไป',
    fields: [
      {
        key: 'condition_change',
        // คำถามแรกของฟอร์มโดยตั้งใจ — การเทียบกับครั้งก่อนบอกได้มากกว่าตัวเลขดิบ
        // เพราะค่าปกติของผู้ป่วยแต่ละคนไม่เท่ากัน "SpO₂ 96" อาจปกติของคนหนึ่งและผิดปกติของอีกคน
        label: 'เทียบกับรายงานครั้งก่อน ผู้รับบริการเป็นอย่างไร',
        type: 'choice',
        highlight: true,
        options: opts(
          ['same', 'ปกติ/ใกล้เคียงเดิม'],
          ['better', 'ดีขึ้น'],
          ['worse', 'แย่ลง'],
          ['new_issue', 'พบความผิดปกติใหม่'],
        ),
      },
      {
        key: 'consciousness',
        label: 'ระดับความรู้สึกตัว',
        type: 'choice',
        options: opts(
          ['alert', 'รู้สึกตัวดี'],
          ['drowsy', 'ง่วงซึม'],
          ['confused', 'สับสน'],
          ['restless', 'กระสับกระส่าย'],
          ['unresponsive', 'ไม่ตอบสนอง'],
          ['other', 'อื่นๆ'],
        ),
      },
      {
        key: 'mood',
        label: 'อารมณ์ / พฤติกรรม',
        type: 'choice',
        options: opts(
          ['normal', 'ปกติ'],
          ['anxious', 'วิตกกังวล'],
          ['aggressive', 'ก้าวร้าว'],
          ['uncooperative', 'ไม่ให้ความร่วมมือ'],
          ['other', 'อื่นๆ'],
        ),
      },
      {
        key: 'breathing',
        label: 'การหายใจ',
        type: 'choice',
        options: opts(
          ['normal', 'ปกติ'],
          ['dyspnea', 'หอบเหนื่อย'],
          ['cough', 'ไอ'],
          ['sputum_up', 'มีเสมหะเพิ่ม'],
          ['other', 'อื่นๆ'],
        ),
      },
      {
        key: 'sleep',
        label: 'การนอน',
        type: 'choice',
        options: opts(
          ['good', 'หลับดี'],
          ['interrupted', 'หลับๆ ตื่นๆ'],
          ['insomnia', 'นอนไม่หลับ'],
          ['hypersomnia', 'ง่วงผิดปกติ'],
        ),
      },
      { key: 'pain_score', label: 'ระดับความเจ็บปวด', type: 'number', unit: '0–10', min: 0, max: 10 },
      { key: 'pain_location', label: 'ตำแหน่งที่ปวด', type: 'text', rows: 1, placeholder: 'เช่น เข่าขวา หลังส่วนล่าง' },
    ],
  },

  {
    key: 'vitals',
    title: 'สัญญาณชีพ',
    hint: 'วัดได้ช่องไหนกรอกช่องนั้น',
    columns: 4,
    fields: [
      { key: 'bp_systolic', label: 'ความดันตัวบน', type: 'number', unit: 'mmHg', min: 40, max: 300 },
      { key: 'bp_diastolic', label: 'ความดันตัวล่าง', type: 'number', unit: 'mmHg', min: 20, max: 200 },
      { key: 'pulse', label: 'ชีพจร', type: 'number', unit: 'ครั้ง/นาที', min: 20, max: 250 },
      { key: 'respiratory_rate', label: 'อัตราการหายใจ', type: 'number', unit: 'ครั้ง/นาที', min: 4, max: 80 },
      { key: 'temperature_c', label: 'อุณหภูมิ', type: 'number', unit: '°C', min: 30, max: 45, step: 0.1 },
      { key: 'spo2', label: 'ออกซิเจนปลายนิ้ว', type: 'number', unit: '%', min: 50, max: 100 },
      { key: 'blood_sugar', label: 'น้ำตาลปลายนิ้ว', type: 'number', unit: 'mg/dL', min: 10, max: 800 },
      { key: 'weight_kg', label: 'น้ำหนัก', type: 'number', unit: 'กก.', min: 1, max: 500, step: 0.1 },
    ],
  },

  {
    key: 'resp',
    title: 'ทางเดินหายใจ / ออกซิเจน / เจาะคอ',
    collapsed: true,
    fields: [
      { key: 'oxygen_use', label: 'ออกซิเจน', type: 'choice', options: opts(['none', 'ไม่ใช้'], ['in_use', 'ใช้อยู่']) },
      { key: 'oxygen_lpm', label: 'อัตราออกซิเจน', type: 'number', unit: 'L/min', min: 0, max: 60, step: 0.5 },
      {
        key: 'sputum_amount',
        label: 'ปริมาณเสมหะ',
        type: 'choice',
        options: opts(['none', 'ไม่มี'], ['small', 'น้อย'], ['moderate', 'ปานกลาง'], ['large', 'มาก']),
      },
      {
        key: 'sputum_color',
        label: 'สีเสมหะ',
        type: 'choice',
        options: opts(
          ['clear', 'ใส'],
          ['white', 'ขาว'],
          ['yellow', 'เหลือง'],
          ['green', 'เขียว'],
          ['blood', 'มีเลือด'],
          ['other', 'อื่นๆ'],
        ),
      },
      {
        key: 'sputum_character',
        label: 'ลักษณะเสมหะ',
        type: 'choice',
        options: opts(['thin', 'เหลว'], ['thick', 'ข้น'], ['sticky', 'เหนียว']),
      },
      {
        key: 'suction_status',
        label: 'ดูดเสมหะ',
        type: 'choice',
        options: opts(['done', 'ทำแล้ว'], ['not_needed', 'ไม่จำเป็น'], ['problem', 'มีปัญหา']),
      },
      { key: 'suction_count', label: 'จำนวนครั้งที่ดูด', type: 'number', unit: 'ครั้ง', min: 0, max: 99 },
      { key: 'trach_status', label: 'Tracheostomy', type: 'choice', options: opts(['normal', 'ปกติ'], ['problem', 'มีปัญหา']) },
      { key: 'inner_tube_care', label: 'Inner tube care', type: 'choice', options: DONE_NA },
      {
        key: 'cuff_care',
        label: 'Balloon / Cuff care',
        type: 'choice',
        options: opts(['done', 'ทำตามแผน'], ['problem', 'มีปัญหา'], ['na', 'ไม่เกี่ยวข้อง']),
      },
      {
        key: 'neck_wound',
        label: 'แผลรอบคอ',
        type: 'choice',
        options: opts(
          ['normal', 'ปกติ'],
          ['red', 'แดง'],
          ['swollen', 'บวม'],
          ['discharge', 'มีสารคัดหลั่ง'],
          ['other', 'อื่นๆ'],
        ),
      },
    ],
  },

  {
    key: 'nutrition',
    title: 'อาหารและน้ำ',
    collapsed: true,
    fields: [
      { key: 'feed_route', label: 'ทางที่ให้อาหาร', type: 'choice', options: opts(['oral', 'รับประทาน'], ['ng', 'สาย NG'], ['peg', 'PEG']) },
      { key: 'feed_formula', label: 'สูตร/ชนิดอาหาร', type: 'text', rows: 1, placeholder: 'เช่น Blenderized diet, นมสูตรครบส่วน' },
      { key: 'feed_volume_ml', label: 'ปริมาณที่ได้รับ', type: 'number', unit: 'ml', min: 0, max: 5000 },
      { key: 'feed_rate_ml_hr', label: 'อัตราการให้', type: 'number', unit: 'ml/hr', min: 0, max: 1000 },
      { key: 'water_flush_ml', label: 'น้ำตาม / Flush', type: 'number', unit: 'ml', min: 0, max: 5000 },
      {
        key: 'feed_tolerance',
        label: 'การรับอาหาร',
        type: 'choice',
        options: opts(
          ['normal', 'ปกติ'],
          ['fullness', 'แน่นท้อง'],
          ['nausea', 'คลื่นไส้'],
          ['vomiting', 'อาเจียน'],
          ['bloating', 'ท้องอืด'],
          ['other', 'อื่นๆ'],
        ),
      },
      { key: 'gastric_output_ml', label: 'Gastric content', type: 'number', unit: 'ml', min: 0, max: 5000 },
    ],
  },

  {
    key: 'output',
    title: 'การขับถ่าย',
    fields: [
      { key: 'urine_ml', label: 'ปัสสาวะ', type: 'number', unit: 'ml', min: 0, max: 10000 },
      {
        key: 'urine_color',
        label: 'สีปัสสาวะ',
        type: 'choice',
        options: opts(['normal', 'ปกติ'], ['dark', 'เข้ม'], ['cloudy', 'ขุ่น'], ['blood', 'มีเลือด'], ['other', 'อื่นๆ']),
      },
      { key: 'urine_odor', label: 'กลิ่นผิดปกติ', type: 'bool', yes: 'มี', no: 'ไม่มี' },
      { key: 'foley_status', label: 'สายสวนปัสสาวะ', type: 'choice', options: opts(['normal', 'ปกติ'], ['problem', 'มีปัญหา'], ['na', 'ไม่มี']) },
      { key: 'stool_count', label: 'อุจจาระ (จำนวนครั้ง)', type: 'number', unit: 'ครั้ง', min: 0, max: 30 },
      { key: 'stool_amount', label: 'ปริมาณอุจจาระ', type: 'choice', options: opts(['small', 'น้อย'], ['moderate', 'ปานกลาง'], ['large', 'มาก']) },
      { key: 'stool_grams', label: 'น้ำหนักอุจจาระ', type: 'number', unit: 'g', min: 0, max: 5000 },
      {
        key: 'stool_scale',
        label: 'ลักษณะอุจจาระ (Bristol 1–7)',
        type: 'number',
        unit: '1–7',
        min: 1,
        max: 7,
        hint: '1 = แข็งเป็นก้อนแยก · 4 = ปกตินิ่มยาว · 7 = เหลวทั้งหมด',
      },
      { key: 'diaper_changes', label: 'เปลี่ยนผ้าอ้อม', type: 'number', unit: 'ครั้ง', min: 0, max: 30 },
      { key: 'gas_vent_ml', label: 'Gas / Venting', type: 'number', unit: 'ml', min: 0, max: 5000 },
      { key: 'other_output_ml', label: 'Output อื่นๆ', type: 'number', unit: 'ml', min: 0, max: 5000 },
    ],
  },

  {
    key: 'adl',
    title: 'กิจวัตรและการดูแลตัวบุคคล',
    hint: 'กดเลือกเฉพาะที่ทำ — เว้นไว้ = ไม่ได้ระบุ',
    fields: [
      { key: 'adl_bath', label: 'อาบน้ำ', type: 'bool' },
      { key: 'adl_oral_care', label: 'ทำความสะอาดช่องปาก / แปรงฟัน', type: 'bool' },
      { key: 'adl_hair_wash', label: 'สระผม', type: 'bool' },
      { key: 'adl_skin_care', label: 'ดูแลผิวหนัง', type: 'bool' },
      { key: 'adl_clothes', label: 'เปลี่ยนเสื้อผ้า', type: 'bool' },
      { key: 'adl_eye_care', label: 'ดูแลดวงตา', type: 'bool' },
      { key: 'adl_transfer', label: 'เคลื่อนย้าย (Transfer)', type: 'bool' },
      { key: 'adl_ambulation', label: 'ฝึกเดิน (Ambulation)', type: 'bool' },
      { key: 'positioning_count', label: 'เปลี่ยนท่า', type: 'number', unit: 'ครั้ง', min: 0, max: 48 },
    ],
  },

  {
    key: 'rehab',
    title: 'ฟื้นฟู / กิจกรรม',
    collapsed: true,
    fields: [
      { key: 'rehab_rom', label: 'ROM / Exercise', type: 'choice', options: DONE_NA },
      { key: 'rehab_program', label: 'กายภาพตามโปรแกรม', type: 'choice', options: DONE_NA },
      { key: 'rehab_minutes', label: 'ระยะเวลา', type: 'number', unit: 'นาที', min: 0, max: 600 },
      { key: 'rehab_cooperation', label: 'ความร่วมมือ', type: 'choice', options: opts(['good', 'ดี'], ['fair', 'ปานกลาง'], ['poor', 'น้อย']) },
      {
        key: 'rehab_after',
        label: 'หลังทำกิจกรรม',
        type: 'choice',
        options: opts(['normal', 'ปกติ'], ['tired', 'เหนื่อย'], ['pain', 'ปวด'], ['abnormal', 'มีอาการผิดปกติ']),
      },
    ],
  },

  {
    key: 'skin',
    title: 'ผิวหนัง / แผล',
    fields: [
      { key: 'skin_status', label: 'ผิวหนัง', type: 'choice', options: opts(['normal', 'ปกติ'], ['abnormal', 'ผิดปกติ']) },
      { key: 'skin_redness', label: 'รอยแดง', type: 'bool', yes: 'มี', no: 'ไม่มี' },
      { key: 'pressure_sore', label: 'แผลกดทับ', type: 'bool', yes: 'มี', no: 'ไม่มี' },
      { key: 'wound_progress', label: 'แผลเดิม', type: 'choice', options: opts(['better', 'ดีขึ้น'], ['same', 'คงเดิม'], ['worse', 'แย่ลง'], ['na', 'ไม่มีแผล']) },
      { key: 'wound_location', label: 'ตำแหน่งแผล / รอยแดง', type: 'text', rows: 1, placeholder: 'เช่น ก้นกบ ส้นเท้าซ้าย' },
      { key: 'dressing_done', label: 'ทำแผลแล้ว', type: 'bool' },
      { key: 'wound_photo', label: 'รูปแผล', type: 'photo' },
    ],
  },

  {
    key: 'devices',
    title: 'สายและอุปกรณ์ทางการแพทย์',
    hint: 'เลือกเฉพาะอุปกรณ์ที่เคสนี้มี',
    collapsed: true,
    fields: [
      { key: 'dev_ng', label: 'สาย NG', type: 'choice', options: DEVICE_STATE },
      { key: 'dev_peg', label: 'PEG', type: 'choice', options: DEVICE_STATE },
      { key: 'dev_trach', label: 'Tracheostomy', type: 'choice', options: DEVICE_STATE },
      { key: 'dev_foley', label: 'สายสวนปัสสาวะ', type: 'choice', options: DEVICE_STATE },
      { key: 'dev_oxygen', label: 'เครื่องออกซิเจน', type: 'choice', options: DEVICE_STATE },
      { key: 'dev_feed_pump', label: 'Feeding pump', type: 'choice', options: DEVICE_STATE },
      { key: 'dev_suction', label: 'เครื่องดูดเสมหะ', type: 'choice', options: DEVICE_STATE },
      { key: 'dev_colostomy', label: 'Colostomy', type: 'choice', options: DEVICE_STATE },
      { key: 'device_issue', label: 'รายละเอียดเมื่อมีอุปกรณ์ผิดปกติ', type: 'text', rows: 2 },
    ],
  },

  {
    key: 'incident',
    title: 'สิ่งผิดปกติ / เหตุการณ์',
    hint: 'มีข้อไหนตรง = แจ้งพยาบาลทันที ไม่ต้องรอรอบรายงาน',
    highlight: true,
    fields: [
      { key: 'incident_types', label: 'สิ่งที่พบ', type: 'multi', options: INCIDENT_TYPES },
      { key: 'incident_detail', label: 'เกิดอะไรขึ้น / ทำอะไรไปแล้ว', type: 'text', rows: 3 },
      { key: 'rn_notified_at', label: 'เวลาที่แจ้งพยาบาล', type: 'time' },
      { key: 'rn_notified_to', label: 'แจ้งใคร', type: 'text', rows: 1, placeholder: 'ชื่อพยาบาล/ผู้รับแจ้ง' },
    ],
  },

  {
    key: 'summary',
    title: 'สรุปเพิ่มเติม',
    fields: [
      { key: 'symptoms', label: 'อาการที่พบ', type: 'text', rows: 2 },
      { key: 'care_given', label: 'การดูแลที่ให้', type: 'text', rows: 2 },
      { key: 'follow_up', label: 'สิ่งที่ต้องติดตาม', type: 'text', rows: 2 },
      { key: 'note', label: 'หมายเหตุ', type: 'text', rows: 2 },
    ],
  },
];

/** ทุกช่องของฟอร์มเต็ม เรียงแบนไว้ให้ค้นด้วย key ได้เร็ว */
export const DAILY_FIELDS = new Map(
  DAILY_SECTIONS.flatMap((s) => s.fields.map((f) => [f.key, { ...f, section: s.key }])),
);

/** ค่าดิบจากฐานข้อมูล -> คำที่คนอ่านรู้เรื่อง (ใช้ในหน้าดูรายงานและหน้าตรวจทานก่อนส่ง) */
export function dailyValueText(field, value) {
  if (value == null || value === '') return null;

  switch (field.type) {
    case 'choice':
      return field.options.find((o) => o.value === value)?.label ?? String(value);
    case 'multi': {
      const list = Array.isArray(value) ? value : [value];
      if (list.length === 0) return null;
      return list.map((v) => field.options.find((o) => o.value === v)?.label ?? v).join(' · ');
    }
    case 'bool':
      return value ? (field.yes ?? 'ทำแล้ว') : (field.no ?? 'ไม่ได้ทำ');
    case 'number':
      return `${value}${field.unit && field.unit !== '0–10' && field.unit !== '1–7' ? ` ${field.unit}` : ''}`;
    case 'time':
      return `${value} น.`;
    case 'photo':
      return value ? 'มีรูปแนบ' : null;
    default:
      return String(value);
  }
}

/**
 * บรรทัดสรุปของรายงานหนึ่งใบ — ใช้ตอนที่ใบถูกย่อไว้ในรายการ
 *
 * เลือกเฉพาะสิ่งที่ตัดสินใจได้ทันทีว่า "ต้องกางอ่านใบนี้ไหม":
 * สภาพเทียบครั้งก่อน (คำถามหลักของฟอร์ม) · สัญญาณชีพหลัก · มีเหตุการณ์ผิดปกติไหม
 * ไม่ยัดทุกช่องที่กรอก ไม่งั้นบรรทัดสรุปจะยาวพอๆ กับใบเต็ม แล้วการย่อก็ไม่มีความหมาย
 */
export function dailyBrief(r) {
  const parts = [];

  const condition = DAILY_FIELDS.get('condition_change');
  if (r.condition_change) parts.push(dailyValueText(condition, r.condition_change));

  if (r.bp_systolic != null || r.bp_diastolic != null) {
    parts.push(`BP ${r.bp_systolic ?? '—'}/${r.bp_diastolic ?? '—'}`);
  }
  if (r.pulse != null) parts.push(`P ${r.pulse}`);
  if (r.temperature_c != null) parts.push(`T ${r.temperature_c}°`);
  if (r.spo2 != null) parts.push(`SpO₂ ${r.spo2}%`);

  // ปริมาณที่ญาติ/พยาบาลถามถึงบ่อยที่สุดในเคสติดเตียง
  if (r.feed_volume_ml != null) parts.push(`อาหาร ${r.feed_volume_ml} ml`);
  if (r.urine_ml != null) parts.push(`ปัสสาวะ ${r.urine_ml} ml`);

  if (r.incident_types?.length) {
    const first = INCIDENT_TYPES.find((o) => o.value === r.incident_types[0])?.label ?? r.incident_types[0];
    parts.push(r.incident_types.length > 1 ? `${first} +${r.incident_types.length - 1}` : first);
  }

  return parts;
}

/** ค่าที่ถือว่า "กรอกแล้ว" — false กับ 0 นับด้วย (เป็นคำตอบ ไม่ใช่ช่องว่าง) */
export const isFilled = (v) => v != null && v !== '' && (!Array.isArray(v) || v.length > 0);
