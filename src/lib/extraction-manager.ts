/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildSyntheticClinicalStructure,
  finalizePhenotypeCandidates,
  readJson,
  writeJson
} from './genereviews-pipeline';
import {
  enrichFinalizedCandidates,
  freezeExternalPhenotypeExtraction,
  normalizeExternalPhenotypeExtraction,
  parseExternalPhenotypeExtractionPayload,
  toFinalizeCandidateRows
} from './external-phenotype-extraction';

export function summarizeCandidateBuckets(rows: any[]) {
  const summary: Record<string, number> = {
    present: 0,
    excluded: 0,
    uncertain: 0
  };

  for (const row of rows || []) {
    const bucket = row.bucket || row.extraction_bucket || 'present';
    if (summary[bucket] !== undefined) summary[bucket] += 1;
  }

  return summary;
}

export async function groundToSidecar(frozenChapter: any, options: any) {
  // 1. Keep the frozen JSON unchanged (we work on the input frozenChapter)
  
  // 2. Load or build clinical structure
  let clinicalStructure = options.clinicalStructure;
  let syntheticStructure = null;

  if (!clinicalStructure) {
    if (options.clinicalText) {
      clinicalStructure = buildSyntheticClinicalStructure(options.clinicalText, frozenChapter.chapter?.title);
      syntheticStructure = clinicalStructure;
    } else {
      throw new Error('Clinical structure or text is required for grounding.');
    }
  }

  // 3. Ground phenotype rows to source sentences
  const candidateRows = toFinalizeCandidateRows(frozenChapter, {
    includeUncertain: Boolean(options.includeUncertain)
  });

  const anchors = options.anchors || [];
  const { grounded_candidates, rejected_candidates } = await finalizePhenotypeCandidates(
    candidateRows,
    anchors,
    clinicalStructure,
    'external_extraction',
    options.apiKey
  );

  // 4. Produce grounded sidecar output
  const groundedSidecar = {
    chapter: {
      nbk_id: frozenChapter.chapter?.nbk_id || '',
      title: frozenChapter.chapter?.title || '',
      mode: frozenChapter.chapter?.mode || 'discovery'
    },
    grounded_candidates,
    rejected_candidates,
    grounded_counts: {
      candidates: grounded_candidates.length,
      rejected_candidates: rejected_candidates.length,
      candidates_by_bucket: summarizeCandidateBuckets(grounded_candidates)
    },
    context_metadata: frozenChapter.context_metadata || {},
    context_notes: frozenChapter.context_notes || [],
    ancillary_clinical_evidence: frozenChapter.ancillary_clinical_evidence || {}
  };

  // Deliverables
  if (options.sidecarPath) {
    await writeJson(options.sidecarPath, groundedSidecar);
  }
  if (syntheticStructure && options.syntheticStructurePath) {
    await writeJson(options.syntheticStructurePath, syntheticStructure);
  }

  return {
    groundedSidecar,
    syntheticStructure
  };
}
