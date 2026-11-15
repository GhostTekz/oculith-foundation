// Real PDF.js/PDFium WASM pixel comparison on synthetic cropped and rotated
// pages. No renderer, worker or page metadata is mocked.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, configFile: false, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'pixel-test-page', configureServer(s) {
    s.middlewares.use((req, res, next) => {
      if (req.url !== '/__pixel-test') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><body></body></html>');
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  const page = await browser.newPage();
  let wasmFetched = false;
  page.on('response', (response) => {
    if (response.url().includes('pdfium.wasm') && response.headers()['content-type']?.includes('wasm')) wasmFetched = true;
  });
  await page.goto(`${server.resolvedUrls.local[0]}__pixel-test`);
  const result = await page.evaluate(async () => {
    const { PDFDocument, PDFName, PDFNumber, degrees, rgb } = await import('/node_modules/pdf-lib/dist/pdf-lib.esm.js');
    const pdfjs = await import('/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs';
    const { pdfiumWebRasterizer } = await import('/js/pdf/pdfium-web/pdfium-web-rasterizer.js');
    const doc = await PDFDocument.create();
    for (const userUnit of [1, 2]) for (const rotation of [0, 90, 180, 270]) {
      const p = doc.addPage([300, 260]);
      p.setCropBox(40, 60, 200, 180);
      p.setRotation(degrees(rotation));
      p.node.set(PDFName.of('UserUnit'), PDFNumber.of(userUnit));
      p.drawRectangle({ x: 70, y: 100, width: 40, height: 25, color: rgb(0, 0, 0) });
    }
    const bytes = await doc.save();
    const task = pdfjs.getDocument({ data: bytes.slice() });
    const pdf = await task.promise;
    const raster = pdfiumWebRasterizer({ bytes, inTauri: false, toonNms: () => null });
    const bounds = (canvas) => {
      const { width, height } = canvas;
      const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      let left = width, right = -1, top = height, bottom = -1, count = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = 4 * (y * width + x);
        if (data[i] < 64 && data[i + 1] < 64 && data[i + 2] < 64 && data[i + 3] > 200) {
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y); count++;
        }
      }
      return { left, right, top, bottom, count };
    };
    const cases = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const p = await pdf.getPage(n);
      for (const extra of [0, 90, 180, 270]) for (const k of [1, 2]) {
        const viewport = p.getViewport({ scale: 1.25, rotation: (p.rotate + extra) % 360 });
        let fullBounds;
        for (const region of [false, true]) {
          const crop = region ? { minX: Math.max(0, fullBounds.left / k - 5),
            minY: Math.max(0, fullBounds.top / k - 5) } : { minX: 0, minY: 0 };
          const width = region ? fullBounds.right - fullBounds.left + 1 + 10 * k : Math.ceil(viewport.width * k);
          const height = region ? fullBounds.bottom - fullBounds.top + 1 + 10 * k : Math.ceil(viewport.height * k);
          const js = document.createElement('canvas'); js.width = width; js.height = height;
          await p.render({ canvasContext: js.getContext('2d'), viewport,
            transform: [k, 0, 0, k, -crop.minX * k, -crop.minY * k], annotationMode: 0 }).promise;
          const expected = bounds(js);
          if (!region) fullBounds = expected;
          const options = { page: p, viewport, k, breedte: width, hoogte: height };
          const actualCanvas = region
            ? await raster.renderUitsnede({ ...options, uitsnede: crop, dpr: k })
            : await raster.renderPagina(options);
          cases.push({ userUnit: p.userUnit, rotation: p.rotate, extra, k, region,
            expected, actual: actualCanvas ? bounds(actualCanvas) : null });
        }
      }
    }
    await task.destroy();
    return { cases };
  });
  result.wasmFetched = wasmFetched;
  assert.equal(wasmFetched, true, 'the actual PDFium WASM must load');
  assert.equal(result.cases.length, 128);
  for (const c of result.cases) {
    const label = JSON.stringify({ ...c, expected: undefined, actual: undefined });
    assert.ok(c.actual, `PDFium returned no pixels: ${label}`);
    assert.ok(c.expected.count > 0 && c.actual.count > 0, `rectangle is missing: ${label}`);
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      assert.ok(Math.abs(c.expected[edge] - c.actual[edge]) <= 1,
        `${edge}: PDF.js ${c.expected[edge]}, PDFium ${c.actual[edge]}: ${label}`);
    }
  }
  if (process.env.OCUDRAW_PIXEL_RECEIPT) await writeFile(process.env.OCUDRAW_PIXEL_RECEIPT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`PDFium WASM/PDF.js pixel comparison passed: ${result.cases.length} full-page/region renders, UserUnit 1/2, CropBox, all page/view rotations and DPR 1/2.`);
} finally {
  await browser?.close();
  await server.close();
}
