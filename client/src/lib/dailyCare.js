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

/**
 * เคสนี้ใช้แบบบันทึกการรักษาทางกายภาพบำบัดไหม — เกณฑ์ตรงข้ามกับ usesDailyRecord
 * ดูทั้ง service_kind, แพ็คเกจกายภาพ และประเภทเคส เพราะเคสกายภาพเข้ามาได้สามทาง:
 * เลือกแพ็คเกจกายภาพ (physio_package_id), ตั้ง service_kind เอง, หรือเคสเก่าที่ตั้งแค่ประเภทเคส
 */
export const usesPhysioRecord = (c) =>
  Boolean(c) &&
  (c.service_kind === 'physio' || c.physio_package_id != null || c.case_type === 'physiotherapy');

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

/* ---------------------------------------------------------------------------
 * แบบบันทึกการรักษาทางกายภาพบำบัด — คนละชุดช่องกับฟอร์มดูแลประจำวัน แต่โครงเดียวกัน
 *
 * เลือกเฉพาะสิ่งที่ต้องรู้จริงของการรักษาหนึ่งครั้ง แล้วตัดที่เหลือทิ้งทั้งหมด:
 * ไม่มี NG/ขับถ่าย/ผ้าอ้อม/เจาะคอ/อุปกรณ์ทางการแพทย์ เพราะนักกายภาพไม่ได้ดูแลส่วนนั้น
 * และไม่มี "เวร" เพราะกายภาพมาเป็นครั้ง ไม่ได้อยู่เป็นกะ
 *
 * แกนของฟอร์มคือคู่ ก่อน → หลัง ของครั้งเดียวกัน (ปวด/ความดัน/ชีพจร/ออกซิเจน)
 * เพราะสิ่งที่ต้องตอบให้ได้คือ "ครั้งนี้ผู้ป่วยทนไหวไหม และดีขึ้นไหม" ไม่ใช่ค่า ณ จุดเดียว
 * ------------------------------------------------------------------------- */

/** หัตถการ/กิจกรรมที่ทำในครั้งหนึ่ง — ครั้งหนึ่งทำหลายอย่างเป็นปกติ จึงเลือกได้หลายข้อ */
export const PHYSIO_TREATMENTS = opts(
  ['rom', 'ROM / ยืดกล้ามเนื้อ'],
  ['strength', 'ออกกำลังเพิ่มกำลังกล้ามเนื้อ'],
  ['facilitation', 'กระตุ้นการเคลื่อนไหว'],
  ['balance', 'ฝึกการทรงตัว'],
  ['transfer', 'ฝึกลุก–นั่ง / เคลื่อนย้าย'],
  ['gait', 'ฝึกเดิน'],
  ['chest', 'กายภาพทรวงอก / ฝึกหายใจ'],
  ['estim', 'กระตุ้นไฟฟ้า'],
  ['ultrasound', 'อัลตราซาวด์'],
  ['heat_cold', 'ประคบร้อน / เย็น'],
  ['massage', 'นวด / คลายกล้ามเนื้อ'],
  ['positioning', 'จัดท่า / ป้องกันข้อติด'],
  ['adl_training', 'ฝึกกิจวัตรประจำวัน'],
  ['education', 'สอนผู้ดูแล / โปรแกรมที่บ้าน'],
  ['other', 'อื่นๆ'],
);

/**
 * เหตุการณ์ผิดปกติที่พบระหว่างทำกายภาพ — คนละชุดกับงานดูแลประจำวัน
 * (ที่นี่คือสิ่งที่เกิดจากการออกแรง: หน้ามืด ความดันขึ้น เจ็บหน้าอก ปวดเพิ่ม บาดเจ็บ)
 */
