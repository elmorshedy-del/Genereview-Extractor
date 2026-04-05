/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractNbkId, normalizeText, slugify } from './utils';

export { extractNbkId, normalizeText, slugify };

export async function readJson(path: string, defaultValue: any = null) {
  // In a browser environment, we can't read from local path directly.
  // This is a stub for the manager logic.
  console.warn(`readJson called for path: ${path}. Returning default value.`);
  return defaultValue;
}

export async function writeJson(path: string, data: any) {
  // In a browser environment, we can't write to local path directly.
  console.warn(`writeJson called for path: ${path}. Data:`, data);
}

export function buildSyntheticClinicalStructure(text: string, title: string = 'Untitled Chapter') {
  const paragraphs = text.split(/\n\s*\n/).filter(Boolean);
  const result: any = {
    chapter_title: title,
    paragraphs: []
  };

  let globalSentenceIndex = 0;
  let currentChar = 0;

  paragraphs.forEach((pText, pIdx) => {
    const pId = `paragraph_${pIdx + 1}`;
    const pStart = currentChar;
    const pEnd = pStart + pText.length;
    
    // Simple sentence splitting on punctuation followed by space
    const sTexts = pText.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [pText];
    const sentences = sTexts.map((sText: string) => {
      const sId = `sentence_${globalSentenceIndex + 1}`;
      const sStart = pText.indexOf(sText); // Relative to paragraph
      const sObj = {
        text: sText.trim(),
        sentence_id: sId,
        sentence_index: globalSentenceIndex,
        char_start: pStart + sStart,
        char_end: pStart + sStart + sText.length
      };
      globalSentenceIndex++;
      return sObj;
    });

    result.paragraphs.push({
      text: pText.trim(),
      section_id: 'clinical_description', // Default for synthetic
      section_heading: 'Clinical Description',
      paragraph_id: pId,
      paragraph_index: pIdx,
      char_start: pStart,
      char_end: pEnd,
      local_clinical_domains: [],
      sentences
    });

    currentChar = pEnd + 2; // +2 for the double newline
  });

  return result;
}

export function finalizePhenotypeCandidates(
  candidateRows: any[], 
  anchors: any[], 
  clinicalStructure: any, 
  source: string
) {
  const paragraphs = clinicalStructure?.paragraphs || [];
  const allSentences = paragraphs.flatMap((p: any) => 
    p.sentences.map((s: any) => ({ ...s, paragraph_id: p.paragraph_id, section_heading: p.section_heading }))
  );
  
  const grounded_candidates: any[] = [];
  const rejected_candidates: any[] = [];

  for (const row of candidateRows) {
    const label = row.label?.toLowerCase().trim();
    if (!label) continue;

    let bestMatch: any = null;
    let confidence: 'high' | 'medium' = 'high';

    // 1. Direct wording match (High confidence)
    bestMatch = allSentences.find((s: any) => s.text.toLowerCase().includes(label));

    // 2. Paraphrase/Partial match (Medium confidence) - simplified for this implementation
    if (!bestMatch) {
      // Try matching words if label is multi-word
      const words = label.split(/\s+/).filter((w: string) => w.length > 3);
      if (words.length > 0) {
        bestMatch = allSentences.find((s: any) => {
          const sText = s.text.toLowerCase();
          return words.every((w: string) => sText.includes(w));
        });
        if (bestMatch) confidence = 'medium';
      }
    }

    if (bestMatch) {
      grounded_candidates.push({
        label: row.label,
        status: row.status || 'present',
        bucket: row.extraction_bucket || row.status || 'present',
        sentence_id: bestMatch.sentence_id,
        sentence_index: bestMatch.sentence_index,
        sentence_text: bestMatch.text,
        section_heading: bestMatch.section_heading,
        paragraph_id: bestMatch.paragraph_id,
        grounding_confidence: confidence
      });
    } else {
      rejected_candidates.push({
        label: row.label,
        status: row.status || 'present',
        bucket: row.extraction_bucket || row.status || 'present',
        reason: 'No sufficiently specific supporting sentence found in source text.'
      });
    }
  }

  return { grounded_candidates, rejected_candidates };
}
