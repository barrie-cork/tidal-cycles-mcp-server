/**
 * Pattern Generator for TidalCycles
 *
 * Generates Tidal patterns by style, complexity, and musical parameters.
 */

export interface PatternResult {
  channel: string;
  pattern: string;
}

export interface DrumPatterns {
  [complexity: string]: string;
}

export interface StylePatterns {
  [style: string]: DrumPatterns;
}

export class PatternGenerator {
  // Drum patterns organized by style and complexity level
  private drumPatterns: StylePatterns = {
    techno: {
      low: 'sound "bd*4"',
      med: 'stack [sound "bd*4", sound "hh*8" # gain 0.5]',
      high: 'stack [sound "bd*4", sound "hh*16" # gain 0.4, sound "cp(3,8)" # gain 0.6]',
    },
    house: {
      low: 'sound "bd*4"',
      med: 'stack [sound "bd*4", sound "~ hh ~ hh" # gain 0.6]',
      high: 'stack [sound "bd*4", sound "hh(5,8)" # gain 0.5, sound "~ cp ~ cp" # gain 0.7]',
    },
    dnb: {
      low: 'sound "bd ~ ~ bd ~ bd ~ ~"',
      med: 'stack [sound "bd(3,8)", sound "sd ~ sd ~" # gain 0.8]',
      high: 'stack [sound "bd(3,8)", sound "sd ~ sd ~" # gain 0.8, sound "hh*16" # gain 0.4]',
    },
    ambient: {
      low: 'sound "bd/2" # room 0.9 # size 0.9',
      med: 'sound "bd/2 ~ ~ sd/4" # room 0.9 # size 0.8 # gain 0.7',
      high: 'stack [sound "bd/2" # room 0.9, sound "hh/4" # room 0.8 # gain 0.3]',
    },
    trap: {
      low: 'sound "808bd ~ ~ 808bd"',
      med: 'stack [sound "808bd(3,8)", sound "808sd ~ 808sd ~" # gain 0.8]',
      high: 'stack [sound "808bd(3,8)", sound "808sd ~ 808sd ~", sound "808hc*8" # gain 0.5]',
    },
    jungle: {
      low: 'sound "bd ~ bd ~" # speed 1.5',
      med: 'stack [sound "bd(5,8)", sound "sd ~ sd ~" # speed 1.2]',
      high: 'fast 2 $ stack [sound "bd(5,8)", sound "sd(3,8)", sound "hh*16" # gain 0.4]',
    },
    jazz: {
      low: 'sound "bd ~ ~ bd"',
      med: 'stack [sound "bd ~ ~ bd", sound "rim(3,8)" # gain 0.6]',
      high: 'stack [sound "bd ~ ~ bd", sound "rim(3,8)" # gain 0.6, sound "hh(5,8)" # gain 0.4]',
    },
  };

  // Bass patterns by style
  private bassPatterns: { [style: string]: string } = {
    techno: 'sound "bass3" # speed 0.5 # lpf 800 # gain 0.8',
    house: 'sound "bass3(3,8)" # speed 0.5 # lpf 1000 # gain 0.8',
    dnb: 'sound "bass3(5,8)" # speed 0.75 # lpf 1200 # gain 0.85',
    acid: 'sound "bass3*4" # speed "<0.5 0.75 0.5 1>" # lpf 1200 # resonance 0.3 # gain 0.8',
    dub: 'sound "bass3(3,8)" # room 0.6 # delay 0.5 # speed 0.5 # gain 0.75',
    funk: 'sound "bass3(5,8)" # speed 0.75 # gain 0.8',
    jazz: 'sound "bass3" # speed "<0.5 0.75 1 0.75>" # lpf 2000 # gain 0.7',
  };

  // Scale definitions (semitone offsets from root)
  private scales: { [scale: string]: number[] } = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    pentatonic: [0, 2, 4, 7, 9],
    blues: [0, 3, 5, 6, 7, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };

  // Variation transformations by intensity
  private variations: { [intensity: string]: (pattern: string) => string } = {
    subtle: (p) => `${p} # gain (range 0.8 1 $ rand)`,
    moderate: (p) => `sometimes (fast 2) $ ${p} # speed (range 0.9 1.1 $ rand)`,
    extreme: (p) => `jux rev $ fast 2 $ ${p} # lpf (range 500 3000 $ saw)`,
    glitch: (p) => `stut 4 0.5 0.25 $ scramble 4 $ ${p} # crush 4`,
  };

  /**
   * Generate a drum pattern
   */
  generateDrums(style: string, complexity: number = 0.5): PatternResult {
    const normalizedStyle = style.toLowerCase();
    const patterns = this.drumPatterns[normalizedStyle];

    if (!patterns) {
      throw new Error(`Unknown drum style: ${style}. Available: ${Object.keys(this.drumPatterns).join(', ')}`);
    }

    // Map complexity (0-1) to low/med/high
    let level: string;
    if (complexity < 0.33) {
      level = 'low';
    } else if (complexity < 0.66) {
      level = 'med';
    } else {
      level = 'high';
    }

    return {
      channel: 'd1',
      pattern: patterns[level],
    };
  }

