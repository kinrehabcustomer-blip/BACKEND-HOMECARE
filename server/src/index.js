import 'dotenv/config';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4000);

createApp().listen(port, () => {
  console.log(`KIN Homecare API พร้อมใช้งานที่ http://localhost:${port}/api`);
});
