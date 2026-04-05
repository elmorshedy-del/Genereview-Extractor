/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { motion, AnimatePresence } from 'motion/react';
import { 
  Play, 
  Settings, 
  FileText, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  Copy, 
  Database,
  Search,
  Download,
  Terminal,
  RefreshCw,
  Zap,
  BrainCircuit
} from 'lucide-react';
import { cn } from './lib/utils';
import { GENEREVIEWS_SYSTEM_PROMPT } from './lib/prompts';
import { freezeExternalPhenotypeExtraction } from './lib/external-phenotype-extraction';
import { groundToSidecar } from './lib/extraction-manager';

const MODELS = [
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', description: 'Best for complex reasoning' },
  { id: 'gemini-3.1-flash-preview', name: 'Gemini 3.1 Flash', description: 'Fast and efficient' },
  { id: 'gemini-3-pro-preview', name: 'Gemini 3.0 Pro', description: 'Stable pro model' },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3.0 Flash', description: 'Fast stable model' },
];

export default function App() {
  const [input, setInput] = useState('');
  const [inputMode, setInputMode] = useState<'text' | 'url'>('text');
  const [selectedModel, setSelectedModel] = useState(MODELS[0].id);
  const [isHighThinking, setIsHighThinking] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [rawResult, setRawResult] = useState<any>(null);
  const [normalizedResult, setNormalizedResult] = useState<any>(null);
  const [groundedSidecar, setGroundedSidecar] = useState<any>(null);
  const [syntheticStructure, setSyntheticStructure] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'input' | 'raw' | 'normalized' | 'sidecar' | 'structure'>('input');
  
  const handleExtract = async () => {
    if (!input.trim()) return;
    
    setIsExtracting(true);
    setError(null);
    setRawResult(null);
    setNormalizedResult(null);
    setActiveTab('raw');

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      
      const modelToUse = isHighThinking ? 'gemini-3.1-pro-preview' : selectedModel;
      const config: any = {
        systemInstruction: GENEREVIEWS_SYSTEM_PROMPT,
        responseMimeType: "application/json",
      };

      if (isHighThinking) {
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.HIGH };
      }

      if (inputMode === 'url') {
        config.tools = [{ urlContext: {} }];
      }

      const prompt = inputMode === 'url' 
        ? `Extract structured phenotype data from the GeneReviews chapter at this URL: ${input.trim()}`
        : input;

      const response = await ai.models.generateContent({
        model: modelToUse,
        contents: prompt,
        config,
      });

      const text = response.text;
      if (!text) throw new Error("No response from Gemini");

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // Attempt to extract JSON if it's wrapped in markdown
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error("Failed to parse JSON response");
        }
      }

      setRawResult(parsed);
      
      // Run normalization/freeze pipeline
      const frozen = freezeExternalPhenotypeExtraction(parsed);
      setNormalizedResult(frozen);

      let clinicalText = input;
      if (inputMode === 'url') {
        try {
          const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(input.trim())}`);
          const data = await res.json();
          if (data.contents) {
            let html = data.contents;
            // Inject newlines for block elements so textContent preserves paragraphs
            html = html.replace(/<(p|div|h[1-6]|br|li|tr)[^>]*>/gi, '\n\n');
            const doc = new DOMParser().parseFromString(html, 'text/html');
            // Remove non-content tags
            doc.querySelectorAll('script, style, nav, header, footer, noscript, aside').forEach(el => el.remove());
            
            const mainContent = doc.querySelector('.bk-main-content') || doc.querySelector('#main-content') || doc.querySelector('main') || doc.body;
            clinicalText = mainContent.textContent || '';
            clinicalText = clinicalText.replace(/\n\s*\n/g, '\n\n').trim();
          }
        } catch (e) {
          console.warn('Failed to fetch URL text for grounding via proxy:', e);
          clinicalText = '';
        }

        // Fallback to Gemini text extraction if proxy fails or returns too little text
        if (!clinicalText || clinicalText.length < 500) {
          console.log("Proxy fetch failed or returned little text. Falling back to Gemini text extraction...");
          try {
            const textRes = await ai.models.generateContent({
              model: modelToUse,
              contents: `Read this URL: ${input.trim()}. Please extract the full text of the following sections verbatim: "Summary", "Suggestive Findings", "Clinical Description", and "Genotype-Phenotype Correlations". Do not summarize.`,
              config: { tools: [{ urlContext: {} }] }
            });
            clinicalText = textRes.text || '';
            console.log("Gemini fallback returned text of length:", clinicalText.length);
            console.log("Gemini fallback text preview:", clinicalText.substring(0, 500));
            if (!clinicalText || clinicalText.length < 500) {
              setError(`Could not fetch the raw text from the URL (proxy failed and AI fallback was blocked). Please switch to "Text" input mode and copy-paste the chapter text directly.`);
              setActiveTab('normalized');
              setIsExtracting(false);
              return;
            }
          } catch (e: any) {
            console.warn('Gemini text extraction fallback failed:', e);
            setError(`Could not fetch the raw text from the URL (AI fallback failed: ${e.message}). Please switch to "Text" input mode and copy-paste the chapter text directly.`);
            setActiveTab('normalized');
            setIsExtracting(false);
            return;
          }
        }
      }

      // Attempt grounding sidecar if we have text
      if (clinicalText) {
        try {
          const { groundedSidecar, syntheticStructure } = await groundToSidecar(frozen, {
            clinicalText: clinicalText,
            includeUncertain: true,
            apiKey: process.env.GEMINI_API_KEY
          });
          setGroundedSidecar(groundedSidecar);
          setSyntheticStructure(syntheticStructure);
          setActiveTab('sidecar');
        } catch (gErr: any) {
          console.warn('Grounding sidecar failed:', gErr);
          setError(`Extraction succeeded, but grounding failed: ${gErr.message}`);
          setActiveTab('normalized');
        }
      } else {
        console.warn('No clinical text available for grounding.');
        setError('Extraction succeeded, but could not fetch raw text from the URL for grounding.');
        setActiveTab('normalized');
      }

    } catch (err: any) {
      console.error(err);
      setError(err.message || "An unexpected error occurred during extraction.");
      setActiveTab('input');
    } finally {
      setIsExtracting(false);
    }
  };

  const copyToClipboard = (data: any) => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
  };

  const downloadJson = (data: any, filename: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-gray-200 font-sans selection:bg-indigo-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-black/40 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Database className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-lg font-semibold tracking-tight text-white">Genovy Phenotype Extractor</h1>
          </div>
          
          <div className="flex items-center gap-4">
            <button
              onClick={() => setIsHighThinking(!isHighThinking)}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all text-sm font-medium",
                isHighThinking 
                  ? "bg-indigo-500/20 border-indigo-500/50 text-indigo-300 shadow-lg shadow-indigo-500/10" 
                  : "bg-white/5 border-white/10 text-gray-400 hover:bg-white/10"
              )}
            >
              <BrainCircuit className={cn("w-4 h-4", isHighThinking && "text-indigo-400")} />
              <span>High Thinking</span>
            </button>

            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-full px-3 py-1.5">
              <Settings className="w-4 h-4 text-gray-400" />
              <select 
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isHighThinking}
                className={cn(
                  "bg-transparent text-sm font-medium focus:outline-none cursor-pointer text-gray-300",
                  isHighThinking && "opacity-50 cursor-not-allowed"
                )}
              >
                {MODELS.map(m => (
                  <option key={m.id} value={m.id} className="bg-[#1a1a1c]">{m.name}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* Left Column: Input */}
          <div className="lg:col-span-7 space-y-6">
            <div className="bg-[#141416] border border-white/5 rounded-2xl overflow-hidden shadow-2xl">
              <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-indigo-400" />
                    <span className="text-sm font-medium text-gray-300">GeneReviews Source</span>
                  </div>
                  <div className="flex bg-black/40 rounded-lg p-1 border border-white/5">
                    <button 
                      onClick={() => setInputMode('text')}
                      className={cn(
                        "px-3 py-1 rounded-md text-xs font-medium transition-all",
                        inputMode === 'text' ? "bg-indigo-600 text-white" : "text-gray-500 hover:text-gray-300"
                      )}
                    >
                      Text
                    </button>
                    <button 
                      onClick={() => setInputMode('url')}
                      className={cn(
                        "px-3 py-1 rounded-md text-xs font-medium transition-all",
                        inputMode === 'url' ? "bg-indigo-600 text-white" : "text-gray-500 hover:text-gray-300"
                      )}
                    >
                      Link
                    </button>
                  </div>
                </div>
                <button 
                  onClick={() => setInput('')}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Clear
                </button>
              </div>
              
              {inputMode === 'text' ? (
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Paste GeneReviews chapter content here..."
                  className="w-full h-[600px] bg-transparent p-6 text-sm leading-relaxed focus:outline-none resize-none placeholder:text-gray-600"
                />
              ) : (
                <div className="h-[600px] p-6 flex flex-col items-center justify-center space-y-4">
                  <div className="w-full max-w-md space-y-2">
                    <label className="text-xs font-medium text-gray-500 ml-1">GeneReviews URL</label>
                    <input 
                      type="url"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder="https://www.ncbi.nlm.nih.gov/books/NBK..."
                      className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-indigo-500/50 transition-all"
                    />
                  </div>
                  <p className="text-xs text-gray-600 max-w-xs text-center leading-relaxed">
                    The model will fetch the content directly from the provided URL using the URL Context tool.
                  </p>
                </div>
              )}
              <div className="p-4 bg-white/[0.02] border-t border-white/5 flex justify-end">
                <button
                  onClick={handleExtract}
                  disabled={isExtracting || !input.trim()}
                  className={cn(
                    "flex items-center gap-2 px-6 py-2.5 rounded-xl font-semibold text-sm transition-all duration-200",
                    isExtracting || !input.trim() 
                      ? "bg-gray-800 text-gray-500 cursor-not-allowed" 
                      : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20 active:scale-95"
                  )}
                >
                  {isExtracting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Extracting...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-current" />
                      Run Pipeline
                    </>
                  )}
                </button>
              </div>
            </div>
            
            {error && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3"
              >
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                <div className="text-sm text-red-200/80 leading-relaxed">
                  {error}
                </div>
              </motion.div>
            )}
          </div>

          {/* Right Column: Results */}
          <div className="lg:col-span-5 space-y-6">
            <div className="bg-[#141416] border border-white/5 rounded-2xl overflow-hidden shadow-2xl flex flex-col h-[740px]">
              <div className="px-2 pt-2 bg-white/[0.02] border-b border-white/5">
                <div className="flex gap-1">
                  <TabButton 
                    active={activeTab === 'sidecar'} 
                    onClick={() => setActiveTab('sidecar')}
                    icon={<CheckCircle2 className="w-3.5 h-3.5" />}
                    label="Sidecar"
                    disabled={!groundedSidecar}
                  />
                  <TabButton 
                    active={activeTab === 'structure'} 
                    onClick={() => setActiveTab('structure')}
                    icon={<Database className="w-3.5 h-3.5" />}
                    label="Structure"
                    disabled={!syntheticStructure}
                  />
                  <TabButton 
                    active={activeTab === 'normalized'} 
                    onClick={() => setActiveTab('normalized')}
                    icon={<Database className="w-3.5 h-3.5" />}
                    label="Normalized"
                    disabled={!normalizedResult}
                  />
                  <TabButton 
                    active={activeTab === 'raw'} 
                    onClick={() => setActiveTab('raw')}
                    icon={<Terminal className="w-3.5 h-3.5" />}
                    label="Raw Output"
                    disabled={!rawResult}
                  />
                </div>
              </div>

              <div className="flex-1 overflow-auto p-6 font-mono text-xs relative">
                <AnimatePresence mode="wait">
                  {activeTab === 'sidecar' && groundedSidecar && (
                    <motion.div
                      key="sidecar"
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                    >
                      <div className="flex justify-between items-center mb-4 sticky top-0 bg-[#141416] py-2 z-10">
                        <span className="text-emerald-400 font-semibold uppercase tracking-wider">Grounded Sidecar</span>
                        <div className="flex gap-2">
                          <IconButton icon={<Copy className="w-3.5 h-3.5" />} onClick={() => copyToClipboard(groundedSidecar)} tooltip="Copy JSON" />
                          <IconButton icon={<Download className="w-3.5 h-3.5" />} onClick={() => downloadJson(groundedSidecar, 'grounded_sidecar.json')} tooltip="Download" />
                        </div>
                      </div>
                      <pre className="text-gray-400 whitespace-pre-wrap">
                        {JSON.stringify(groundedSidecar, null, 2)}
                      </pre>
                    </motion.div>
                  )}

                  {activeTab === 'structure' && syntheticStructure && (
                    <motion.div
                      key="structure"
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                    >
                      <div className="flex justify-between items-center mb-4 sticky top-0 bg-[#141416] py-2 z-10">
                        <span className="text-blue-400 font-semibold uppercase tracking-wider">Synthetic Clinical Structure</span>
                        <div className="flex gap-2">
                          <IconButton icon={<Copy className="w-3.5 h-3.5" />} onClick={() => copyToClipboard(syntheticStructure)} tooltip="Copy JSON" />
                          <IconButton icon={<Download className="w-3.5 h-3.5" />} onClick={() => downloadJson(syntheticStructure, 'synthetic_clinical_structure.json')} tooltip="Download" />
                        </div>
                      </div>
                      <pre className="text-gray-400 whitespace-pre-wrap">
                        {JSON.stringify(syntheticStructure, null, 2)}
                      </pre>
                    </motion.div>
                  )}

                  {activeTab === 'normalized' && normalizedResult && (
                    <motion.div
                      key="normalized"
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                    >
                      <div className="flex justify-between items-center mb-4 sticky top-0 bg-[#141416] py-2 z-10">
                        <span className="text-indigo-400 font-semibold uppercase tracking-wider">Frozen Schema</span>
                        <div className="flex gap-2">
                          <IconButton icon={<Copy className="w-3.5 h-3.5" />} onClick={() => copyToClipboard(normalizedResult)} tooltip="Copy JSON" />
                          <IconButton icon={<Download className="w-3.5 h-3.5" />} onClick={() => downloadJson(normalizedResult, 'normalized_extraction.json')} tooltip="Download" />
                        </div>
                      </div>
                      <pre className="text-gray-400 whitespace-pre-wrap">
                        {JSON.stringify(normalizedResult, null, 2)}
                      </pre>
                    </motion.div>
                  )}

                  {activeTab === 'raw' && rawResult && (
                    <motion.div
                      key="raw"
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                    >
                      <div className="flex justify-between items-center mb-4 sticky top-0 bg-[#141416] py-2 z-10">
                        <span className="text-gray-500 font-semibold uppercase tracking-wider">Raw Model Output</span>
                        <div className="flex gap-2">
                          <IconButton icon={<Copy className="w-3.5 h-3.5" />} onClick={() => copyToClipboard(rawResult)} tooltip="Copy JSON" />
                        </div>
                      </div>
                      <pre className="text-gray-500 whitespace-pre-wrap">
                        {JSON.stringify(rawResult, null, 2)}
                      </pre>
                    </motion.div>
                  )}

                  {!rawResult && !isExtracting && (
                    <div className="h-full flex flex-col items-center justify-center text-gray-600 text-center px-8">
                      <div className="w-12 h-12 bg-white/[0.02] rounded-full flex items-center justify-center mb-4">
                        <Search className="w-6 h-6" />
                      </div>
                      <p className="text-sm font-medium mb-1">No results yet</p>
                      <p className="text-xs">Run the pipeline to see extracted clinical data</p>
                    </div>
                  )}

                  {isExtracting && (
                    <div className="h-full flex flex-col items-center justify-center text-indigo-500/50 text-center px-8">
                      <RefreshCw className="w-8 h-8 animate-spin mb-4" />
                      <p className="text-sm font-medium">Processing Chapter...</p>
                      <p className="text-xs mt-2 text-gray-600 italic">\"Extracting phenotypes, flattenting metadata, and normalizing ancillary evidence...\"</p>
                    </div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}

function TabButton({ active, onClick, icon, label, disabled }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string, disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-2 px-4 py-3 text-xs font-medium transition-all relative",
        active ? "text-white" : "text-gray-500 hover:text-gray-300",
        disabled && "opacity-30 cursor-not-allowed"
      )}
    >
      {icon}
      {label}
      {active && (
        <motion.div 
          layoutId="activeTab"
          className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500"
        />
      )}
    </button>
  );
}

function IconButton({ icon, onClick, tooltip }: { icon: React.ReactElement, onClick: () => void, tooltip: string }) {
  return (
    <button
      onClick={onClick}
      title={tooltip}
      className="p-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-gray-400 hover:text-white transition-all"
    >
      {icon}
    </button>
  );
}
