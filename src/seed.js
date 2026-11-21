const bcrypt = require('bcryptjs');
const db = require('./db');

const DEMO_PASSWORD = 'TalentBridge#2026';

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return false;
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const addUser = db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)');
  const addProfile = db.prepare(`INSERT INTO profiles (user_id,headline,skills,hourly_rate,province,city,verified,rating,jobs_done,avatar_color)
    VALUES (?,?,?,?,?,?,1,?,?,?)`);
  const addJob = db.prepare(`INSERT INTO jobs (client_id,title,description,category,type,province,city,pay_min,pay_max,pay_unit,icon,gradient)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  db.transaction(() => {
    addUser.run('TalentBridge Admin', 'admin@talentbridge.test', hash, 'admin');
    const client = addUser.run('Demo Client', 'client@talentbridge.test', hash, 'client').lastInsertRowid;
    const talent = [
      ['Thando M.', 'Electrician', ['Wiring', 'Solar', 'Compliance'], 350, 'Gauteng', 'Johannesburg', 4.9, 212, '#6a4bd8'],
      ['Lerato K.', 'Graphic Designer', ['Branding', 'Figma', 'Print'], 280, 'Western Cape', 'Cape Town', 5.0, 148, '#2e7d5b'],
      ['Sipho N.', 'Plumber', ['Geysers', 'Leaks', 'Bathrooms'], 300, 'KwaZulu-Natal', 'Durban', 4.8, 186, '#b4562e'],
      ['Naledi P.', 'Bookkeeper', ['Xero', 'VAT', 'Payroll'], 220, 'Gauteng', 'Pretoria', 4.9, 97, '#8a5a00'],
      ['Ayanda D.', 'Web Developer', ['React', 'WordPress', 'SEO'], 320, 'Eastern Cape', 'Gqeberha', 4.9, 64, '#3b6fb6'],
      ['Zanele M.', 'Home Care Pro', ['Cleaning', 'Laundry', 'Elder care'], 75, 'Western Cape', 'Cape Town', 5.0, 305, '#17241f'],
    ];
    talent.forEach(([name, headline, skills, rate, province, city, rating, done, color], i) => {
      const id = addUser.run(name, `talent${i + 1}@talentbridge.test`, hash, 'talent').lastInsertRowid;
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
    // Bios and a few open bids so dashboards show real activity on a fresh install.
    const bios = [
      'Registered electrician with 9 years on homes and small businesses. COC certificates issued on every job.',
      'Brand and print designer. I help small businesses look as good as the service they give.',
      'Plumber for geysers, leaks and bathroom refits across eThekwini. Same-day call-outs where possible.',
      'Bookkeeper for SMEs: monthly books, VAT201 and payroll on Xero and Sage.',
      'Web developer building fast React and WordPress sites with local payment gateways.',
      'Home care and cleaning professional. Reliable, discreet and references available.',
    ];
    const ids = db.prepare("SELECT id FROM users WHERE role = 'talent' ORDER BY id").all().map(r => r.id);
    ids.forEach((id, i) => db.prepare('UPDATE profiles SET bio = ?, languages = ? WHERE user_id = ?').run(bios[i], i % 2 ? 'English, isiXhosa' : 'English, isiZulu', id));
    const jobIds = db.prepare('SELECT id, title FROM jobs ORDER BY id').all();
    const bid = db.prepare("INSERT INTO applications (job_id,user_id,message,bid_amount,delivery_days,updated_at) VALUES (?,?,?,?,?,datetime('now'))");
    const byTitle = (t) => jobIds.find(j => j.title === t).id;
    bid.run(byTitle('Website Developer'), ids[4], 'I have shipped three booking sites this year and can share them. I would start with a clickable prototype in week one.', 18000, 30);
    bid.run(byTitle('Brand Designer'), ids[1], 'Fintech brands are my favourite brief. I would begin with a short workshop and three directions.', 28000, 21);
    bid.run(byTitle('Plumber'), ids[2], 'Based in Durban with my own tools and bakkie. Geyser installs within 48 hours.', 320, 2);
    bid.run(byTitle('Domestic Cleaner'), ids[5], 'Five years with Atlantic Seaboard families. Flexible mornings.', 70, 1);
    db.prepare('UPDATE users SET email_verified = 1').run();
  })();
  return true;
}

// Production: create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD (min 10 chars) if no admin exists yet.
function ensureAdmin() {
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: pw } = process.env;
  if (!email || !pw || pw.length < 10) return false;
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return false;
  db.prepare('INSERT INTO users (name,email,password_hash,role,email_verified) VALUES (?,?,?,?,1)').run('TalentBridge Admin', email, bcrypt.hashSync(pw, 11), 'admin');
  return true;
}

module.exports = { seed, ensureAdmin, DEMO_PASSWORD };
if (require.main === module) console.log(seed() ? 'Seeded demo data.' : 'Database already has data; nothing seeded.');
