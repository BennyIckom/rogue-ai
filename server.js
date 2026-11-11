const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
let MODEL;
let API_KEY;
const recent = new Map();

function loadEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
loadEnv();
MODEL = process.env.OPENAI_MODEL || "gpt-6-astra";
API_KEY = process.env.OPENAI_API_KEY;

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}
function getText(output = []) {
  return output.flatMap(item => item.content || [])
    .filter(part => part.type === "output_text")
    .map(part => part.text || "").join("\n");
}
function getCitations(output = []) {
  const found = [];
  for (const item of output) {
    for (const part of (item.content || [])) {
      for (const a of (part.annotations || [])) {
        if (a.type === "url_citation" && a.url_citation?.url) {
          const c = a.url_citation;
          if (!found.some(x => x.url === c.url)) found.push({ title: c.title || c.url, url: c.url });
        }
      }
    }
  }
  return found;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, configured: Boolean(API_KEY), model: MODEL });
  }

  if (req.method === "POST" && url.pathname === "/api/research") {
    const ip = req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const last = recent.get(ip) || 0;
    if (now - last < 2500) return send(res, 429, { error: "Please wait a moment before starting another research run." });
    recent.set(ip, now);

    if (!API_KEY) return send(res, 503, { error: "ROGUE is not connected yet. Add your OpenAI API key to the .env file, then restart the server." });

    let raw = "";
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 12000) return send(res, 413, { error: "Your research question is too long." });
      }
      const body = JSON.parse(raw || "{}");
      const question = String(body.question || "").trim();
      if (question.length < 3) return send(res, 400, { error: "Enter a research question with at least 3 characters." });

      const instructions = [
        "You are ROGUE, an independent research assistant.",
        "Be direct, rigorous, curious, and transparent about uncertainty.",
        "Research the user's question using current web sources.",
        "Prioritize primary sources, official records, academic work, and reputable reporting.",
        "Separate verified facts from interpretation. Never invent facts, quotes, statistics, or sources.",
        "Explain disagreements between sources and identify information that could not be verified.",
        "Use clear headings and concise bullet points. Include dates where relevant.",
        "Do not claim to have performed actions outside this research response."
      ].join(" ");

      const apiRes = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          instructions,
          input: question,
          tools: [{ type: "web_search" }],
          tool_choice: "required",
          include: ["web_search_call.action.sources"]
        }),
        signal: AbortSignal.timeout(120000)
      });

      const data = await apiRes.json().catch(() => ({}));
      if (!apiRes.ok) {
        const message = data.error?.message || `Research service returned HTTP ${apiRes.status}.`;
        return send(res, 502, { error: message });
      }
      const answer = getText(data.output || []);
      const citations = getCitations(data.output || []);
      return send(res, 200, { answer: answer || "No answer text was returned. Try rephrasing your question.", citations, model: MODEL });
    } catch (err) {
      const message = err.name === "TimeoutError" ? "The research request timed out. Try a narrower question." :
        err instanceof SyntaxError ? "The request could not be read. Please try again." :
        "ROGUE could not complete that request. Check your connection and server logs.";
      return send(res, 500, { error: message });
    }
  }

  if (req.method === "GET") {
    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const target = path.resolve(PUBLIC, requested);
    if (!target.startsWith(PUBLIC + path.sep) && target !== path.join(PUBLIC, "index.html")) return send(res, 403, "Forbidden", "text/plain");
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return send(res, 404, "Not found", "text/plain");
    const ext = path.extname(target);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
    return send(res, 200, fs.readFileSync(target), types[ext] || "application/octet-stream");
  }
  send(res, 405, { error: "Method not allowed." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ROGUE AI running at http://localhost:${PORT}`);
});
