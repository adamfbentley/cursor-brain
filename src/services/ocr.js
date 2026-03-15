const { createWorker } = require("tesseract.js");

let workerPromise;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker("eng");
      return worker;
    })();
  }
  return workerPromise;
}

async function extractTextFromImage(imageBuffer) {
  const worker = await getWorker();
  const result = await worker.recognize(imageBuffer);
  return (result?.data?.text || "").trim();
}

module.exports = {
  extractTextFromImage
};
