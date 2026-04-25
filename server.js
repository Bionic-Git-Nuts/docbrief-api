const express = require("express");
const cors = require("cors");
const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.options("*", cors({ origin: "*" }));
app.use(express.json({ limit: "100mb" }));
app.use(express.static(path.join(__dirname)));

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "10.0", service: "DocBrief API", hasGeminiKey: !!process.env.GEMINI_API_KEY });
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

async function fetchUrl(url) {
  const resp = await fetch(url);
  const html = await resp.text();
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 50000);
}

async function callGemini(apiKey, prompt, maxTokens = 2000) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens }
      }),
    }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Gemini error");
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function buildDocx(title, content) {
  const lines = content.split("\n").filter(l => l.trim());
  const paragraphs = [
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: "" }),
    ...lines.map(line => new Paragraph({
      children: [new TextRun({ text: line.trim(), size: 24 })]
    }))
  ];
  const doc = new Document({ sections: [{ properties: {}, children: paragraphs }] });
  return await Packer.toBuffer(doc);
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



app.post("/summarize", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set" });
    const { messages } = req.body;
    if (!messages) return res.status(400).json({ error: "Missing messages" });
    const userMessage = messages.find(m => m.role === "user")?.content || "";
    const text = await callGemini(apiKey, userMessage, 1500);
    res.json({ choices: [{ message: { content: text } }] });
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

DOCUMENT 1 (${file1.name}):
${text1.slice(0, 15000)}

DOCUMENT 2 (${file2.name}):
${text2.slice(0, 15000)}`;

    const result = await callGemini(apiKey, prompt, 2000);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/extract", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set" });
    const { data, name, url, text: pastedText, query, format } = req.body;
    if (!query) return res.status(400).json({ error: "Missing query" });

    let sourceText = "";
    if (url) {
      sourceText = await fetchUrl(url);
    } else if (data && name) {
      sourceText = await extractText(data, name);
    } else if (pastedText) {
      sourceText = pastedText;
    } else {
      return res.status(400).json({ error: "Missing text, file or URL" });
    }

    const prompt = `From the following document, extract: ${query}

Present the extracted information clearly and completely. Use plain text with line breaks to separate items.
Do not include any introduction or explanation — just the extracted content.

DOCUMENT:
${sourceText.slice(0, 50000)}`;

    const extracted = await callGemini(apiKey, prompt, 3000);

    if (format === "txt") {
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Content-Disposition", `attachment; filename="extracted.txt"`);
      res.send(extracted);
    } else {
      const buffer = await buildDocx(`Extracted: ${query}`, extracted);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="extracted.docx"`);
      res.send(buffer);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/translate", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set" });
    const { data, name, url, text: pastedText, targetLanguage, format } = req.body;
    if (!targetLanguage) return res.status(400).json({ error: "Missing target language" });

    let sourceText = "";
    if (url) {
      sourceText = await fetchUrl(url);
    } else if (data && name) {
      sourceText = await extractText(data, name);
    } else if (pastedText) {
      sourceText = pastedText;
    } else {
      return res.status(400).json({ error: "Missing text, file or URL" });
    }

    const prompt = `Translate the following document to ${targetLanguage}. Preserve the original formatting and structure as much as possible. Output only the translated text, nothing else.

DOCUMENT:
${sourceText.slice(0, 50000)}`;

    const translated = await callGemini(apiKey, prompt, 4000);

    if (format === "txt") {
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Content-Disposition", `attachment; filename="translated_${targetLanguage}.txt"`);
      res.send(translated);
    } else {
      const buffer = await buildDocx(`Translation (${targetLanguage})`, translated);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="translated_${targetLanguage}.docx"`);
      res.send(buffer);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`DocBrief v10.0 running on port ${PORT}`));