  /**
   * Generate a bassline pattern
   */
  generateBassline(style: string): PatternResult {
    const normalizedStyle = style.toLowerCase();
    const pattern = this.bassPatterns[normalizedStyle];

    if (!pattern) {
      throw new Error(`Unknown bass style: ${style}. Available: ${Object.keys(this.bassPatterns).join(', ')}`);
    }

    return {
      channel: 'd4',
      pattern,
    };
  }

  /**
   * Generate a melodic pattern
   */
  generateMelody(scale: string, length: number = 8): PatternResult {
    const normalizedScale = scale.toLowerCase();
    const scaleNotes = this.scales[normalizedScale];

    if (!scaleNotes) {
      throw new Error(`Unknown scale: ${scale}. Available: ${Object.keys(this.scales).join(', ')}`);
    }

    // Generate random scale degrees (0-6 for 7-note scales, 0-4 for pentatonic)
    const maxDegree = scaleNotes.length - 1;
    const degrees: number[] = [];
    for (let i = 0; i < length; i++) {
      degrees.push(Math.floor(Math.random() * (maxDegree + 1)));
    }

    const degreeString = degrees.join(' ');
    // Use Tidal's scale function to convert degrees to notes, add octave offset
    // Use arpy sample with note to create melodic patterns (arpy is in default Dirt-Samples)
    const pattern = `note (scale "${normalizedScale}" "${degreeString}") # sound "arpy" # gain 0.8 # room 0.3`;

    return {
      channel: 'd6',
      pattern,
    };
  }

  /**
   * Generate a complete multi-channel pattern
   */
  generateComplete(style: string): PatternResult[] {
    const normalizedStyle = style.toLowerCase();
    const results: PatternResult[] = [];

    // Generate drums (medium complexity)
    const drums = this.generateDrums(normalizedStyle, 0.5);
    results.push(drums);

    // Generate hi-hats on d2 for most styles
    if (normalizedStyle !== 'ambient') {
      const hats = this.getHatsPattern(normalizedStyle);
      results.push({
        channel: 'd2',
        pattern: hats,
      });
    }

    // Generate bass
    const bassStyle = this.mapStyleToBass(normalizedStyle);
    const bass = this.generateBassline(bassStyle);
    results.push(bass);

    return results;
  }

  /**
   * Generate a variation of an existing pattern
   */
  generateVariation(currentPattern: string, intensity: string): string {
    const normalizedIntensity = intensity.toLowerCase();
    const transform = this.variations[normalizedIntensity];

    if (!transform) {
      throw new Error(`Unknown intensity: ${intensity}. Available: ${Object.keys(this.variations).join(', ')}`);
    }

    return transform(currentPattern);
  }

  /**
   * Get hi-hat pattern based on style
   */
  private getHatsPattern(style: string): string {
    const hatPatterns: { [style: string]: string } = {
      techno: 'sound "hh*8" # gain 0.5',
      house: 'sound "~ hh ~ hh" # gain 0.6',
      dnb: 'sound "hh*16" # gain 0.4',
      trap: 'sound "808hc*8" # gain 0.5',
      jungle: 'fast 2 $ sound "hh*8" # gain 0.4',
      jazz: 'sound "hh(5,8)" # gain 0.4',
      ambient: 'sound "hh/4" # room 0.8 # gain 0.3',
    };

    return hatPatterns[style] || 'sound "hh*8" # gain 0.5';
  }

  /**
   * Map genre style to bass style
   */
  private mapStyleToBass(style: string): string {
    const mapping: { [style: string]: string } = {
      techno: 'techno',
      house: 'house',
      dnb: 'dnb',
      ambient: 'dub',
      trap: 'techno',
      jungle: 'dnb',
      jazz: 'jazz',
    };

    return mapping[style] || 'house';
  }

  // =========================================================================
  // NEW MUSIC THEORY TOOLS
  // =========================================================================

  /**
   * Generate euclidean rhythm pattern
   * Distributes hits evenly across steps using Tidal's euclidean notation
   */
  generateEuclidean(hits: number, steps: number, sound: string = 'bd'): PatternResult {
    // Validate inputs
    if (hits < 1 || hits > 16) {
      throw new Error('Hits must be between 1 and 16');
    }
    if (steps < 2 || steps > 16) {
      throw new Error('Steps must be between 2 and 16');
    }
    if (hits > steps) {
      throw new Error('Hits cannot exceed steps');
    }

    // Use Tidal's euclidean mini-notation e(k,n)
    const pattern = `sound "${sound}(${hits},${steps})" # gain 0.8`;

    return {
      channel: 'd3',
      pattern,
    };
  }

