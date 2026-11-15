import { createSignal, createMemo, For, Show, Switch, Match, onMount } from 'solid-js';
import Dialog from '../Dialog.jsx';
import { closeDialog } from '../../stores/dialogStore.js';
import { sheetRegister } from '../../stores/sheetRegisterStore.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { state } from '../../../core/state.js';
import {
  isTauri, openFileDialog, openFolderDialog, listPdfFiles, readBinaryFile, writeBinaryFile, writeBinaryFileAtomic,
  fileExists, invoke,
} from '../../../core/platform.js';
import { runBatch, batchFileList, setFilePaths } from '../../../batch/runner.js';
import { DEFAULT_SUFFIX, DESKTOP_ONLY_OPS, NO_OUTPUT_OPS, MULTI_OUTPUT_OPS } from '../../../batch/ops.js';
import { STAMP_POSITIONS } from '../../../batch/stamp-place.js';
import { PAGE_SIZE_PRESETS } from '../../../pdf/resize-pages-core.js';
import { allStampTemplates } from '../../../annotations/user-stamps.js';
import { LANGUAGE_OPTIONS } from './OcrLanguageDialog.jsx';
import { loadPrinters, printerList, defaultPrinterName } from '../../stores/printerStore.js';

const NAME = 'batch-ops';

// PDF.js assets for files read here (as flatten-document.js passes them).
const PDFJS_ASSETS = {
  cMapUrl: '/pdfjs/web/cmaps/', cMapPacked: true,
  standardFontDataUrl: '/pdfjs/web/standard_fonts/', wasmUrl: '/pdfjs/web/wasm/',
};

// Which ops take a page choice, and which choices they offer.
const PAGE_CHOICES = {
  flatten: ['all', 'first', 'last', 'range'], rotate: ['all', 'first', 'last', 'range'],
  headersFooters: ['all', 'first', 'range'], applyStamp: ['all', 'first', 'last', 'range'],
  cropPageSetup: ['all', 'first', 'last', 'range'], ocr: ['all', 'first', 'last', 'range'],
  print: ['all', 'first', 'last', 'range'],
};
const PAGE_LABEL = { all: 'pagesAll', first: 'pagesFirst', last: 'pagesLast', range: 'pagesRange' };
const HF_SLOTS = ['headerLeft', 'headerCenter', 'headerRight', 'footerLeft', 'footerCenter', 'footerRight'];

const pathKey = (path) => String(path ?? '').replace(/\\/g, '/').toLocaleLowerCase();
const baseName = (path) => String(path ?? '').split(/[\\/]/u).pop();

