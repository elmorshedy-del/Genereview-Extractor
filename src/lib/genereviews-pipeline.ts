/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractNbkId, normalizeText, slugify } from './utils';
import { GoogleGenAI } from '@google/genai';

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
  let currentHeading = 'Clinical Description';

  paragraphs.forEach((pText, pIdx) => {
    const pId = `paragraph_${pIdx + 1}`;
    const pStart = currentChar;
    const pEnd = pStart + pText.length;
    
    // Check if paragraph is a heading (short, no punctuation at end)
    const isHeading = pText.length < 150 && !/[.!?]$/.test(pText.trim()) && pText.split(' ').length <= 15;
    if (isHeading) {
      currentHeading = pText.trim();
    }

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
      section_id: slugify(currentHeading),
      section_heading: currentHeading,
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

function getSectionScore(heading: string): number {
  const h = (heading || '').toLowerCase();
  if (h.includes('summary') || h.includes('clinical description') || h.includes('clinical characteristic') || h.includes('suggestive finding')) {
    return 1;
  }
  if (h.includes('management') || h.includes('treatment') || h.includes('surveillance') || h.includes('intervention') || h.includes('therapy')) {
    return 3;
  }
  if (h.includes('reference') || h.includes('literature') || h.includes('acknowledgment') || h.includes('revision history')) {
    return 4;
  }
  return 2;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function finalizePhenotypeCandidates(
  candidateRows: any[], 
  anchors: any[], 
  clinicalStructure: any, 
  source: string,
  apiKey?: string
) {
  const paragraphs = clinicalStructure?.paragraphs || [];
  const allSentences = paragraphs.flatMap((p: any) => 
    p.sentences.map((s: any) => ({ ...s, paragraph_id: p.paragraph_id, section_heading: p.section_heading }))
  );
  
  const grounded_candidates: any[] = [];
  const rejected_candidates: any[] = [];

  // --- SEMANTIC VECTORIZATION PHASE ---
  let useSemantic = false;
  let sentenceEmbeddings: number[][] = [];
  let labelEmbeddings: number[][] = [];

  if (apiKey && allSentences.length > 0 && candidateRows.length > 0) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const batchSize = 100;

      // 1. Embed all sentences
      const sentenceTexts = allSentences.map((s: any) => s.text);
      for (let i = 0; i < sentenceTexts.length; i += batchSize) {
        const batch = sentenceTexts.slice(i, i + batchSize);
        const res = await ai.models.embedContent({
          model: 'gemini-embedding-2-preview',
          contents: batch
        });
        sentenceEmbeddings.push(...res.embeddings.map((e: any) => e.values));
      }

      // 2. Embed all labels
      const labels = candidateRows.map(r => r.label);
      for (let i = 0; i < labels.length; i += batchSize) {
        const batch = labels.slice(i, i + batchSize);
        const res = await ai.models.embedContent({
          model: 'gemini-embedding-2-preview',
          contents: batch
        });
        labelEmbeddings.push(...res.embeddings.map((e: any) => e.values));
      }

      if (sentenceEmbeddings.length === allSentences.length && labelEmbeddings.length === candidateRows.length) {
        useSemantic = true;
      }
    } catch (e) {
      console.warn("Semantic embedding failed, falling back to lexical search", e);
    }
  }

  // --- GROUNDING PHASE ---
  for (let rIdx = 0; rIdx < candidateRows.length; rIdx++) {
    const row = candidateRows[rIdx];
    const label = row.label?.trim();
    const sourceQuote = row.source_quote?.trim() || label; // Fallback to label if source_quote is missing
    const bucket = row.extraction_bucket || row.bucket;
    
    if (!label) continue;

    let bestMatch: any = null;
    let matchType = 'none';
    let rejectionReason = '';
    let confidence: 'high' | 'medium' | 'low' = 'low';

    // 1. Strict Cascade Localization
    // A. Exact raw match
    const exactMatches = allSentences.filter((s: any) => s.text.includes(sourceQuote));
    if (exactMatches.length > 0) {
      exactMatches.sort((a: any, b: any) => getSectionScore(a.section_heading) - getSectionScore(b.section_heading));
      bestMatch = exactMatches[0];
      matchType = 'exact_raw';
    } else {
      // B. Normalized exact match
      const normQuote = normalizeText(sourceQuote);
      const normMatches = allSentences.filter((s: any) => normalizeText(s.text).includes(normQuote));
      if (normMatches.length > 0) {
        normMatches.sort((a: any, b: any) => getSectionScore(a.section_heading) - getSectionScore(b.section_heading));
        bestMatch = normMatches[0];
        matchType = 'normalized_exact';
      } else {
        // C. Narrow fuzzy repair
        const quoteWords = normQuote.split(/\s+/).filter(w => w.length > 3);
        if (quoteWords.length >= 2) {
          let bestFuzzyMatch = null;
          let maxOverlap = 0;
          for (const s of allSentences) {
            const sNorm = normalizeText(s.text);
            const sWords = sNorm.split(/\s+/);
            let overlap = 0;
            for (const qw of quoteWords) {
              if (sWords.includes(qw)) overlap++;
            }
            const overlapRatio = overlap / quoteWords.length;
            if (overlapRatio >= 0.8 && overlap > maxOverlap) {
              maxOverlap = overlap;
              bestFuzzyMatch = s;
            }
          }
          if (bestFuzzyMatch) {
            bestMatch = bestFuzzyMatch;
            matchType = 'narrow_fuzzy';
          }
        }
      }
    }

    // D. Fallback to semantic embedding if strict cascade fails (optional, but we keep it as a last resort with low confidence)
    if (!bestMatch && useSemantic && labelEmbeddings[rIdx]) {
      const labelVec = labelEmbeddings[rIdx];
      let bestScore = -1;
      for (let j = 0; j < allSentences.length; j++) {
        const sentence = allSentences[j];
        const sentenceVec = sentenceEmbeddings[j];
        if (!sentenceVec) continue;

        const baseSim = cosineSimilarity(labelVec, sentenceVec);
        const sectionScore = getSectionScore(sentence.section_heading);
        let adjustedSim = baseSim;
        if (sectionScore === 3) adjustedSim *= 0.85;
        if (sectionScore === 4) adjustedSim *= 0.70;

        if (adjustedSim > bestScore) {
          bestScore = adjustedSim;
          bestMatch = sentence;
        }
      }
      if (bestScore >= 0.75) { // Stricter threshold for semantic fallback
        matchType = 'semantic_fallback';
      } else {
        bestMatch = null;
      }
    }

    if (!bestMatch) {
      rejectionReason = 'No match found in strict cascade or semantic fallback.';
    } else {
      // 2. Polarity Validation
      const sNorm = bestMatch.text.toLowerCase();
      const isNegated = /\b(not|no|absent|without|lacking|none|never)\b/.test(sNorm);
      const isUncertain = /\b(may|might|could|rarely|sometimes|variable|unclear|suggests|possible|probable)\b/.test(sNorm);
      
      let polarityStatus = 'pass';
      
      if (bucket === 'present' && isNegated) {
        polarityStatus = 'failed_negation_check';
        rejectionReason = 'Present phenotype grounded to negated text.';
        bestMatch = null;
      } else if (bucket === 'excluded' && !isNegated) {
        polarityStatus = 'failed_exclusion_check';
        rejectionReason = 'Excluded phenotype grounded to non-negated text.';
        bestMatch = null;
      } else if (bucket === 'uncertain' && !isUncertain && !isNegated) {
        polarityStatus = 'failed_uncertainty_check';
        rejectionReason = 'Uncertain phenotype grounded to definitive text.';
        bestMatch = null;
      }

      if (bestMatch) {
        const sectionScore = getSectionScore(bestMatch.section_heading);
        if (matchType === 'exact_raw' || matchType === 'normalized_exact') {
          confidence = sectionScore >= 3 ? 'medium' : 'high';
        } else if (matchType === 'narrow_fuzzy') {
          confidence = sectionScore >= 3 ? 'low' : 'medium';
        } else {
          confidence = 'low';
        }

        grounded_candidates.push({
          label: row.label,
          source_quote: sourceQuote,
          trajectory: row.trajectory,
          reason: row.reason,
          status: bucket,
          bucket: bucket,
          sentence_id: bestMatch.sentence_id,
          sentence_index: bestMatch.sentence_index,
          sentence_text: bestMatch.text,
          section_heading: bestMatch.section_heading,
          paragraph_id: bestMatch.paragraph_id,
          char_start: bestMatch.char_start,
          char_end: bestMatch.char_end,
          quote_match_type: matchType,
          polarity_status: polarityStatus,
          grounding_confidence: confidence
        });
        continue; // Successfully grounded
      }
    }

    // If we reach here, it was rejected
    rejected_candidates.push({
      label: row.label,
      source_quote: sourceQuote,
      trajectory: row.trajectory,
      reason: row.reason,
      status: bucket,
      bucket: bucket,
      quote_match_type: matchType,
      polarity_status: bestMatch ? 'pass' : (rejectionReason.includes('grounded to') ? rejectionReason.split(' ')[0].toLowerCase() : 'N/A'),
      rejection_reason: rejectionReason
    });
  }

  return { grounded_candidates, rejected_candidates };
}
