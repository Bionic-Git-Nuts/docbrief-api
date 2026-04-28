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
  res.json({ status: "ok", version: "14.0", service: "Accipiter API", hasApiKey: !!process.env.MISTRAL_API_KEY });
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
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 5000) {
    text = text.slice(0, 5000) + " [Document truncated]";
  }
  return text;
}

async function fetchUrl(url) {
  const resp = await fetch(url);
  const html = await resp.text();
  let text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length > 5000) text = text.slice(0, 5000) + " [Truncated]";
  return text;
}

async function callMistral(apiKey, prompt, maxTokens = 1000) {
  if (prompt.length > 6000) prompt = prompt.slice(0, 6000) + " [Truncated]";
  const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "mistral-small-latest",
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error?.message || "Mistral error");
  return data.choices?.[0]?.message?.content || "";
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

function getApiKey(req) {
  return req.body.userApiKey || process.env.MISTRAL_API_KEY;
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
    const apiKey = getApiKey(req);
    if (!apiKey) return res.status(500).json({ error: "No API key set. Please add your Mistral API key in Settings." });
    const { messages } = req.body;
    if (!messages) return res.status(400).json({ error: "Missing messages" });
    let userMessage = messages.find(m => m.role === "user")?.content || "";
    if (userMessage.length > 6000) userMessage = userMessage.slice(0, 6000) + " [Truncated]";
    const text = await callMistral(apiKey, userMessage, 1000);
    res.json({ choices: [{ message: { content: text } }] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/compare", async (req, res) => {
  try {
    const apiKey = getApiKey(req);
    if (!apiKey) return res.status(500).json({ error: "No API key set." });
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
${text1.slice(0, 4000)}

DOCUMENT 2 (${file2.name}):
${text2.slice(0, 4000)}`;

    const result = await callMistral(apiKey, prompt, 1000);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/extract", async (req, res) => {
  try {
    const apiKey = getApiKey(req);
    if (!apiKey) return res.status(500).json({ error: "No API key set." });
    const { data, name, url, text: pastedText, query, format } = req.body;
    if (!query) return res.status(400).json({ error: "Missing query" });

    let sourceText = "";
    if (url) {
      sourceText = await fetchUrl(url);
    } else if (data && name) {
      sourceText = await extractText(data, name);
    } else if (pastedText) {
      sourceText = pastedText.slice(0, 5000);
    } else {
      return res.status(400).json({ error: "Missing text, file or URL" });
    }

    const prompt = `From the following document, extract: ${query}

Present the extracted information clearly and completely. Use plain text with line breaks to separate items.
Do not include any introduction or explanation — just the extracted content.

DOCUMENT:
${sourceText}`;

    const extracted = await callMistral(apiKey, prompt, 1000);

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
    const apiKey = getApiKey(req);
    if (!apiKey) return res.status(500).json({ error: "No API key set." });
    const { data, name, url, text: pastedText, targetLanguage, format } = req.body;
    if (!targetLanguage) return res.status(400).json({ error: "Missing target language" });

    let sourceText = "";
    if (url) {
      sourceText = await fetchUrl(url);
    } else if (data && name) {
      sourceText = await extractText(data, name);
    } else if (pastedText) {
      sourceText = pastedText.slice(0, 5000);
    } else {
      return res.status(400).json({ error: "Missing text, file or URL" });
    }

    const prompt = `Translate the following document to ${targetLanguage}. Preserve the original formatting and structure as much as possible. Output only the translated text, nothing else.

DOCUMENT:
${sourceText}`;

    const translated = await callMistral(apiKey, prompt, 1000);

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

app.listen(PORT, () => console.log(`Accipiter v14.0 running on port ${PORT}`));
