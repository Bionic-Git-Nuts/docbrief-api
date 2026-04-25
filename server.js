const express = require("express");
const cors = require("cors");
const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.options("*", cors({ origin: "*" }));
app.use(express.json({ limit: "100mb" }));
app.use(express.static(path.join(__dirname)));

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "7.0", service: "DocBrief API", hasGeminiKey: !!process.env.GEMINI_API_KEY });
});

app.post("/parse-file", async (req, res) => {
  try {
    const { data, name } = req.body;
    if (!data || !name) return res.status(400).json({ error: "Missing file data" });

    const buffer = Buffer.from(data, "base64");
    const filename = name.toLowerCase();
    let text = "";

    if (filename.endsWith(".pdf")) {
      const parsed = await pdfParse(buffer);
      text = parsed.text;
    } else if (filename.endsWith(".docx") || filename.endsWith(".doc")) {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else {
      text = buffer.toString("utf-8");
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

app.listen(PORT, () => console.log(`DocBrief v7.0 running on port ${PORT}`));
