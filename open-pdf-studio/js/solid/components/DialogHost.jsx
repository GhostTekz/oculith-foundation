import { For, lazy } from 'solid-js';
import { getDialogs } from '../stores/dialogStore.js';
import { edition } from '../../editions/active.js';
import DocPropertiesDialog from './DocPropertiesDialog.jsx';
import PreferencesDialog from './preferences/PreferencesDialog.jsx';
import NewDocDialog from './dialogs/NewDocDialog.jsx';
import InsertPageDialog from './dialogs/InsertPageDialog.jsx';
import DeletePagesDialog from './dialogs/DeletePagesDialog.jsx';
import FlattenDialog from './dialogs/FlattenDialog.jsx';
import PagePropertiesDialog from './dialogs/PagePropertiesDialog.jsx';
import ExtractPagesDialog from './dialogs/ExtractPagesDialog.jsx';
import MergePdfsDialog from './dialogs/MergePdfsDialog.jsx';
import PrintQueueDialog from './dialogs/PrintQueueDialog.jsx';
import PageSetupDialog from './dialogs/PageSetupDialog.jsx';
import WatermarkDialog from './dialogs/WatermarkDialog.jsx';
import HeaderFooterDialog from './dialogs/HeaderFooterDialog.jsx';
import ManageWatermarksDialog from './dialogs/ManageWatermarksDialog.jsx';
import SignatureDialog from './dialogs/SignatureDialog.jsx';
import TextAnnotationDialog from './dialogs/TextAnnotationDialog.jsx';
import UpdateDialog from './dialogs/UpdateDialog.jsx';
import MarkupNameDialog from './dialogs/MarkupNameDialog.jsx';
import BookmarkDialog from './dialogs/BookmarkDialog.jsx';
import FormValidationDialog from './dialogs/FormValidationDialog.jsx';
import StampPickerDialog from './dialogs/StampPickerDialog.jsx';
import StampEditorDialog from './dialogs/StampEditorDialog.jsx';
import SetScaleDialog from './dialogs/SetScaleDialog.jsx';
import ScaleReviewDialog from './dialogs/ScaleReviewDialog.jsx';
import CropMarginsDialog from './dialogs/CropMarginsDialog.jsx';
import StraightenDialog from './dialogs/StraightenDialog.jsx';
import ShiftPageDialog from './dialogs/ShiftPageDialog.jsx';
import OcrLanguageDialog from './dialogs/OcrLanguageDialog.jsx';
import ResizePagesDialog from './dialogs/ResizePagesDialog.jsx';
import ManageToolSetsDialog from './dialogs/ManageToolSetsDialog.jsx';
import AddToToolChestDialog from './dialogs/AddToToolChestDialog.jsx';
import CompressDialog from './dialogs/CompressDialog.jsx';
import SlipSheetDialog from './dialogs/SlipSheetDialog.jsx';
import MessageDialog from './dialogs/MessageDialog.jsx';
import OffsetDialog from './dialogs/OffsetDialog.jsx';
import UndoHistoryDialog from './dialogs/UndoHistoryDialog.jsx';
import AboutDialog from './dialogs/AboutDialog.jsx';
import ShortcutsDialog from './dialogs/ShortcutsDialog.jsx';
import ExtensionsDialog from './dialogs/ExtensionsDialog.jsx';
import ConfirmDialog from './dialogs/ConfirmDialog.jsx';
import LayerSelectionDialog from './dialogs/LayerSelectionDialog.jsx';
import HandtekeningDetailDialog from './dialogs/HandtekeningDetailDialog.jsx';
import ViewportScaleDialog from './dialogs/ViewportScaleDialog.jsx';
import ScaleRegionDialog from './dialogs/ScaleRegionDialog.jsx';
import MeasuredLengthDialog from './dialogs/MeasuredLengthDialog.jsx';
import HyperlinkDialog from './dialogs/HyperlinkDialog.jsx';
import CaptureViewerDialog from './dialogs/CaptureViewerDialog.jsx';
import PageLabelsDialog from './dialogs/PageLabelsDialog.jsx';
import BatchLinkDialog from './dialogs/BatchLinkDialog.jsx';
import MultiplyDialog from './dialogs/MultiplyDialog.jsx';
import TitleBlockDialog from './dialogs/TitleBlockDialog.jsx';
import CompareDialog from './compare/CompareDialog.jsx';
import AnnotationLayerDeleteDialog from './dialogs/AnnotationLayerDeleteDialog.jsx';
import TextEditOverlay from './TextEditOverlay.jsx';
import StavenreeksInlineEditor from './StavenreeksInlineEditor.jsx';
import ParametricLabelInlineEditor from './ParametricLabelInlineEditor.jsx';
import PdfTextEditOverlay from './PdfTextEditOverlay.jsx';
import StickyNotePopupHost from './StickyNotePopup.jsx';
import ParametricSymbolPicker from './dialogs/ParametricSymbolPicker.jsx';
import StyleTypeEditorDialog from './dialogs/StyleTypeEditorDialog.jsx';
import TekeninstellingenDialog from './dialogs/TekeninstellingenDialog.jsx';
import SysteemtypenDialog from './dialogs/SysteemtypenDialog.jsx';
import SysteemPaneelComponentDialog from './dialogs/SysteemPaneelComponentDialog.jsx';
import PrintProgressToast from './PrintProgressToast.jsx';
import AddonToolApprovals from './AddonToolApprovals.jsx';
import AddonToolLogDialog from './dialogs/AddonToolLogDialog.jsx';
import BatchSummaryDialog from './dialogs/BatchSummaryDialog.jsx';
import LineStyleManagerDialog from './line-styles/LineStyleManagerDialog.jsx';
import SetBatchLinkDialog from './dialogs/SetBatchLinkDialog.jsx';
import AssembliesDialog from './dialogs/AssembliesDialog.jsx';
import CopyToPagesDialog from './dialogs/CopyToPagesDialog.jsx';

