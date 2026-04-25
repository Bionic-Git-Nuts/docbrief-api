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
  res.json({ status: "ok", version: "8.0", service: "DocBrief API", hasGeminiKey: !!process.env.GEMINI_API_KEY });
});

async function extractText(base64, name) {
  const buffer = Buffer.from(base64, "base64");
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
  return text.replace(/\s+/g, " ").trim();
}

app.post("/parse-file", async (req, res) => {
  try {
    const { data, name } = req.body;
    if (!data || !name) return res.status(400).json({ error: "Missing file data" });
    const text = await extractText(data, name);
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/compare", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

    const { file1, file2 } = req.body;
    if (!file1 || !file2) return res.status(400).json({ error: "Missing files" });

    const text1 = await extractText(file1.data, file1.name);
    const text2 = await extractText(file2.data, file2.name);

    const prompt = `You are a document comparison expert. Compare these two documents and identify all key differences.

Return ONLY a JSON object in this exact format, no other text:
{
  "summary": "One sentence overview of the main difference between the documents",
  "differences": [
    {
      "category": "Category name (e.g. Content, Tone, Structure, Data, Dates, Names)",
      "doc1": "What document 1 says",
      "doc2": "What document 2 says"
    }
  ],
  "similarity": 85
}

similarity is a number 0-100 representing how similar the documents are.

DOCUMENT 1 (${file1.name}):
${text1.slice(0, 15000)}

DOCUMENT 2 (${file2.name}):
${text2.slice(0, 15000)}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 2000 }
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || "Gemini error" });

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    res.json({ result: text });
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

app.listen(PORT, () => console.log(`DocBrief v8.0 running on port ${PORT}`));