export const PHYSIO_INCIDENT_TYPES = opts(
  ['fall', 'ล้ม / เกือบล้ม'],
  ['dizzy', 'เวียนศีรษะ / หน้ามืด'],
  ['bp_abnormal', 'ความดันสูง/ต่ำผิดปกติ'],
  ['pulse_abnormal', 'ชีพจรผิดปกติ'],
  ['dyspnea', 'เหนื่อย / หายใจลำบาก'],
  ['chest_pain', 'เจ็บแน่นหน้าอก'],
  ['pain_up', 'ปวดเพิ่มขึ้นมากหลังทำ'],
  ['spasticity', 'เกร็งมากผิดปกติ'],
  ['injury', 'บาดเจ็บข้อ / กล้ามเนื้อระหว่างทำ'],
  ['skin', 'ผิวหนังถลอก / รอยแดงใหม่'],
  ['seizure', 'ชัก'],
  ['refuse', 'ปฏิเสธการรักษา / หยุดกลางคัน'],
  ['equipment', 'อุปกรณ์ขัดข้อง'],
  ['other', 'อื่นๆ'],
);

export const PHYSIO_SECTIONS = [
  {
    key: 'work',
    title: 'ข้อมูลการปฏิบัติงาน',
    fields: [
      {
        key: 'report_type',
        label: 'ประเภทบันทึก',
        type: 'choice',
        options: opts(['routine', 'ครั้งปกติ'], ['change', 'อาการเปลี่ยน'], ['incident', 'เหตุการณ์ผิดปกติ']),
      },
    ],
  },

  {
    key: 'pre',
    title: 'ก่อนเริ่มการรักษา',
    highlight: true,
    fields: [
      {
        key: 'condition_change',
        // คำถามแรกเหมือนฟอร์มดูแลประจำวัน — คอร์สกายภาพวัดผลจากการเทียบครั้งต่อครั้ง
        // ไม่ใช่จากค่าใดค่าหนึ่ง เพราะจุดตั้งต้นของผู้ป่วยแต่ละคนต่างกันมาก
        label: 'เทียบกับครั้งก่อน ผู้รับบริการเป็นอย่างไร',
        type: 'choice',
        options: opts(
          ['same', 'ใกล้เคียงเดิม'],
          ['better', 'ดีขึ้น'],
          ['worse', 'แย่ลง'],
          ['new_issue', 'พบความผิดปกติใหม่'],
        ),
      },
      { key: 'pain_score', label: 'ความเจ็บปวดก่อนทำ', type: 'number', unit: '0–10', min: 0, max: 10 },
      { key: 'pain_location', label: 'ตำแหน่งที่ปวด', type: 'text', rows: 1, placeholder: 'เช่น ไหล่ซ้าย เข่าขวา หลังส่วนล่าง' },
      {
        key: 'rehab_cooperation',
        label: 'ความร่วมมือ',
        type: 'choice',
        options: opts(['good', 'ดี'], ['fair', 'ปานกลาง'], ['poor', 'น้อย']),
      },
    ],
  },

  {
    key: 'vitals',
    title: 'สัญญาณชีพก่อนทำ',
    hint: 'วัดได้ช่องไหนกรอกช่องนั้น — ใช้เทียบกับค่าหลังทำในหมวดล่าง',
    columns: 4,
    fields: [
      { key: 'bp_systolic', label: 'ความดันตัวบน', type: 'number', unit: 'mmHg', min: 40, max: 300 },
      { key: 'bp_diastolic', label: 'ความดันตัวล่าง', type: 'number', unit: 'mmHg', min: 20, max: 200 },
      { key: 'pulse', label: 'ชีพจร', type: 'number', unit: 'ครั้ง/นาที', min: 20, max: 250 },
      { key: 'spo2', label: 'ออกซิเจนปลายนิ้ว', type: 'number', unit: '%', min: 50, max: 100 },
      { key: 'blood_sugar', label: 'น้ำตาลปลายนิ้ว', type: 'number', unit: 'mg/dL', min: 10, max: 800 },
    ],
  },

  {
    key: 'treatment',
    title: 'การรักษาที่ให้ครั้งนี้',
    fields: [
      { key: 'physio_treatments', label: 'สิ่งที่ทำ', type: 'multi', options: PHYSIO_TREATMENTS },
      { key: 'rehab_minutes', label: 'ระยะเวลา', type: 'number', unit: 'นาที', min: 0, max: 600 },
      {
        key: 'care_given',
        label: 'รายละเอียดโปรแกรม',
        type: 'text',
        rows: 2,
        placeholder: 'เช่น ยืด hamstring 3 เซ็ต · ฝึกยืนทรงตัว 10 นาที · เดินในบ้าน 2 รอบ',
      },
    ],
  },

  {
    key: 'function',
    title: 'ความสามารถของผู้รับบริการ',
    hint: 'ตัวเลขชุดนี้คือผลลัพธ์ของคอร์ส — บันทึกทุกครั้งจึงจะเห็นว่าดีขึ้นจริงไหม',
    fields: [
      {
        key: 'assist_level',
        label: 'ระดับการช่วยเหลือ',
        type: 'choice',
        options: opts(
          ['independent', 'ทำเองได้ทั้งหมด'],
          ['supervision', 'ทำเองได้ แต่ต้องมีคนดูใกล้ๆ'],
          ['min_assist', 'ช่วยเล็กน้อย'],
          ['mod_assist', 'ช่วยปานกลาง'],
          ['max_assist', 'ช่วยเกือบทั้งหมด'],
          ['dependent', 'ทำเองไม่ได้เลย'],
        ),
      },
      {
        key: 'walk_aid',
        label: 'อุปกรณ์ช่วยเดิน',
        type: 'choice',
        options: opts(
          ['none', 'ไม่ใช้อุปกรณ์'],
          ['cane', 'ไม้เท้า'],
          ['walker', 'วอล์กเกอร์'],
          ['wheelchair', 'รถเข็น'],
          ['unable', 'ยังเดินไม่ได้'],
        ),
      },
      { key: 'walk_distance_m', label: 'ระยะทางที่เดินได้', type: 'number', unit: 'เมตร', min: 0, max: 5000 },
    ],
  },

  {
    key: 'post',
    title: 'หลังการรักษา',
    hint: 'ค่าคู่กับหมวดก่อนทำ — ใช้ดูว่าโปรแกรมหนักไปหรือได้ผล',
    columns: 4,
    fields: [
      {
        key: 'rehab_after',
        label: 'อาการหลังทำ',
        type: 'choice',
        options: opts(['normal', 'ปกติ'], ['tired', 'เหนื่อย'], ['pain', 'ปวด'], ['abnormal', 'มีอาการผิดปกติ']),
      },
      { key: 'post_pain_score', label: 'ความเจ็บปวดหลังทำ', type: 'number', unit: '0–10', min: 0, max: 10 },
      { key: 'post_bp_systolic', label: 'ความดันตัวบน', type: 'number', unit: 'mmHg', min: 40, max: 300 },
      { key: 'post_bp_diastolic', label: 'ความดันตัวล่าง', type: 'number', unit: 'mmHg', min: 20, max: 200 },
      { key: 'post_pulse', label: 'ชีพจร', type: 'number', unit: 'ครั้ง/นาที', min: 20, max: 250 },
      { key: 'post_spo2', label: 'ออกซิเจนปลายนิ้ว', type: 'number', unit: '%', min: 50, max: 100 },
    ],
  },

  {
    key: 'home',
    title: 'โปรแกรมที่บ้าน / แผนครั้งหน้า',
    fields: [
      {
        key: 'home_program',
        label: 'สอนโปรแกรมที่บ้าน',
        type: 'choice',
        options: opts(['done', 'สอน/ทบทวนแล้ว'], ['not_done', 'ยังไม่ได้สอนรอบนี้'], ['na', 'ไม่มีโปรแกรมที่บ้าน']),
      },
      {
        key: 'follow_up',
        label: 'การบ้าน / สิ่งที่ต้องทำต่อ',
        type: 'text',
        rows: 2,
        placeholder: 'เช่น ยืดน่องวันละ 2 รอบ · ให้ญาติช่วยพยุงเดินวันละ 10 นาที',
      },
    ],
  },

  {
    key: 'incident',
    title: 'สิ่งผิดปกติระหว่างทำ',
    hint: 'มีข้อไหนตรง = แจ้งพยาบาล/ผู้ประสานงานทันที ไม่ต้องรอส่งรายงาน',
    highlight: true,
    fields: [
      { key: 'incident_types', label: 'สิ่งที่พบ', type: 'multi', options: PHYSIO_INCIDENT_TYPES },
      { key: 'incident_detail', label: 'เกิดอะไรขึ้น / ทำอะไรไปแล้ว', type: 'text', rows: 3 },
      { key: 'rn_notified_at', label: 'เวลาที่แจ้ง', type: 'time' },
      { key: 'rn_notified_to', label: 'แจ้งใคร', type: 'text', rows: 1, placeholder: 'ชื่อพยาบาล/ผู้รับแจ้ง' },
    ],
  },

  {
    key: 'summary',
    title: 'สรุปเพิ่มเติม',
    fields: [
      { key: 'symptoms', label: 'อาการที่พบ', type: 'text', rows: 2 },
      { key: 'note', label: 'หมายเหตุ', type: 'text', rows: 2 },
    ],
  },
];

