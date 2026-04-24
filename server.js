const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const pdfParse = require("pdf-parse");

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors({ origin: "*" }));
app.options("*", cors({ origin: "*" }));
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname)));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "DocBrief API",
    hasGroqKey: !!process.env.GROQ_API_KEY,
    nodeVersion: process.version
  });
});

app.post("/parse-pdf", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const data = await pdfParse(req.file.buffer);
    res.json({ text: data.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/summarize", async (req, res) => {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GROQ_API_KEY not set" });

    const { messages } = req.body;
    if (!messages) return res.status(400).json({ error: "Missing messages" });

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 1000,
        messages,
      }),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`DocBrief running on port ${PORT}`));
