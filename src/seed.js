const bcrypt = require('bcryptjs');
const db = require('./db');

const DEMO_PASSWORD = 'Siira#2026';

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return false;
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const addUser = db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)');
  const addProfile = db.prepare(`INSERT INTO profiles (user_id,headline,skills,hourly_rate,province,city,verified,rating,jobs_done,avatar_color)
    VALUES (?,?,?,?,?,?,1,?,?,?)`);
  const addJob = db.prepare(`INSERT INTO jobs (client_id,title,description,category,type,province,city,pay_min,pay_max,pay_unit,icon,gradient)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  db.transaction(() => {
    const client = addUser.run('Demo Client', 'client@siira.test', hash, 'client').lastInsertRowid;
    const talent = [
      ['Thando M.', 'Electrician', ['Wiring', 'Solar', 'Compliance'], 350, 'Gauteng', 'Johannesburg', 4.9, 212, '#0a3d8f'],
      ['Lerato K.', 'Graphic Designer', ['Branding', 'Figma', 'Print'], 280, 'Western Cape', 'Cape Town', 5.0, 148, '#0f5aa8'],
      ['Sipho N.', 'Plumber', ['Geysers', 'Leaks', 'Bathrooms'], 300, 'KwaZulu-Natal', 'Durban', 4.8, 186, '#c25400'],
      ['Naledi P.', 'Bookkeeper', ['Xero', 'VAT', 'Payroll'], 220, 'Gauteng', 'Pretoria', 4.9, 97, '#b85f00'],
      ['Ayanda D.', 'Web Developer', ['React', 'WordPress', 'SEO'], 320, 'Eastern Cape', 'Gqeberha', 4.9, 64, '#2f7be0'],
      ['Zanele M.', 'Home Care Pro', ['Cleaning', 'Laundry', 'Elder care'], 75, 'Western Cape', 'Cape Town', 5.0, 305, '#062a63'],
    ];
    talent.forEach(([name, headline, skills, rate, province, city, rating, done, color], i) => {
      const id = addUser.run(name, `talent${i + 1}@siira.test`, hash, 'talent').lastInsertRowid;
      addProfile.run(id, headline, JSON.stringify(skills), rate, province, city, rating, done, color);
    });
    const g = (a, b, c) => `linear-gradient(120deg,${a},${b} 65%,${c})`;
    const jobs = [
      ['Site Supervisor', 'Lead a commercial build crew on a high-rise project. SAMTRAC and 5+ years preferred.', 'Construction', 'Full-Time', 'Gauteng', 'Sandton', 18000, 25000, 'month', 'hat', g('#06183d', '#0a3d8f', '#2f6fd6')],
      ['Domestic Cleaner', 'Join a trusted home-care team serving Atlantic Seaboard families. Flexible hours.', 'Cleaning & Care', 'Part-Time', 'Western Cape', 'Cape Town', 60, 80, 'hour', 'spray', g('#06183d', '#0f5aa8', '#1f8fd6')],
      ['Website Developer', 'Build and launch a booking site for a growing SME in six weeks.', 'Creative & Digital', 'Freelance', 'Gauteng', 'Pretoria', 150, 300, 'hour', 'code', g('#06183d', '#0a3d8f', '#2f7be0')],
      ['Qualified Electrician', "Wireman's licence required. Residential and light commercial installs.", 'Trades & Repairs', 'Full-Time', 'KwaZulu-Natal', 'Durban', 22000, 30000, 'month', 'bolt', g('#3a1a00', '#c25400', '#ff8a00')],
      ['Delivery Driver', 'Same-day deliveries around Nelson Mandela Bay. Own vehicle and PrDP preferred.', 'Transport & Delivery', 'Short-Term', 'Eastern Cape', 'Gqeberha', 350, 550, 'day', 'truck', g('#2a1400', '#b85f00', '#ff9d1f')],
      ['Brand Designer', 'Own the visual identity for a fast-growing fintech.', 'Creative & Digital', 'Full-Time', 'Western Cape', 'Cape Town', 25000, 35000, 'month', 'pen', g('#06183d', '#0a3d8f', '#2f7be0')],
      ['Office Administrator', 'Front-desk, scheduling and supplier admin for a busy Joburg office.', 'Business Support', 'Full-Time', 'Gauteng', 'Johannesburg', 14000, 18000, 'month', 'brief', g('#06183d', '#071d4a', '#0a3d8f')],
      ['Plumber', 'Geyser installs and repairs across eThekwini.', 'Trades & Repairs', 'Freelance', 'KwaZulu-Natal', 'Durban', 250, 400, 'hour', 'tools', g('#3a1a00', '#c25400', '#ff8a00')],
    ];
    jobs.forEach(j => addJob.run(client, ...j));
  })();
  return true;
}

module.exports = { seed, DEMO_PASSWORD };
if (require.main === module) console.log(seed() ? 'Seeded demo data.' : 'Database already has data; nothing seeded.');