/** ทุกช่องของฟอร์มหนึ่ง เรียงแบนไว้ให้ค้นด้วย key ได้เร็ว */
const fieldMap = (sections) =>
  new Map(sections.flatMap((s) => s.fields.map((f) => [f.key, { ...f, section: s.key }])));

export const DAILY_FIELDS = fieldMap(DAILY_SECTIONS);
export const PHYSIO_FIELDS = fieldMap(PHYSIO_SECTIONS);

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

/**
 * บรรทัดสรุปของรายงานกายภาพหนึ่งครั้ง — คนละชุดกับ dailyBrief เพราะสิ่งที่ต้องรู้ก่อนกางต่างกัน
 * งานกายภาพถามว่า "ครั้งนี้ทำอะไร ปวดลดไหม เดินได้แค่ไหน" ไม่ใช่ปริมาณอาหาร/ขับถ่าย
 */
export function physioBrief(r) {
  const parts = [];

  if (r.condition_change) {
    parts.push(dailyValueText(PHYSIO_FIELDS.get('condition_change'), r.condition_change));
  }

  // ปวดก่อน→หลัง คือผลของครั้งนี้ ตัวเลขเดียวบอกไม่ได้ว่าดีขึ้นหรือแย่ลง
  if (r.pain_score != null && r.post_pain_score != null) parts.push(`ปวด ${r.pain_score}→${r.post_pain_score}`);
  else if (r.pain_score != null) parts.push(`ปวด ${r.pain_score}`);
  else if (r.post_pain_score != null) parts.push(`ปวดหลังทำ ${r.post_pain_score}`);

  if (r.physio_treatments?.length) {
    const first = PHYSIO_TREATMENTS.find((o) => o.value === r.physio_treatments[0])?.label ?? r.physio_treatments[0];
    parts.push(r.physio_treatments.length > 1 ? `${first} +${r.physio_treatments.length - 1}` : first);
  }
  if (r.rehab_minutes != null) parts.push(`${r.rehab_minutes} นาที`);
  if (r.assist_level) parts.push(dailyValueText(PHYSIO_FIELDS.get('assist_level'), r.assist_level));
  if (r.walk_distance_m != null) parts.push(`เดิน ${r.walk_distance_m} ม.`);

  if (r.incident_types?.length) {
    const first = PHYSIO_INCIDENT_TYPES.find((o) => o.value === r.incident_types[0])?.label ?? r.incident_types[0];
    parts.push(r.incident_types.length > 1 ? `${first} +${r.incident_types.length - 1}` : first);
  }

  return parts;
}

/** ค่าที่ถือว่า "กรอกแล้ว" — false กับ 0 นับด้วย (เป็นคำตอบ ไม่ใช่ช่องว่าง) */
export const isFilled = (v) => v != null && v !== '' && (!Array.isArray(v) || v.length > 0);
