import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function run() {
  try {
    const res = await ai.models.embedContent({
      model: 'text-embedding-004',
      contents: 'Hello world'
    });
    console.log("Vector length:", res.embeddings[0].values.length);
  } catch (e) {
    console.error(e);
  }
}
run();