// Batch operations (docs/reference/editor/sets-and-batch.md): one Batch menu operation over files
// from the current Set, a file pick or a folder, through js/batch/runner.js.
export default function BatchOpsDialog(props) {
  const { t } = useTranslation('common');
  const { t: td } = useTranslation('dialogs');
  const op = props.data?.op || 'flatten';
  const tb = (key, options) => t(`batchOps.${key}`, options);
  const ts = (key, options) => t(`batchSummary.${key}`, options);
  const desktop = isTauri();
  const writes = !NO_OUTPUT_OPS.has(op);

  const [files, setFiles] = createSignal(batchFileList(setFilePaths(sheetRegister())));
  const [selected, setSelected] = createSignal(-1);
  const [running, setRunning] = createSignal(false);
  const [progress, setProgress] = createSignal(null);
  const [log, setLog] = createSignal({}); // path -> entry
  const [writtenNow, setWrittenNow] = createSignal({}); // path -> output path
  const [message, setMessage] = createSignal('');
  const [confirming, setConfirming] = createSignal(false);

  // Options.
  const [pageMode, setPageMode] = createSignal('all');
  const [pageRange, setPageRange] = createSignal('');
  const [allowUnflatten, setAllowUnflatten] = createSignal(true);
  const [delta, setDelta] = createSignal(90);
  const [splitBy, setSplitBy] = createSignal('every');
  const [splitEvery, setSplitEvery] = createSignal(1);
  const [splitRanges, setSplitRanges] = createSignal('');
  const [hf, setHf] = createSignal({ headerLeft: '', headerCenter: '', headerRight: '{filename}', footerLeft: '', footerCenter: 'Page {page} of {pages}', footerRight: '{date}', fontSize: 10, color: '#000000' });
  const stamps = allStampTemplates();
  const [stampId, setStampId] = createSignal(stamps[0]?.id || '');
  const [position, setPosition] = createSignal('top-right');
  const [margin, setMargin] = createSignal(36);
  const [cropMode, setCropMode] = createSignal('margins');
  const [padding, setPadding] = createSignal(0);
  const [threshold, setThreshold] = createSignal(250);
  const [preset, setPreset] = createSignal('a4');
  const [orientation, setOrientation] = createSignal('portrait');
  const [customW, setCustomW] = createSignal(210);
  const [customH, setCustomH] = createSignal(297);
  const [level, setLevel] = createSignal('medium');
  const [lang, setLang] = createSignal('auto');
  const [printer, setPrinter] = createSignal('');
  const [copies, setCopies] = createSignal(1);
  // Output.
  const [outputMode, setOutputMode] = createSignal('folder');
  const [suffix, setSuffix] = createSignal(DEFAULT_SUFFIX[op] ?? '_batch');
  let controller = null;

  onMount(() => {
    if (op === 'print' && desktop) {
      loadPrinters().then(() => { if (!printer()) setPrinter(defaultPrinterName() || printerList()[0]?.Name || ''); });
    }
  });

  const unavailable = () => DESKTOP_ONLY_OPS.has(op) && !desktop;

  const addPaths = (paths) => {
    setFiles(batchFileList([...files().map((f) => f.path), ...(paths || [])]));
    setMessage('');
  };
  const addSet = () => {
    const paths = setFilePaths(sheetRegister());
    if (!paths.length) { setMessage(ts('setEmpty')); return; }
    addPaths(paths);
  };
  const addFiles = async () => {
    const picked = await openFileDialog(['pdf'], { multiple: true });
    if (picked) addPaths(Array.isArray(picked) ? picked : [picked]);
  };
  const addFolder = async () => {
    const dir = await openFolderDialog(ts('addFolder'));
    if (!dir) return;
    try { addPaths(await listPdfFiles(dir)); } catch (error) { setMessage(tb('failed', { error: error?.message || error })); }
  };
  const removeSelected = () => {
    const index = selected();
    if (index < 0) return;
    setFiles(files().filter((_, i) => i !== index));
    setSelected(Math.min(index, files().length - 1));
  };

  const pagesChoice = () => ({ mode: pageMode(), range: pageRange() });
  const options = () => {
    switch (op) {
      case 'flatten': return { pages: pagesChoice(), allowUnflatten: allowUnflatten() };
      case 'rotate': return { pages: pagesChoice(), delta: Number(delta()) };
      case 'split': return { by: splitBy(), every: Number(splitEvery()), ranges: splitRanges() };
      case 'headersFooters': return { ...hf(), pages: pagesChoice() };
      case 'applyStamp': return { template: stamps.find((s) => s.id === stampId()) || null, pages: pagesChoice(), position: position(), margin: Number.isFinite(Number(margin())) ? Number(margin()) : 36 };
      case 'cropPageSetup': return { mode: cropMode(), pages: pagesChoice(), paddingMm: Number(padding()), threshold: Number(threshold()),
        preset: preset(), orientation: orientation(), widthMm: Number(customW()), heightMm: Number(customH()) };
      case 'reduceFileSize': return { level: level() };
      case 'ocr': return { pages: pagesChoice(), lang: lang() };
      case 'print': return { pages: pagesChoice(), printer: printer(), copies: Math.max(1, Number(copies()) || 1) };
      default: return {};
    }
  };

  const readFile = async (path) => {
    if (desktop) {
      try { await invoke('allow_fs_scope', { path }); } catch { /* scope already granted */ }
    }
    const bytes = await readBinaryFile(path);
    if (!bytes && !desktop) throw new Error(tb('notInBrowser'));
    return bytes;
  };
  const write = async (path, bytes) => {
    if (desktop) {
      try { await invoke('allow_fs_scope', { path }); } catch { /* scope already granted */ }
      await writeBinaryFileAtomic(path, bytes);
    } else {
      await writeBinaryFile(path, bytes);
    }
  };

  async function context() {
    const [pdfjs] = await Promise.all([import('pdfjs-dist'), import('../../../pdf/loader.js')]);
    const ctx = {
      pdfjs, pdfjsOptions: PDFJS_ASSETS, now: new Date(),
      user: state.defaultAuthor || 'User',
    };
    if (desktop && op === 'ocr') {
      const { ocrOnePage } = await import('../../../pdf/ocr.js');
      ctx.ocrPage = ocrOnePage;
    }
    if (desktop && op === 'print') {
      const { spoolPrintPdf } = await import('../../../pdf/print-job.js');
      ctx.spool = (bytes, name, o) => spoolPrintPdf(bytes, { jobName: name, copies: o.copies, printer: o.printer });
    }
    return ctx;
  }

  const startRun = () => {
    if (running() || !files().length || unavailable()) return;
    if (writes && outputMode() === 'inPlace') { setConfirming(true); return; }
    void run();
  };

  async function run() {
    setConfirming(false);
    setMessage('');
    setLog({});
    setWrittenNow({});
    let dir = '';
    if (writes && outputMode() === 'folder' && desktop) {
      dir = await openFolderDialog(tb('chooseFolder'));
      if (!dir) return;
    }
    controller = new AbortController();
    const signal = controller.signal;
    setRunning(true);
    try {
      const { batchOpJob } = await import('../../../batch/batch-ops-job.js');
      const list = files();
      const job = batchOpJob({
        op, options: options(), context: await context(),
        output: { mode: outputMode(), dir, suffix: suffix() },
        write, exists: (path) => fileExists(path).catch(() => false),
        sources: list.map((f) => f.path),
        openPaths: (state.documents || []).map((d) => d.filePath).filter(Boolean),
        onWritten: (file, path) => setWrittenNow({ ...writtenNow(), [file.path]: path }),
      });
      const result = await runBatch({
        files: list, readFile, job, signal,
        onProgress: (p) => {
          if (p.phase === 'file') setProgress({ index: p.index + 1, total: p.total, name: p.file.name });
          else if (p.phase === 'done') setLog({ ...log(), [p.file.path]: p.entry });
        },
      });
      const ok = result.log.filter((e) => e.ok).length;
      const failed = result.log.length - ok;
      if (result.cancelled) {
        setMessage(tb('cancelled', { written: Object.keys(writtenNow()).length }));
        return;
      }
      setMessage([tb('done', { ok, total: list.length }), failed ? tb('doneFailures', { failed }) : ''].filter(Boolean).join(' '));
    } catch (error) {
      setMessage(tb('failed', { error: error?.message || String(error) }));
    } finally {
      controller = null;
      setRunning(false);
      setProgress(null);
    }
  }

  const cancelRun = () => controller?.abort();
  const close = () => { cancelRun(); closeDialog(NAME); };

  // "code {json}" from ops.js BatchOpError → its translated text.
  const errorText = (error) => {
    const m = /^(\w+)(?: (\{.*\}))?$/u.exec(String(error || ''));
    if (m) {
      const key = `batchOps.error.${m[1]}`;
      const text = t(key, m[2] ? JSON.parse(m[2]) : {});
      if (text && text !== key) return text;
    }
    return String(error || '');
  };
  const detailText = (detail) => {
    if (!detail?.code) return '';
    const values = { ...detail };
    if (detail.code === 'reduced') {
      const kb = (n) => `${Math.max(1, Math.round(n / 1024)).toLocaleString()} KB`;
      values.before = kb(detail.before);
      values.after = kb(detail.after);
    }
    return tb(`detail.${detail.code}`, values);
  };

  const statusOf = (file) => {
    const entry = log()[file.path];
    if (entry) {
      if (!entry.ok) return { cls: 'error', text: tb('failed', { error: errorText(entry.error) }) };
      const detail = detailText(entry.detail);
      if (!entry.detail?.written) return { cls: 'ok', text: entry.detail?.code === 'printed' ? detail : tb('unchanged', { detail }) };
      return { cls: 'ok', text: tb('wrote', { detail, name: baseName(entry.detail.written) }) };
    }
    if (writtenNow()[file.path]) return { cls: 'ok', text: baseName(writtenNow()[file.path]) };
    const p = progress();
    if (running() && p?.index && files()[p.index - 1]?.path === file.path) return { cls: 'busy', text: tb('working') };
    if (running()) return { cls: '', text: tb('waiting') };
    if (message() && Object.keys(log()).length && !log()[file.path]) return { cls: '', text: tb('notRun') };
    return { cls: '', text: '' };
  };
  const fraction = () => {
    const p = progress();
    return p ? (p.index - 1) / Math.max(1, p.total) : 0;
  };
  const inPlaceCount = createMemo(() => files().length);
  const openInTab = createMemo(() => new Set((state.documents || []).map((d) => pathKey(d.filePath))));

  // As the Page Setup dialog: A sizes by name, the others from its strings.
  const sizeLabel = (key) => (/^a\d$/u.test(key)
    ? `${key.toUpperCase()} (${PAGE_SIZE_PRESETS[key][0]} × ${PAGE_SIZE_PRESETS[key][1]} mm)` : td(`resizePages.${key}`));

  const note = () => (!writes ? tb('sourcesNotePrint') : outputMode() === 'inPlace' ? tb('sourcesNoteInPlace') : tb('sourcesNote'));

  const footer = (
    <>
      <div class="batch-summary-footer-left">{note()}</div>
      <div class="batch-summary-footer-right">
        <Show when={running()} fallback={
          <button class="pref-btn pref-btn-primary" disabled={!files().length || unavailable() || confirming()} onClick={startRun}>{tb('run')}</button>
        }>
          <button class="pref-btn pref-btn-primary" onClick={cancelRun}>{tb('cancelRun')}</button>
        </Show>
        <button class="pref-btn pref-btn-secondary" onClick={close}>{t('close')}</button>
      </div>
    </>
  );

  const pageChoice = () => (
    <Show when={PAGE_CHOICES[op]}>
      <label class="batch-summary-option">
        <span class="batch-summary-label">{tb('pages')}</span>
        <select class="batch-summary-select" disabled={running()} value={pageMode()} onChange={(e) => setPageMode(e.currentTarget.value)}>
          <For each={PAGE_CHOICES[op]}>{(mode) => <option value={mode}>{tb(PAGE_LABEL[mode])}</option>}</For>
        </select>
      </label>
      <Show when={pageMode() === 'range'}>
        <input class="batch-ops-input" type="text" disabled={running()} placeholder={tb('rangePlaceholder')}
          aria-label={tb('pagesRange')} value={pageRange()} onInput={(e) => setPageRange(e.currentTarget.value)} />
      </Show>
    </Show>
  );

  return (
    <Dialog title={tb(`title.${op}`)} dialogClass="batch-summary-dialog batch-ops-dialog" bodyClass="batch-summary-body"
      footerClass="batch-summary-footer" onClose={close} footer={footer}>
      <Show when={unavailable()}>
        <div class="batch-summary-message" role="status">{tb('desktopOnly', { op: tb(`title.${op}`) })}</div>
      </Show>
      <div class="batch-summary-section-title">{ts('files')}</div>
      <div class="batch-summary-actions">
        <button class="pref-btn pref-btn-secondary" disabled={running()} onClick={addSet}>{ts('addSet')}</button>
        <button class="pref-btn pref-btn-secondary" disabled={running()} onClick={addFiles}>{ts('addFiles')}</button>
        <Show when={desktop}>
          <button class="pref-btn pref-btn-secondary" disabled={running()} onClick={addFolder}>{ts('addFolder')}</button>
        </Show>
        <span class="batch-summary-spacer" />
        <button class="pref-btn pref-btn-secondary" disabled={running() || selected() < 0} onClick={removeSelected}>{ts('remove')}</button>
        <button class="pref-btn pref-btn-secondary" disabled={running() || !files().length}
          onClick={() => { setFiles([]); setSelected(-1); setLog({}); setWrittenNow({}); }}>{ts('clear')}</button>
      </div>
      <div class="batch-summary-list" role="listbox" aria-label={ts('files')}>
        <Show when={files().length} fallback={<div class="batch-summary-empty">{ts('noFiles')}</div>}>
          <For each={files()}>
            {(file, index) => (
              <div class={`batch-summary-file ${selected() === index() ? 'selected' : ''}`} role="option"
                aria-selected={selected() === index()} title={file.path} onClick={() => setSelected(index())}>
                <span class="batch-summary-file-name">{file.name}</span>
                <span class={`batch-summary-file-status ${statusOf(file).cls}`} title={statusOf(file).text}>{statusOf(file).text}</span>
              </div>
            )}
          </For>
        </Show>
      </div>

      <div class="batch-summary-section-title">{tb('options')}</div>
      <div class="batch-summary-options batch-ops-options">
        <Switch>
          <Match when={op === 'flatten'}>
            {pageChoice()}
            <label class="batch-summary-check">
              <input type="checkbox" disabled={running()} checked={allowUnflatten()} onChange={(e) => setAllowUnflatten(e.currentTarget.checked)} />
              {tb('allowUnflatten')}
            </label>
          </Match>
          <Match when={op === 'rotate'}>
            {pageChoice()}
            <label class="batch-summary-option">
              <span class="batch-summary-label">{tb('angle')}</span>
              <select class="batch-summary-select" disabled={running()} value={delta()} onChange={(e) => setDelta(Number(e.currentTarget.value))}>
                <option value="90">{tb('angle90')}</option>
                <option value="180">{tb('angle180')}</option>
                <option value="270">{tb('angle270')}</option>
              </select>
            </label>
          </Match>
          <Match when={op === 'split'}>
            <label class="batch-summary-option">
              <span class="batch-summary-label">{tb('splitBy')}</span>
              <select class="batch-summary-select" disabled={running()} value={splitBy()} onChange={(e) => setSplitBy(e.currentTarget.value)}>
                <option value="every">{tb('splitEvery')}</option>
                <option value="ranges">{tb('splitRanges')}</option>
              </select>
            </label>
            <Show when={splitBy() === 'every'} fallback={
              <input class="batch-ops-input" type="text" disabled={running()} placeholder={tb('splitRangesPlaceholder')}
                aria-label={tb('splitRanges')} value={splitRanges()} onInput={(e) => setSplitRanges(e.currentTarget.value)} />
            }>
              <label class="batch-summary-option">
                <span class="batch-summary-label">{tb('splitEveryPages')}</span>
                <input class="batch-ops-number" type="number" min="1" disabled={running()} value={splitEvery()} onInput={(e) => setSplitEvery(e.currentTarget.value)} />
              </label>
            </Show>
          </Match>
          <Match when={op === 'headersFooters'}>
            <div class="batch-ops-grid">
              <For each={HF_SLOTS}>
                {(slot) => (
                  <label class="batch-ops-field">
                    <span class="batch-summary-label">{tb(`hf.${slot}`)}</span>
                    <input class="batch-ops-input" type="text" disabled={running()} value={hf()[slot]}
                      onInput={(e) => setHf({ ...hf(), [slot]: e.currentTarget.value })} />
                  </label>
                )}
              </For>
            </div>
            <label class="batch-summary-option">
              <span class="batch-summary-label">{tb('hf.fontSize')}</span>
              <input class="batch-ops-number" type="number" min="4" max="72" disabled={running()} value={hf().fontSize}
                onInput={(e) => setHf({ ...hf(), fontSize: e.currentTarget.value })} />
            </label>
            <label class="batch-summary-option">
              <span class="batch-summary-label">{tb('hf.color')}</span>
              <input type="color" disabled={running()} value={hf().color} onInput={(e) => setHf({ ...hf(), color: e.currentTarget.value })} />
            </label>
            {pageChoice()}
            <div class="batch-ops-note">{tb('hf.fields')}</div>
          </Match>
          <Match when={op === 'applyStamp'}>
            <label class="batch-summary-option">
              <span class="batch-summary-label">{tb('stamp')}</span>
              <select class="batch-summary-select" disabled={running()} value={stampId()} onChange={(e) => setStampId(e.currentTarget.value)}>
                <optgroup label={tb('contractorStamps')}>
                  <For each={stamps.filter((s) => !s.id.startsWith('user:'))}>{(s) => <option value={s.id}>{s.name}</option>}</For>
                </optgroup>
                <Show when={stamps.some((s) => s.id.startsWith('user:'))}>
                  <optgroup label={tb('myStamps')}>
                    <For each={stamps.filter((s) => s.id.startsWith('user:'))}>{(s) => <option value={s.id}>{s.name}</option>}</For>
                  </optgroup>
                </Show>
              </select>
            </label>
            <label class="batch-summary-option">
              <span class="batch-summary-label">{tb('position')}</span>
              <select class="batch-summary-select" disabled={running()} value={position()} onChange={(e) => setPosition(e.currentTarget.value)}>
                <For each={STAMP_POSITIONS}>{(p) => <option value={p}>{tb(`positions.${p}`)}</option>}</For>
              </select>
            </label>
            <label class="batch-summary-option">
              <span class="batch-summary-label">{tb('margin')}</span>
              <input class="batch-ops-number" type="number" min="0" disabled={running()} value={margin()} onInput={(e) => setMargin(e.currentTarget.value)} />
            </label>
            {pageChoice()}
            <div class="batch-ops-note">{tb('stampFields')}</div>
          </Match>
          <Match when={op === 'cropPageSetup'}>
            <label class="batch-summary-option">
              <span class="batch-summary-label">{tb('cropMode')}</span>
              <select class="batch-summary-select" disabled={running()} value={cropMode()} onChange={(e) => setCropMode(e.currentTarget.value)}>
                <option value="margins">{tb('cropContent')}</option>
                <option value="size">{tb('pageSize')}</option>
              </select>
            </label>
            {pageChoice()}
            <Show when={cropMode() === 'size'} fallback={
              <>
                <label class="batch-summary-option">
                  <span class="batch-summary-label">{tb('padding')}</span>
                  <input class="batch-ops-number" type="number" min="0" max="50" disabled={running()} value={padding()} onInput={(e) => setPadding(e.currentTarget.value)} />
                </label>
                <label class="batch-summary-option">
                  <span class="batch-summary-label">{tb('threshold')}</span>
                  <input class="batch-ops-number" type="number" min="200" max="255" disabled={running()} value={threshold()} onInput={(e) => setThreshold(e.currentTarget.value)} />
                </label>
              </>
            }>
              <label class="batch-summary-option">
                <span class="batch-summary-label">{tb('size')}</span>
                <select class="batch-summary-select" disabled={running()} value={preset()} onChange={(e) => setPreset(e.currentTarget.value)}>
                  <For each={Object.keys(PAGE_SIZE_PRESETS)}>{(key) => <option value={key}>{sizeLabel(key)}</option>}</For>
                  <option value="custom">{tb('custom')}</option>
                </select>
              </label>
              <label class="batch-summary-option">
                <span class="batch-summary-label">{tb('orientation')}</span>
                <select class="batch-summary-select" disabled={running()} value={orientation()} onChange={(e) => setOrientation(e.currentTarget.value)}>
                  <option value="portrait">{tb('portrait')}</option>
                  <option value="landscape">{tb('landscape')}</option>
                </select>
              </label>
              <Show when={preset() === 'custom'}>
                <label class="batch-summary-option">
                  <span class="batch-summary-label">{tb('width')}</span>
                  <input class="batch-ops-number" type="number" min="10" disabled={running()} value={customW()} onInput={(e) => setCustomW(e.currentTarget.value)} />
                </label>
                <label class="batch-summary-option">
                  <span class="batch-summary-label">{tb('height')}</span>
                  <input class="batch-ops-number" type="number" min="10" disabled={running()} value={customH()} onInput={(e) => setCustomH(e.currentTarget.value)} />
                </label>
              </Show>
            </Show>
          </Match>
          <Match when={op === 'reduceFileSize'}>
            <label class="batch-summary-option">
              <span class="batch-summary-label">{tb('level')}</span>
              <select class="batch-summary-select" disabled={running()} value={level()} onChange={(e) => setLevel(e.currentTarget.value)}>
                <option value="low">{tb('levelLow')}</option>
                <option value="medium">{tb('levelMedium')}</option>
                <option value="high">{tb('levelHigh')}</option>
              </select>
            </label>
            <div class="batch-ops-note">{tb('reduceNote')}</div>
          </Match>
          <Match when={op === 'ocr'}>
            {pageChoice()}
            <label class="batch-summary-option">
              <span class="batch-summary-label">{tb('language')}</span>
              <select class="batch-summary-select" disabled={running()} value={lang()} onChange={(e) => setLang(e.currentTarget.value)}>
                <For each={LANGUAGE_OPTIONS}>{(code) => <option value={code}>{td(`ocrLanguage.options.${code}`)}</option>}</For>
              </select>
            </label>
            <div class="batch-ops-note">{tb('ocrNote')}</div>
          </Match>
          <Match when={op === 'repair'}>
            <div class="batch-ops-note">{tb('repairNote')}</div>
          </Match>
          <Match when={op === 'print'}>
            <label class="batch-summary-option">
              <span class="batch-summary-label">{tb('printer')}</span>
              <select class="batch-summary-select" disabled={running() || !desktop} value={printer()} onChange={(e) => setPrinter(e.currentTarget.value)}>
                <Show when={printerList().length} fallback={<option value="">{tb('noPrinters')}</option>}>
                  <For each={printerList()}>{(p) => <option value={p.Name}>{p.Name}</option>}</For>
                </Show>
              </select>
            </label>
            <label class="batch-summary-option">
              <span class="batch-summary-label">{tb('copies')}</span>
              <input class="batch-ops-number" type="number" min="1" max="99" disabled={running()} value={copies()} onInput={(e) => setCopies(e.currentTarget.value)} />
            </label>
            {pageChoice()}
            <div class="batch-ops-note">{tb('printNote')}</div>
          </Match>
        </Switch>
      </div>

      <Show when={writes}>
        <div class="batch-summary-section-title">{tb('output')}</div>
        <div class="batch-ops-output">
          <label class="batch-summary-check">
            <input type="radio" name="batch-ops-output" disabled={running()} checked={outputMode() === 'folder'} onChange={() => { setOutputMode('folder'); setConfirming(false); }} />
            {tb('outputFolder')}
          </label>
          <label class="batch-summary-option batch-ops-suffix">
            <span class="batch-summary-label">{tb('suffix')}</span>
            <input class="batch-ops-input" type="text" disabled={running() || outputMode() !== 'folder'} value={suffix()} onInput={(e) => setSuffix(e.currentTarget.value)} />
            <Show when={!desktop}><span class="batch-ops-note">{tb('browserDownloads')}</span></Show>
          </label>
          <label class="batch-summary-check" title={desktop ? '' : tb('inPlaceDesktop')}>
            <input type="radio" name="batch-ops-output" disabled={running() || !desktop || MULTI_OUTPUT_OPS.has(op)} checked={outputMode() === 'inPlace'}
              onChange={() => setOutputMode('inPlace')} />
            {tb('outputInPlace')}
          </label>
        </div>
      </Show>

      <Show when={confirming()}>
        <div class="batch-ops-confirm" role="alertdialog" aria-label={tb('outputInPlace')}>
          <span>{tb('confirmInPlace', { count: inPlaceCount() })}</span>
          <Show when={files().some((f) => openInTab().has(pathKey(f.path)))}>
            <span class="batch-ops-note">{tb('error.openInTab')}</span>
          </Show>
          <span class="batch-summary-spacer" />
          <button class="pref-btn pref-btn-primary batch-ops-danger" onClick={() => void run()}>{tb('run')}</button>
          <button class="pref-btn pref-btn-secondary" onClick={() => setConfirming(false)}>{t('cancel')}</button>
        </div>
      </Show>

      <Show when={running()}>
        <div class="batch-summary-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(fraction() * 100)}>
          <div class="batch-summary-progress-bar" style={{ width: `${Math.round(fraction() * 100)}%` }} />
        </div>
        <div class="batch-summary-progress-text">{progress() ? tb('progress', progress()) : ''}</div>
      </Show>
      <Show when={message()}>
        <div class="batch-summary-message" role="status">{message()}</div>
      </Show>
    </Dialog>
  );
}
