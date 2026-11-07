// Adapter: the old workspace-profile API on top of workspaceLayout.js.
// Profiles are now whole panel layouts (docs/WORKSPACE-SPEC.md §5):
// oculith (default), oculithAdvanced, quantityTakeoff, document. The old ids
// (review/markup/takeoff/document) still work and map via LEGACY_PROFILE_MAP.

import {
  PROFILE_IDS, LEGACY_PROFILE_MAP, activeProfile, applyProfile,
} from './workspaceLayout.js';
import { resetActiveWorkflow } from './workflowStore.js';

export const WORKSPACE_PROFILES = PROFILE_IDS;

/** The active profile id (reactive). */
export const activeWorkspaceProfile = activeProfile;

/** Switch profile (new or old id); resets the panel layout to that profile. */
export function applyWorkspaceProfile(profile, persist = true) {
  const id = PROFILE_IDS.includes(profile) ? profile : LEGACY_PROFILE_MAP[profile];
  if (!id) return false;
  applyProfile(id, { persist });
  // The workflow toolbar opens on the profile's own workflow.
  resetActiveWorkflow({ persist });
  return true;
}

/** Boot: the layout itself comes from restoreWorkspaceLayout(); nothing else follows the profile. */
export function restoreWorkspaceProfile() {
  return true;
}
