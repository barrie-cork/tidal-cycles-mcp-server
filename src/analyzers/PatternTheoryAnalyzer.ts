/**
 * PatternTheoryAnalyzer - Music theory analysis for Tidal patterns using tonal.js
 *
 * Analyzes currently playing patterns to detect key, scale, chords,
 * and provides suggestions for complementary pattern generation.
 */

import { Scale, Chord, Note } from "tonal";

/**
 * Analysis result structure returned by the analyzer
 */
export interface PatternTheoryAnalysis {
  detectedKey: {
    key: string;           // "C", "A", "F#"
    scale: string;         // "major", "minor", "dorian"
    confidence: number;    // 0-1
    alternatives: Array<{ key: string; scale: string; confidence: number }>;
  };
  chords: {
    detected: string[];    // ["Am", "G", "F"]
    progression: string;   // "i-VII-VI" if detectable
    harmonicTension: number; // 0-1
  };
  melody: {
    range: { low: string; high: string }; // "C3" to "G4"
    contour: 'ascending' | 'descending' | 'wave' | 'static';
  };
  rhythm: {
    noteDensity: number;   // events per cycle
    restRatio: number;     // 0-1
  };
  suggestions: {
    compatibleScales: string[];     // ["C major", "C mixolydian"]
    tensionNotes: string[];         // ["B", "F"] - leading tones
    resolutionNotes: string[];      // ["C", "E", "G"] - tonic chord
    avoidNotes: string[];           // Notes that would clash
  };
}

/**
 * Channel state interface matching the one in index.ts
 */
interface ChannelState {
  channel: string;
  pattern: string;
  timestamp: number;
  active: boolean;
}

