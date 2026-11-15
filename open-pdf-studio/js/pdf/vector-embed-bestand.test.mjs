// Vectorknipsel uit een bestand: de app levert de bronpagina al als
// eenpagina-PDF (extract_pdf_page). knipselAlsMiniPdfVanBestand voegt alleen de
// draaiing toe die in de app bestaat en onthoudt het resultaat per pad, lengte,
// pagina en draaiing — het hele bestand komt er niet aan te pas.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName } from 'pdf-lib';

import { knipselAlsMiniPdfVanBestand, paginaRotatie, appVakNaarPdfVak } from './vector-embed.js';

async function eenPagina({ rotatie = 0 } = {}) {
  const d = await PDFDocument.create();
  const p = d.addPage([600, 400]);
  p.setCropBox(10, 20, 500, 300);
  p.drawLine({ start: { x: 50, y: 50 }, end: { x: 400, y: 250 } });
  if (rotatie) p.node.set(PDFName.of('Rotate'), d.context.obj(rotatie));
  return d.save();
}

test('zonder app-draaiing komt de pagina-PDF ongewijzigd terug, één keer opgehaald', async () => {
  const pagina = await eenPagina();
  let opgehaald = 0;
  const haal = async () => { opgehaald++; return pagina; };
  const a = await knipselAlsMiniPdfVanBestand('/set/a.pdf', 4, 0, haal, 1000);
  const b = await knipselAlsMiniPdfVanBestand('/set/a.pdf', 4, 360, haal, 1000);
  assert.equal(a, pagina);
  assert.equal(b, pagina, 'een hele slag is geen draaiing');
  assert.equal(opgehaald, 1, 'uit de cache');
  await knipselAlsMiniPdfVanBestand('/set/a.pdf', 5, 0, haal, 1000);
  await knipselAlsMiniPdfVanBestand('/set/a.pdf', 4, 0, haal, 2000);
  assert.equal(opgehaald, 3, 'een andere pagina of een andere bestandslengte haalt opnieuw');
});

test('een draaiing die alleen in de app bestaat komt bij de /Rotate van de pagina', async () => {
  const pagina = await eenPagina({ rotatie: 90 });
  const mini = await knipselAlsMiniPdfVanBestand('/set/b.pdf', 0, 90, async () => pagina, 1);
  const doc = await PDFDocument.load(mini);
  assert.equal(doc.getPageCount(), 1);
  const p = doc.getPage(0);
  assert.equal(paginaRotatie(p), 180);
  // Het vak rekent met de totale draaiing van de mini-PDF; die is gelijk aan
  // bestand + app, wat het oude pad apart optelde.
  const cb = p.getCropBox();
  const vak = { x: 30, y: 40, width: 100, height: 60 };
  assert.deepEqual(appVakNaarPdfVak(vak, cb, paginaRotatie(p)), appVakNaarPdfVak(vak, cb, 90 + 90));
});

test('een mislukte ophaalpoging blijft niet in de cache', async () => {
  const pagina = await eenPagina();
  let poging = 0;
  const haal = async () => { poging++; if (poging === 1) throw new Error('file-changed-on-disk'); return pagina; };
  await assert.rejects(knipselAlsMiniPdfVanBestand('/set/c.pdf', 0, 0, haal, 7), /file-changed-on-disk/);
  assert.equal(await knipselAlsMiniPdfVanBestand('/set/c.pdf', 0, 0, haal, 7), pagina);
  assert.equal(poging, 2);
});
