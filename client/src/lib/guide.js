/* วิดีโอสอนใช้งาน (ดร.ธงชัย 25 ต.ค. 2569 "เมนูของตัวหลังบ้านผมก็ทำได้เลย … วิดีโอสอนการใช้งานอยู่ในตัว Dashboard ด้วย")
   หน้าปลายทางอยู่ฝั่ง kin-chatbot (ค่าคงที่ต้นทาง src/lib/trainingVideos.js) เปิดได้โดยไม่ต้องล็อกอินและมี noindex
   คนละเล่มกันจริง ๆ: ภาคสนามดู 6 ตอนจากมือถือ · หลังบ้านมีทีละขั้น 10 ตอน + งานหลังบ้านอีก 5 ตอน
   อยู่ในหน้าตั้งค่า (ย้ายออกจากเมนูด้านข้าง 28 ต.ค. 2569) */
export const GUIDE_URL = {
  field: 'https://chat.kinorigin.com/guide/bZA4kNe9g-b-',
  admin: 'https://chat.kinorigin.com/guide/auUwvGgMN09d',
};

/** เล่มที่คนนี้ควรดู — หลังบ้าน (role admin) ได้เล่มหลังบ้าน นอกนั้นได้เล่มภาคสนาม */
export const guideUrlFor = (user) => (user?.role === 'admin' ? GUIDE_URL.admin : GUIDE_URL.field);