export class PatternTheoryAnalyzer {
  // Scale definitions for degree-to-note conversion
  private readonly SCALES: Record<string, number[]> = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    pentatonic: [0, 2, 4, 7, 9],
    blues: [0, 3, 5, 6, 7, 10],
    harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
  };

  private readonly NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /**
   * Extract notes from a Tidal pattern string
   * Handles: n "0 3 5 7", note "c4 e4 g4", scale "minor" $ n "0 2 4"
   */
  extractNotesFromPattern(pattern: string, assumedRoot: string = 'C'): string[] {
    const notes: string[] = [];

    // Pattern 1: note "c4 e4 g4" - explicit note names
    const noteMatch = pattern.match(/note\s+"([^"]+)"/i);
    if (noteMatch) {
      const tokens = noteMatch[1].split(/\s+/);
      for (const token of tokens) {
        if (token === '~') continue;
        // Handle repetitions like c4*4
        const base = token.includes('*') ? token.split('*')[0] : token;
        // Extract pitch class using tonal.js
        const pc = Note.pitchClass(base);
        if (pc) notes.push(pc);
      }
      return [...new Set(notes)]; // Remove duplicates
    }

    // Pattern 2: n "0 3 5 7" - scale degrees (also matches # n "0 3 5")
    const nMatch = pattern.match(/n\s+"([^"]+)"/i);
    if (nMatch) {
      const tokens = nMatch[1].split(/\s+/);
      const rootIndex = this.NOTE_NAMES.indexOf(assumedRoot.toUpperCase());
      const normalizedRoot = rootIndex >= 0 ? rootIndex : 0; // Default to C if invalid

      // Check if there's a scale modifier
      const scaleMatch = pattern.match(/scale\s+"(\w+)"/i);
      const scaleName = scaleMatch ? scaleMatch[1].toLowerCase() : 'major';
      const scaleIntervals = this.SCALES[scaleName] || this.SCALES.major;

      for (const token of tokens) {
        if (token === '~') continue;
        // Handle repetitions like 0*4
        const base = token.includes('*') ? token.split('*')[0] : token;
        // Handle sub-patterns like [0 3]
        const cleanBase = base.replace(/[\[\]]/g, '');
        const degree = parseInt(cleanBase, 10);
        if (!isNaN(degree)) {
          // Map degree to note using scale intervals
          const octaveOffset = Math.floor(degree / scaleIntervals.length);
          const scaleDegree = ((degree % scaleIntervals.length) + scaleIntervals.length) % scaleIntervals.length;
          const semitones = scaleIntervals[scaleDegree];
          const noteIndex = (normalizedRoot + semitones) % 12;
          notes.push(this.NOTE_NAMES[noteIndex]);
        }
      }
      return [...new Set(notes)];
    }

    return notes;
  }

  /**
   * Detect key and scale from notes using tonal.js
   */
  detectKeyAndScale(notes: string[]): PatternTheoryAnalysis['detectedKey'] {
    if (notes.length === 0) {
      return { key: 'C', scale: 'major', confidence: 0, alternatives: [] };
    }

    // Use tonal.js Scale.detect
    const detected = Scale.detect(notes);

    if (detected.length === 0) {
      return { key: notes[0] || 'C', scale: 'chromatic', confidence: 0.3, alternatives: [] };
    }

    // Parse first result "C major" -> { key: "C", scale: "major" }
    const best = detected[0];
    const parts = best.split(' ');
    const key = parts[0];
    const scale = parts.slice(1).join(' ') || 'major';

    // Calculate confidence based on note coverage
    const scaleInfo = Scale.get(best);
    const coverage = scaleInfo.notes ? notes.length / scaleInfo.notes.length : 0.5;
    const confidence = Math.min(0.95, Math.max(0.4, coverage));

    // Build alternatives
    const alternatives = detected.slice(1, 4).map((alt, idx) => {
      const altParts = alt.split(' ');
      return {
        key: altParts[0],
        scale: altParts.slice(1).join(' ') || 'major',
        confidence: confidence * (0.8 - idx * 0.15)
      };
    });

    return { key, scale, confidence, alternatives };
  }

  /**
   * Detect chords from notes using tonal.js
   */
  detectChords(notes: string[]): PatternTheoryAnalysis['chords'] {
    if (notes.length < 3) {
      return { detected: [], progression: '', harmonicTension: 0 };
    }

    // Use tonal.js Chord.detect
    const detected = Chord.detect(notes);

    // Calculate harmonic tension (simplified: more alterations = more tension)
    let tension = 0;
    for (const chord of detected.slice(0, 3)) {
      if (/7|9|11|13/.test(chord)) tension += 0.2;
      if (/dim|aug/.test(chord)) tension += 0.3;
      if (/b|#/.test(chord)) tension += 0.1;
    }

    return {
      detected: detected.slice(0, 5),
      progression: '', // Would need temporal analysis
      harmonicTension: Math.min(1, tension)
    };
  }

  /**
   * Analyze melodic contour from notes
   */
  analyzeContour(notes: string[]): PatternTheoryAnalysis['melody'] {
    if (notes.length === 0) {
      return {
        range: { low: 'C', high: 'C' },
        contour: 'static'
      };
    }

    // Get MIDI values for comparison
    const midiValues = notes.map(n => Note.midi(n + '4') || 60); // Assume octave 4
    const sorted = [...midiValues].sort((a, b) => a - b);
    const low = Note.fromMidi(sorted[0]) || 'C4';
    const high = Note.fromMidi(sorted[sorted.length - 1]) || 'C4';

    // Determine contour (simplified)
    let contour: 'ascending' | 'descending' | 'wave' | 'static' = 'static';
    if (midiValues.length >= 2) {
      const first = midiValues[0];
      const last = midiValues[midiValues.length - 1];
      const diff = last - first;
      if (Math.abs(diff) <= 2) {
        contour = 'static';
      } else if (diff > 0) {
        contour = 'ascending';
      } else {
        contour = 'descending';
      }
      // Check for wave pattern
      const mid = midiValues.slice(1, -1);
      if (mid.length > 0) {
        const hasHighPeak = mid.some(m => m > first && m > last);
        const hasLowPeak = mid.some(m => m < first && m < last);
        if (hasHighPeak || hasLowPeak) {
          contour = 'wave';
        }
      }
    }

    return {
      range: {
        low: Note.pitchClass(low) || 'C',
        high: Note.pitchClass(high) || 'C'
      },
      contour
    };
  }

  /**
   * Analyze rhythm characteristics from pattern string
   */
  analyzeRhythm(pattern: string): PatternTheoryAnalysis['rhythm'] {
    // Count pattern elements (excluding rests)
    const tokens = pattern.match(/[a-z0-9]+/gi) || [];
    const restCount = (pattern.match(/~/g) || []).length;
    const totalElements = tokens.length + restCount;

    return {
      noteDensity: tokens.length,
      restRatio: totalElements > 0 ? restCount / totalElements : 0
    };
  }

  /**
   * Generate suggestions based on detected key/scale
   */
  generateSuggestions(key: string, scale: string): PatternTheoryAnalysis['suggestions'] {
    const fullScaleName = `${key} ${scale}`;

    // Get compatible scales using tonal.js
    const extended = Scale.extended(scale) || [];
    const reduced = Scale.reduced(scale) || [];
    const compatibleScales = [
      fullScaleName,
      ...extended.slice(0, 2).map(s => `${key} ${s}`),
      ...reduced.slice(0, 1).map(s => `${key} ${s}`)
    ];

    // Get scale info for tension/resolution notes
    const scaleInfo = Scale.get(fullScaleName);
    const scaleNotes = scaleInfo.notes || [];

    // Tension notes: 7th degree (leading tone), 4th degree
    const tensionNotes: string[] = [];
    if (scaleNotes.length >= 7) {
      tensionNotes.push(scaleNotes[6]); // 7th degree
    }
    if (scaleNotes.length >= 4) {
      tensionNotes.push(scaleNotes[3]); // 4th degree
    }

    // Resolution notes: tonic triad (1, 3, 5)
    const resolutionNotes: string[] = [];
    if (scaleNotes.length >= 1) resolutionNotes.push(scaleNotes[0]); // Root
    if (scaleNotes.length >= 3) resolutionNotes.push(scaleNotes[2]); // 3rd
    if (scaleNotes.length >= 5) resolutionNotes.push(scaleNotes[4]); // 5th

    // Avoid notes: chromatic notes not in scale
    const avoidNotes: string[] = [];
    if (scaleNotes.length > 0) {
      const scaleChroma = new Set(scaleNotes.map(n => Note.chroma(n)));
      for (let i = 0; i < 12; i++) {
        if (!scaleChroma.has(i)) {
          avoidNotes.push(this.NOTE_NAMES[i]);
        }
      }
    }

    return { compatibleScales, tensionNotes, resolutionNotes, avoidNotes };
  }

  /**
   * Main analysis entry point
   */
  analyze(channels: Map<string, ChannelState>, assumedRoot: string = 'C'): PatternTheoryAnalysis {
    // Collect notes from all active channels
    const allNotes: string[] = [];
    let totalDensity = 0;
    let totalRests = 0;
    let totalTokens = 0;

    for (const [, state] of channels) {
      if (!state.active || !state.pattern) continue;

      const notes = this.extractNotesFromPattern(state.pattern, assumedRoot);
      allNotes.push(...notes);

      // Collect rhythm stats
      const rhythm = this.analyzeRhythm(state.pattern);
      totalDensity += rhythm.noteDensity;
      totalRests += rhythm.restRatio * (rhythm.noteDensity + 1);
      totalTokens += rhythm.noteDensity + 1;
    }

    const uniqueNotes = [...new Set(allNotes)];

    // Detect key/scale
    const detectedKey = this.detectKeyAndScale(uniqueNotes);

    // Detect chords
    const chords = this.detectChords(uniqueNotes);

    // Analyze melody contour
    const melody = this.analyzeContour(uniqueNotes);

    // Aggregate rhythm analysis
    const rhythm = {
      noteDensity: totalDensity,
      restRatio: totalTokens > 0 ? totalRests / totalTokens : 0
    };

    // Generate suggestions based on detected key/scale
    const suggestions = this.generateSuggestions(detectedKey.key, detectedKey.scale);

    return { detectedKey, chords, melody, rhythm, suggestions };
  }
}
