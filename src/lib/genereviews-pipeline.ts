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
    const label = row.label?.toLowerCase().trim();
    if (!label) continue;

    let bestMatch: any = null;
    let confidence: 'high' | 'medium' | 'low' = 'high';
    let bestScore = -1;

    // 1. Lexical Exact Match (Fast-path / Guaranteed High Confidence)
    const exactMatches = allSentences.filter((s: any) => s.text.toLowerCase().includes(label));
    
    if (exactMatches.length > 0) {
      exactMatches.sort((a: any, b: any) => getSectionScore(a.section_heading) - getSectionScore(b.section_heading));
      bestMatch = exactMatches[0];
      confidence = getSectionScore(bestMatch.section_heading) >= 3 ? 'medium' : 'high';
      bestScore = 1.0;
    } 
    // 2. Semantic Vector Match (Dense Retrieval)
    else if (useSemantic) {
      const labelVec = labelEmbeddings[rIdx];
      
      if (labelVec) {
        for (let j = 0; j < allSentences.length; j++) {
          const sentence = allSentences[j];
          const sentenceVec = sentenceEmbeddings[j];
          if (!sentenceVec) continue;

          const baseSim = cosineSimilarity(labelVec, sentenceVec);

          // Cross-Encoder Rules Engine: Penalize bad sections
          const sectionScore = getSectionScore(sentence.section_heading);
          let adjustedSim = baseSim;
          if (sectionScore === 3) adjustedSim *= 0.85; // Penalize Management/Treatment
          if (sectionScore === 4) adjustedSim *= 0.70; // Penalize References

          if (adjustedSim > bestScore) {
            bestScore = adjustedSim;
            bestMatch = sentence;
            confidence = sectionScore >= 3 ? 'low' : (baseSim > 0.8 ? 'high' : 'medium');
          }
        }
      }

      // Threshold for semantic match acceptance
      if (bestScore < 0.65) {
        bestMatch = null;
      }
    } 
    // 3. Lexical Partial Match (Fallback if API fails)
    else {
      const words = label.split(/\s+/).filter((w: string) => w.length > 3);
      if (words.length > 0) {
        const partialMatches = allSentences.filter((s: any) => {
          const sText = s.text.toLowerCase();
          return words.every((w: string) => sText.includes(w));
        });
        if (partialMatches.length > 0) {
          partialMatches.sort((a: any, b: any) => getSectionScore(a.section_heading) - getSectionScore(b.section_heading));
          bestMatch = partialMatches[0];
          confidence = getSectionScore(bestMatch.section_heading) >= 3 ? 'low' : 'medium';
        }
      }
    }

    if (bestMatch) {
      grounded_candidates.push({
        label: row.label,
        status: row.extraction_bucket,
        bucket: row.extraction_bucket,
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
        status: row.extraction_bucket,
        bucket: row.extraction_bucket,
        reason: 'No sufficiently specific supporting sentence found in source text.'
      });
    }
  }

  return { grounded_candidates, rejected_candidates };
}
