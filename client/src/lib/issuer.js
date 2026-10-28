/**
 * ข้อมูลผู้ออกเอกสาร + เวลาที่สั่งพิมพ์ — ของกลางของทุกเอกสารที่พิมพ์ลงกระดาษ
 * (ใบแจ้งหนี้/ใบเสร็จ · ใบสรุปค่าตอบแทนพนักงาน)
 *
 * เดิมอยู่ในไฟล์ใบแจ้งหนี้เพราะมีเอกสารเดียวในระบบ พอมีใบที่สอง การก๊อปที่อยู่กับเบอร์โทร
 * ไปวางอีกที่แปลว่าวันที่ย้ายออฟฟิศจะมีใบที่ยังพิมพ์ที่อยู่เก่าเหลืออยู่ใบหนึ่งเสมอ
 * โดยไม่มีอะไรฟ้อง — แก้ที่เดียวตรงนี้ เปลี่ยนทุกใบ
 */
const TRANSFER_ACCOUNT = {
  bank: 'กสิกรไทย',
  type: 'ออมทรัพย์',
  number: '047-1-47576-9',
  copyNumber: '0471475769',
  name: 'บจก.ทีทรี สโตรก เนอสซิ่งโฮม',
};

export const ISSUER = {
  // ไฟล์เดียวกับที่ใช้บนแถบเมนู/หน้าเข้าสู่ระบบ (client/public/) — เปลี่ยนไฟล์ทีเดียวเปลี่ยนทุกที่
  logo: '/logo-navbar.webp',
  // หัวบิล/ใบเสร็จลูกค้าใช้โลโก้ KIN ทอง 2 ขีด (ดร.ธงชัย 29 ต.ค. 2569 "หัวบิลใบเสร็จ ขอเป็นโลโก้คิน")
  docLogo: '/logo-kin.png',
  brand: 'คิน เวลเนส สหคลินิก',
  name: 'บริษัท ทีทรี สโตรก เนอสซิ่งโฮม จำกัด (สำนักงานใหญ่)',
  taxId: '0105561155236',
  address: '6 ซอยนาคนิวาส 18 ถนนนาคนิวาส แขวงลาดพร้าว เขตลาดพร้าว กรุงเทพมหานคร 10230',
  tel: '061-881-9399',
  transfer: TRANSFER_ACCOUNT,
  customerServiceDescription: 'ค่าบริการทางการแพทย์',
};

export const TRANSFER_ACCOUNT_TEXT =
  `ธนาคาร${TRANSFER_ACCOUNT.bank} ${TRANSFER_ACCOUNT.type} เลขที่ ${TRANSFER_ACCOUNT.number} ชื่อบัญชี ${TRANSFER_ACCOUNT.name}`;

export const TRANSFER_PAYMENT_INSTRUCTION =
  `โอนเข้าบัญชี ${TRANSFER_ACCOUNT_TEXT} · โอนแล้วแนบสลิปด้านล่าง หรือส่งสลิปในแชท LINE KIN HomeCare`;

/** วันเวลาที่สั่งพิมพ์ มุมขวาบนของเอกสาร (พ.ศ. อัตโนมัติจาก locale ไทย) */
export const printStamp = () =>
  new Date().toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
