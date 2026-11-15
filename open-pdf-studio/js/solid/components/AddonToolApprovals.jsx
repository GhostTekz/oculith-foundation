// Non-modal approval cards for add-on tools that change something, and for
// the editor's own tools on an asking AI link (js/mcp/addon-tools.js). One card per waiting call, bottom-right; the user
// keeps working while a card is open. Approve, Deny or Always for this
// session; a card that is not answered counts as Deny.
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useTranslation } from '../../i18n/useTranslation.js';
import { answerApproval, pendingApprovals, shownInline, subscribe } from '../../mcp/addon-tools.js';
import { openDialog } from '../stores/dialogStore.js';

export default function AddonToolApprovals() {
  const { t } = useTranslation('dialogs');
  // Cards a panel shows itself (an in-app assistant) are left out here.
  const floating = () => pendingApprovals().filter((card) => !shownInline(card));
  const [cards, setCards] = createSignal(floating());
  onMount(() => {
    const stop = subscribe(() => setCards(floating()));
    onCleanup(stop);
  });
  return (
    <Show when={cards().length}>
      <div class="addon-tool-approvals" role="region" aria-label={t('addonTools.cardHeading')}>
        <For each={cards()}>
          {(card) => (
            <div class="addon-tool-card" role="alertdialog" aria-labelledby={`addon-tool-card-${card.id}`}
              data-tool={card.tool}>
              <div class="addon-tool-card-head" id={`addon-tool-card-${card.id}`}>{t('addonTools.cardHeading')}</div>
              <div class="addon-tool-card-title">{card.title}</div>
              <div class="addon-tool-card-name">{card.tool}</div>
              <Show when={card.summary}><div class="addon-tool-card-summary">{card.summary}</div></Show>
              <Show when={card.args}><div class="addon-tool-card-args" title={card.args}>{card.args}</div></Show>
              <div class="addon-tool-card-note">{t('addonTools.cardWrites')}</div>
              <div class="addon-tool-card-actions">
                <button type="button" class="addon-tool-card-link" onClick={() => openDialog('addon-tool-log')}>
                  {t('addonTools.viewLog')}
                </button>
                <span style={{ flex: 1 }} />
                <button type="button" class="pref-btn pref-btn-secondary" data-answer="deny"
                  onClick={() => answerApproval(card.id, 'deny')}>{t('addonTools.deny')}</button>
                <button type="button" class="pref-btn pref-btn-secondary" data-answer="always"
                  onClick={() => answerApproval(card.id, 'always')}>{t('addonTools.always')}</button>
                <button type="button" class="pref-btn pref-btn-primary" data-answer="approve"
                  onClick={() => answerApproval(card.id, 'approve')}>{t('addonTools.approve')}</button>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