  /**
   * Generate scale pattern (educational - plays ascending scale)
   */
  generateScale(root: string, scaleName: string): PatternResult {
    const normalizedScale = scaleName.toLowerCase().replace(/ /g, '_');
    const scaleNotes = this.scales[normalizedScale];

    if (!scaleNotes) {
      throw new Error(`Unknown scale: ${scaleName}. Available: ${Object.keys(this.scales).join(', ')}`);
    }

    // Generate ascending scale degrees
    const degrees = scaleNotes.map((_, i) => i).join(' ');

    // Normalize root note (e.g., "C" -> "c", "F#" -> "fs")
    const normalizedRoot = root.toLowerCase().replace('#', 's').replace('b', 'f');

    // Use Tidal's scale function with root note transposition
    // The |+ note adds the root note offset to transpose the scale
    const pattern = `note ((scale "${normalizedScale}" "${degrees}") + "${normalizedRoot}3") # sound "arpy" # gain 0.7 # room 0.3`;

    return {
      channel: 'd6',
      pattern,
    };
  }

  /**
   * Generate chord progression pattern
   */
  generateChordProgression(key: string, style: string = 'pop'): PatternResult {
    // Common progressions by style (using scale degrees)
    const progressions: { [style: string]: string } = {
      pop: '0 3 4 4',           // I-IV-V-V
      jazz: '1 4 0 0',          // ii-V-I-I
      blues: '0 0 3 3 4 4 3 3', // 12-bar simplified
      minor: '0 5 3 4',         // i-VI-IV-V
      rock: '0 3 4 3',          // I-IV-V-IV
      classical: '0 3 4 0',     // I-IV-V-I (authentic cadence)
      edm: '0 5 3 4',           // I-VI-IV-V (same as minor, common in EDM)
      ballad: '0 4 5 3',        // I-V-VI-IV (Axis progression)
    };

    const normalizedStyle = style.toLowerCase();
    const prog = progressions[normalizedStyle] || progressions.pop;

    // Use superpiano for chord sounds with some reverb
    const pattern = `note (scale "${key}" "${prog}") # sound "superpiano" # gain 0.6 # room 0.3`;

    return {
      channel: 'd5',
      pattern,
    };
  }

  /**
   * Generate drum fill pattern for transitions
   */
  generateFill(style: string = 'standard'): PatternResult {
    const fills: { [style: string]: string } = {
      standard: 'fast 2 $ sound "sd*4 sd*8"',
      snare_roll: 'sound "sd*16" # gain (range 0.5 1 $ saw)',
      tom_fill: 'sound "tom:0 tom:1 tom:2 tom:3*2"',
      breakdown: 'fast 4 $ sound "bd sd bd sd"',
    };

    const normalizedStyle = style.toLowerCase();
    const pattern = fills[normalizedStyle] || fills.standard;

    return {
      channel: 'd1',
      pattern,
    };
  }

  /**
   * Apply effect to an existing pattern
   */
  applyEffect(pattern: string, effect: string, params: { [key: string]: number } = {}): string {
    const effects: { [effect: string]: (p: string, params: { [key: string]: number }) => string } = {
      reverb: (p, params) => `${p} # room ${params.room || params.amount || 0.5} # size ${params.size || 0.8}`,
      delay: (p, params) => `${p} # delay ${params.time || params.amount || 0.5} # delayfeedback ${params.feedback || 0.4}`,
      lpf: (p, params) => `${p} # lpf ${params.cutoff || (params.amount ? params.amount * 3000 + 200 : 1000)}`,
      hpf: (p, params) => `${p} # hpf ${params.cutoff || (params.amount ? params.amount * 1000 : 200)}`,
      distortion: (p, params) => `${p} # crush ${params.crush || Math.floor((1 - (params.amount || 0.5)) * 8 + 2)}`,
      pan: (p, params) => `${p} # pan ${params.position || params.amount || 0.5}`,
    };

    const normalizedEffect = effect.toLowerCase();
    const effectFn = effects[normalizedEffect];

    if (!effectFn) {
      throw new Error(`Unknown effect: ${effect}. Available: ${Object.keys(effects).join(', ')}`);
    }

    return effectFn(pattern, params);
  }

  /**
   * Transpose pattern by semitones
   */
  transpose(pattern: string, semitones: number): string {
    if (semitones < -12 || semitones > 12) {
      throw new Error('Semitones must be between -12 and 12');
    }

    // Add note offset to pattern using Tidal's |+ operator
    return `${pattern} |+ note ${semitones}`;
  }

  /**
   * Humanize pattern (add subtle timing variation)
   */
  humanize(pattern: string, amount: number = 0.02): string {
    if (amount < 0.01 || amount > 0.1) {
      throw new Error('Humanization amount must be between 0.01 and 0.1');
    }

    // Use Tidal's nudge to add timing variation
    return `${pattern} # nudge (range 0 ${amount} $ rand)`;
  }
}
