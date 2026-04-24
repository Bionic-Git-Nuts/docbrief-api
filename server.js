const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

app.use(cors({ origin: "*" }));
app.options("*", cors({ origin: "*" }));
app.use(express.json({ limit: "100mb" }));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.use(express.static(path.join(__dirname)));

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "6.0", service: "DocBrief API", hasGeminiKey: !!process.env.GEMINI_API_KEY });
});

app.post("/parse-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const mime = req.file.mimetype;
    const name = req.file.originalname.toLowerCase();
    let text = "";

    if (mime === "application/pdf" || name.endsWith(".pdf")) {
      const data = await pdfParse(req.file.buffer);
      text = data.text;
    } else if (
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      name.endsWith(".docx")
    ) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
    } else if (mime === "application/msword" || name.endsWith(".doc")) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
    } else {
      text = req.file.buffer.toString("utf-8");
    }

    text = text.replace(/\s+/g, " ").trim();
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/summarize", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

    const { messages } = req.body;
    if (!messages) return res.status(400).json({ error: "Missing messages" });

    const userMessage = messages.find(m => m.role === "user")?.content || "";

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: userMessage }] }],
          generationConfig: { maxOutputTokens: 1500 }
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || "Gemini error" });

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    res.json({ choices: [{ message: { content: text } }] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`DocBrief v6.0 running on port ${PORT}`));
