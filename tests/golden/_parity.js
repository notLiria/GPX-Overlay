
const Model = require(process.argv[2]);
const fs = require('fs');
const cases = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const out = [];
for (const c of cases) {
  const tel = JSON.parse(fs.readFileSync(c.telPath, 'utf8'));
  out.push(Model.fmtVal(c.w, c.t, tel));
}
process.stdout.write(JSON.stringify(out));
