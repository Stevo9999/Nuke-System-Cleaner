// Tiny static server so the in-app browser can load the demo page and sounds/*.mp3. Run: node demo-server.cjs
// Loopback only; serves index.html and sounds/<slug>.mp3 and nothing else.
const http = require("http"), fs = require("fs"), path = require("path");

function createDemoServer() {
  return http.createServer((req, res) => {
    const deny = code => { res.writeHead(code); res.end(); };
    if (req.method !== "GET" && req.method !== "HEAD") return deny(405);
    let name;
    try { name = decodeURIComponent((req.url || "/").split("?")[0]); } catch { return deny(400); }
    let file;
    if (name === "/" || name === "/index.html") file = path.join(__dirname, "index.html");
    else {
      const m = /^\/sounds\/([A-Za-z0-9._-]{1,64}\.mp3)$/.exec(name);
      if (!m) return deny(404);
      file = path.join(__dirname, "sounds", m[1]);
    }
    const rel = path.relative(__dirname, file);   // containment by path.relative, never a string prefix
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return deny(403);
    fs.readFile(file, (err, data) => {
      if (err) return deny(404);
      res.writeHead(200, { "Content-Type": file.endsWith(".mp3") ? "audio/mpeg" : "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" });
      res.end(data);
    });
  });
}

module.exports = { createDemoServer };
if (require.main === module) {
  createDemoServer().listen(8765, "127.0.0.1", () => console.log("nuke page on http://127.0.0.1:8765"));
}
