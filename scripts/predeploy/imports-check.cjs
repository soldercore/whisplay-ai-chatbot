// Static check: every member the given compiled file reads from a local module
// (alias_1.name) is exported by that module's compiled file. Executes nothing.
const fs = require("fs"), path = require("path");
const file = path.resolve(process.argv[2]);
const src = fs.readFileSync(file, "utf8");
let bad = 0, checked = 0, modules = 0;
for (const m of src.matchAll(/const (\w+) = (?:__importDefault\(|__importStar\()?require\("(\.[^"]+)"\)/g)) {
  const [, alias, rel] = m;
  let target = path.resolve(path.dirname(file), rel);
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) target += fs.existsSync(target + ".js") ? ".js" : "/index.js";
  if (!fs.existsSync(target)) { console.log("MISSING MODULE", rel); bad++; continue; }
  modules++;
  const text = fs.readFileSync(target, "utf8");
  const exported = new Set(["default"]);
  for (const x of text.matchAll(/exports\.(\w+)\s*=/g)) exported.add(x[1]);
  for (const x of text.matchAll(/Object\.defineProperty\(exports, "(\w+)"/g)) exported.add(x[1]);
  const names = new Set([...src.matchAll(new RegExp("\\b" + alias + "\\.(\\w+)", "g"))].map(x => x[1]));
  for (const n of names) { checked++; if (!exported.has(n)) { console.log("UNRESOLVED", rel, n); bad++; } }
}
console.log(`modules ${modules}, member references ${checked}, unresolved ${bad}`);
process.exitCode = bad ? 1 : 0;
