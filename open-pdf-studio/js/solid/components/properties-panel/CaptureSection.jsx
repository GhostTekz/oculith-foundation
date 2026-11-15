import { Show, For, createMemo } from 'solid-js';
import { panelMode, selectionRev, panelTargets } from '../../stores/propertiesStore.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { state } from '../../../core/state.js';
import { capturePhotos, hasAttachedFile, formatBytes, captureMaxEdge } from '../../../annotations/capture.js';
import {
  captureRev, canEditCapture, attachPhotosTo, openPhotoViewer, openAttachedFile, saveAttachedFileAs, replaceAttachedFile,
} from '../../../annotations/capture-actions.js';
import CollapsibleSection from './CollapsibleSection.jsx';

/**
 * Properties ▸ Capture: the selected markup's photos (thumbnails open the
 * viewer) with Attach photo…, and for a File Attachment its file
 * (Open / Save… / Replace…). See docs/reference/editor/markup-tools.md.
 */
export default function CaptureSection() {
  const { t } = useTranslation('common');
  const ann = createMemo(() => {
    selectionRev();
    captureRev();
    if (panelMode() !== 'annotation') return null;
    const [target] = panelTargets();
    return target && target.type !== 'scaleRegion' ? target : null;
  });
  const photos = () => { captureRev(); return ann() ? capturePhotos(ann()) : []; };
  const file = () => { captureRev(); return ann() && hasAttachedFile(ann()) ? ann().attachedFile : null; };
  const editable = () => canEditCapture(ann());

  return (
    <Show when={ann()}>
      <CollapsibleSection title={t('capture.section')} name="capture" id="prop-capture-section">
        <Show when={file()}>
          <div class="property-row">
            <label>{t('capture.file')}</label>
            <span class="prop-capture-file" id="prop-capture-file">{file().name} ({formatBytes(file().size)})</span>
          </div>
          <div class="prop-capture-actions">
            <button class="capture-btn" onClick={() => openAttachedFile(ann())}>{t('capture.openFile')}</button>
            <button class="capture-btn" onClick={() => saveAttachedFileAs(ann())}>{t('capture.saveFile')}</button>
            <button class="capture-btn" disabled={!editable()} onClick={() => replaceAttachedFile(ann())}>
              {t('capture.replaceFile')}</button>
          </div>
        </Show>
        <Show when={photos().length} fallback={<div class="prop-capture-note">{t('capture.noPhotos')}</div>}>
          <div class="prop-capture-thumbs">
            <For each={photos()}>{(photo, i) => (
              <button type="button" title={photo.name} aria-label={photo.name}
                onClick={() => openPhotoViewer(ann(), i())}>
                <img src={photo.dataUrl} alt="" />
              </button>
            )}</For>
          </div>
        </Show>
        <div class="prop-capture-actions">
          <button class="capture-btn" id="prop-capture-attach" disabled={!editable()}
            onClick={() => attachPhotosTo(ann())}>{t('capture.attachPhoto')}</button>
          <Show when={photos().length}>
            <button class="capture-btn" id="prop-capture-view" onClick={() => openPhotoViewer(ann(), 0)}>
              {t('capture.viewPhotos')}</button>
          </Show>
        </div>
        <div class="prop-capture-note">{t('capture.maxEdgeHint', { edge: captureMaxEdge(state.preferences) })}</div>
      </CollapsibleSection>
    </Show>
  );
}
