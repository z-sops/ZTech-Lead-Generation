/* ES-module entry for ZTech's Vite renderer (src/renderer/renderer.js is a
 * <script type="module">, verified in Step 0).
 *
 * The component files are UMD: in the browser they attach to globalThis.ZTechLI.
 * Import order matters — dom.js first. Side-effect imports run in this order.
 *
 * Usage in renderer.js:
 *   import { mountResearchSection, mountEnrichmentSection } from './lead-intelligence/index.mjs';
 */
import './dom.js';
import './researchSection.js';
import './listsPanels.js';
import './pitchPanel.js';
import './enrichmentSection.js';
import './opportunitySection.js';

const LI = globalThis.ZTechLI;
if (!LI || !LI.dom || !LI.researchSection || !LI.listsPanels || !LI.pitchPanel || !LI.enrichmentSection || !LI.opportunitySection) {
  throw new Error('lead-intelligence renderer modules did not load');
}

export const dom = LI.dom;
export const { mountResearchSection } = LI.researchSection;
export const { mountSavedSearchesPanel, mountSegmentsPanel } = LI.listsPanels;
export const { mountPitchPanel } = LI.pitchPanel;
export const { mountEnrichmentSection } = LI.enrichmentSection;
export const { mountOpportunitySection } = LI.opportunitySection;