// Large, rarely opened dialogs load on first open instead of with the editor.
const PrintDialog = lazy(() => import('./dialogs/PrintDialog.jsx'));
const CadExportDialog = lazy(() => import('./dialogs/CadExportDialog.jsx'));
const CadImportDialog = lazy(() => import('./dialogs/CadImportDialog.jsx'));
const BatchOpsDialog = lazy(() => import('./dialogs/BatchOpsDialog.jsx'));

const DIALOG_MAP = {
  'doc-properties': DocPropertiesDialog,
  'preferences': PreferencesDialog,
  'new-doc': NewDocDialog,
  'insert-page': InsertPageDialog,
  'style-type-editor': StyleTypeEditorDialog,
  'tekeninstellingen': TekeninstellingenDialog,
  'systeemtypen': SysteemtypenDialog,
  'systeem-paneel-component': SysteemPaneelComponentDialog,
  'delete-pages': DeletePagesDialog,
  'flatten': FlattenDialog,
  'page-properties': PagePropertiesDialog,
  'extract-pages': ExtractPagesDialog,
  'merge-pdfs': MergePdfsDialog,
  'print': PrintDialog,
  'print-queue': PrintQueueDialog,
  'page-setup': PageSetupDialog,
  'watermark': WatermarkDialog,
  'header-footer': HeaderFooterDialog,
  'manage-watermarks': ManageWatermarksDialog,
  'line-styles': LineStyleManagerDialog,
  'signature': SignatureDialog,
  'text-annotation': TextAnnotationDialog,
  'update': UpdateDialog,
  'bookmark': BookmarkDialog,
  'form-validation': FormValidationDialog,
  'stamp-picker': StampPickerDialog,
  'stamp-editor': StampEditorDialog,
  'setScale': SetScaleDialog,
  'scaleReview': ScaleReviewDialog,
  'crop-margins': CropMarginsDialog,
  'straighten-page': StraightenDialog,
  'shift-page': ShiftPageDialog,
  'ocr-language': OcrLanguageDialog,
  'resize-pages': ResizePagesDialog,
  'compress': CompressDialog,
  'slipSheet': SlipSheetDialog,
  'message': MessageDialog,
  'about': AboutDialog,
  'shortcuts': ShortcutsDialog,
  'extensions': ExtensionsDialog,
  'confirm': ConfirmDialog,
  'layer-selection': LayerSelectionDialog,
  'handtekening-detail': HandtekeningDetailDialog,
  'title-block-edit': TitleBlockDialog,
  'viewport-scale': ViewportScaleDialog,
  'scale-region': ScaleRegionDialog,
  'measured-length': MeasuredLengthDialog,
  'hyperlink': HyperlinkDialog,
  'capture-viewer': CaptureViewerDialog,
  'page-labels': PageLabelsDialog,
  'batch-link': BatchLinkDialog,
  'multiply': MultiplyDialog,
  'offset': OffsetDialog,
  'undoHistory': UndoHistoryDialog,
  'compare': CompareDialog,
  'cad-export': CadExportDialog,
  'cad-import': CadImportDialog,
  'annotation-layer-delete': AnnotationLayerDeleteDialog,
  'batch-summary': BatchSummaryDialog,
  'batch-ops': BatchOpsDialog,
  'set-batch-link': SetBatchLinkDialog,
  'manage-tool-sets': ManageToolSetsDialog,
  'add-to-tool-chest': AddToToolChestDialog,
  'assemblies': AssembliesDialog,
  'copy-to-pages': CopyToPagesDialog,
  'markup-name': MarkupNameDialog,
  'addon-tool-log': AddonToolLogDialog,
  ...edition.dialogs,
};

export default function DialogHost() {
  return (
    <>
      <For each={getDialogs()}>
        {(dialog) => {
          const Component = DIALOG_MAP[dialog.name];
          if (!Component) return null;
          return <Component data={dialog.data} />;
        }}
      </For>
      <TextEditOverlay />
      <StavenreeksInlineEditor />
      <ParametricLabelInlineEditor />
      <PdfTextEditOverlay />
      <StickyNotePopupHost />
      <ParametricSymbolPicker />
      <PrintProgressToast />
      <AddonToolApprovals />
    </>
  );
}
