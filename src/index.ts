#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { WebSocketServerTransport } from "./websocket-transport.js";
import { PatternGenerator } from "./generators/PatternGenerator.js";

/**
 * TidalCycles MCP Server
 *
 * Enables Claude to control TidalCycles through structured tool calls.
 * Provides conversational live coding with state awareness.
 */

interface ChannelState {
  channel: string;
  pattern: string;
  timestamp: number;
  active: boolean;
}

interface TidalConfig {
  tidalFile: string;
  bootTidalPath?: string;
  useGhci: boolean;
  logFile?: string;
  transport: 'stdio' | 'websocket';
  websocketPort?: number;
  websocketHost?: string;
}

interface LogEntry {
  timestamp: string;
  request: string;
  response: string;
}

class TidalMCPServer {
  private server: Server;
  private channels: Map<string, ChannelState> = new Map();
  private config: TidalConfig;
  private ghciProcess?: ChildProcess;
  private patternHistory: Array<{ channel: string; pattern: string; timestamp: number }> = [];
  private logFile: string;
  private ghciStreamAlive: boolean = false;
  private isReconnecting: boolean = false;
  private wsTransport?: WebSocketServerTransport;
  private patternGenerator: PatternGenerator = new PatternGenerator();

  constructor(config: TidalConfig) {
    this.config = config;
    // Set log file path - same directory as the tidal output file
    const tidalDir = path.dirname(config.tidalFile);
    this.logFile = config.logFile || path.join(tidalDir, "tidal-mcp-session.log");

    this.server = new Server(
      {
        name: "tidal-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize all channels as inactive
    for (let i = 1; i <= 9; i++) {
      this.channels.set(`d${i}`, {
        channel: `d${i}`,
        pattern: "",
        timestamp: 0,
        active: false,
      });
    }

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Logs a pattern evaluation to the human-readable log file
   */
  private async logPatternEvaluation(request: string, channel: string, pattern: string) {
    const timestamp = new Date().toISOString();
    const fullPattern = `${channel} $ ${pattern}`;

    const logEntry = `${timestamp}
REQUEST: ${request}
RESPONSE: ${fullPattern}
---

`;

    try {
      await fs.appendFile(this.logFile, logEntry, 'utf-8');
    } catch (error) {
      console.error(`Failed to write to log file: ${error}`);
    }
  }

  /**
   * Logs other actions (hush, silence, etc.) to the log file
   */
  private async logAction(action: string, details?: string) {
    const timestamp = new Date().toISOString();

    const logEntry = `${timestamp}
ACTION: ${action}${details ? '\nDETAILS: ' + details : ''}
---

`;

    try {
      await fs.appendFile(this.logFile, logEntry, 'utf-8');
    } catch (error) {
      console.error(`Failed to write to log file: ${error}`);
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "tidal_eval",
          description: "Evaluate a TidalCycles pattern on a specific channel (d1-d9). This is the main way to make music with Tidal.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                description: "The channel to evaluate on (d1, d2, ... d9)",
                enum: ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"],
              },
              pattern: {
                type: "string",
                description: "The TidalCycles pattern to evaluate (without the 'd1 $' prefix)",
              },
            },
            required: ["channel", "pattern"],
          },
        },
        {
          name: "tidal_hush",
          description: "Stop all currently playing patterns immediately. Use this to clear everything.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "tidal_silence",
          description: "Stop a specific channel. More graceful than hush for single channels.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                description: "The channel to silence (d1-d9)",
                enum: ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"],
              },
            },
            required: ["channel"],
          },
        },
        {
          name: "tidal_get_state",
          description: "Get the current state of all channels - what patterns are playing and when they started.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "tidal_solo",
          description: "Solo a specific channel, muting all others temporarily.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                description: "The channel to solo",
                enum: ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"],
              },
            },
            required: ["channel"],
          },
        },
        {
          name: "tidal_unsolo",
          description: "Restore all channels after soloing.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "tidal_get_history",
          description: "Get the history of patterns evaluated in this session.",
          inputSchema: {
            type: "object",
            properties: {
              limit: {
                type: "number",
                description: "Maximum number of history items to return (default: 10)",
              },
            },
          },
        },
        {
          name: "tidal_set_tempo",
          description: "Set the global tempo in BPM. This affects all patterns.",
          inputSchema: {
            type: "object",
            properties: {
              bpm: {
                type: "number",
                description: "The tempo in beats per minute (e.g., 120, 140)",
              },
            },
            required: ["bpm"],
          },
        },
        {
          name: "generate_drums",
          description: "Generate a drum pattern in a specific style. Auto-plays on d1.",
          inputSchema: {
            type: "object",
            properties: {
              style: {
                type: "string",
                enum: ["techno", "house", "dnb", "ambient", "trap", "jungle", "jazz"],
                description: "Genre/style of drums",
              },
              complexity: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description: "Pattern complexity (0=simple, 1=complex). Default: 0.5",
              },
            },
            required: ["style"],
          },
        },
        {
          name: "generate_bassline",
          description: "Generate a bassline pattern. Auto-plays on d4.",
          inputSchema: {
            type: "object",
            properties: {
              style: {
                type: "string",
                enum: ["techno", "house", "dnb", "acid", "dub", "funk", "jazz"],
                description: "Style of bassline",
              },
            },
            required: ["style"],
          },
        },
        {
          name: "generate_melody",
          description: "Generate a melodic pattern. Auto-plays on d6.",
          inputSchema: {
            type: "object",
            properties: {
              scale: {
                type: "string",
                enum: ["major", "minor", "pentatonic", "blues", "dorian", "harmonic_minor", "lydian", "mixolydian", "phrygian", "chromatic"],
                description: "Musical scale to use",
              },
              length: {
                type: "number",
                minimum: 4,
                maximum: 16,
                description: "Number of notes (default: 8)",
              },
            },
            required: ["scale"],
          },
        },
        {
          name: "generate_pattern",
          description: "Generate a complete multi-channel pattern (drums, hats, bass). Auto-plays on d1, d2, d4.",
          inputSchema: {
            type: "object",
            properties: {
              style: {
                type: "string",
                enum: ["techno", "house", "dnb", "ambient", "trap", "jungle", "jazz"],
                description: "Genre/style of the complete pattern",
              },
            },
            required: ["style"],
          },
        },
        {
          name: "generate_variation",
          description: "Create a variation of an existing pattern on a channel.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                enum: ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"],
                description: "The channel to apply variation to",
              },
              intensity: {
                type: "string",
                enum: ["subtle", "moderate", "extreme", "glitch"],
                description: "How much to vary the pattern",
              },
            },
            required: ["channel", "intensity"],
          },
        },
        // =========================================================================
        // NEW MUSIC THEORY TOOLS
        // =========================================================================
        {
          name: "generate_euclidean",
          description: "Generate a euclidean rhythm pattern. Distributes hits evenly across steps. Auto-plays on d3.",
          inputSchema: {
            type: "object",
            properties: {
              hits: {
                type: "number",
                minimum: 1,
                maximum: 16,
                description: "Number of hits to distribute",
              },
              steps: {
                type: "number",
                minimum: 2,
                maximum: 16,
                description: "Number of steps in the pattern",
              },
              sound: {
                type: "string",
                description: "Sound to use (bd, sd, hh, cp). Default: bd",
              },
            },
            required: ["hits", "steps"],
          },
        },
        {
          name: "generate_scale",
          description: "Generate and play a musical scale pattern. Educational tool to hear scale notes. Auto-plays on d6.",
          inputSchema: {
            type: "object",
            properties: {
              root: {
                type: "string",
                description: "Root note (e.g., c, d, f#)",
              },
              scale: {
                type: "string",
                enum: ["major", "minor", "pentatonic", "blues", "dorian", "harmonic_minor", "lydian", "mixolydian", "phrygian", "chromatic"],
                description: "Scale type",
              },
            },
            required: ["root", "scale"],
          },
        },
        {
          name: "generate_chord_progression",
          description: "Generate a chord progression pattern. Auto-plays on d5.",
          inputSchema: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description: "Key/scale for progression (e.g., major, minor)",
              },
              style: {
                type: "string",
                enum: ["pop", "jazz", "blues", "minor", "rock", "classical", "edm", "ballad"],
                description: "Progression style",
              },
            },
            required: ["key"],
          },
        },
        {
          name: "generate_fill",
          description: "Generate a drum fill pattern. Use for transitions. Auto-plays on d1.",
          inputSchema: {
            type: "object",
            properties: {
              style: {
                type: "string",
                enum: ["standard", "snare_roll", "tom_fill", "breakdown"],
                description: "Fill style",
              },
            },
          },
        },
        {
          name: "add_effect",
          description: "Apply an audio effect to a channel's current pattern.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                enum: ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"],
                description: "The channel to apply effect to",
              },
              effect: {
                type: "string",
                enum: ["reverb", "delay", "lpf", "hpf", "distortion", "pan"],
                description: "Effect to apply",
              },
              amount: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description: "Effect intensity (0-1)",
              },
            },
            required: ["channel", "effect"],
          },
        },
        {
          name: "transpose",
          description: "Transpose a channel's pattern by semitones.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                enum: ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"],
                description: "The channel to transpose",
              },
              semitones: {
                type: "number",
                minimum: -12,
                maximum: 12,
                description: "Semitones to transpose (-12 to 12)",
              },
            },
            required: ["channel", "semitones"],
          },
        },
        {
          name: "humanize",
          description: "Add subtle timing variation to make pattern sound more human.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                enum: ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"],
                description: "The channel to humanize",
              },
              amount: {
                type: "number",
                minimum: 0.01,
                maximum: 0.1,
                description: "Humanization amount (0.01-0.1)",
              },
            },
            required: ["channel"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Log all incoming tool calls
      console.error(`[TOOL CALL] ${name}`);
      console.error(`[TOOL ARGS] ${JSON.stringify(args, null, 2)}`);

      try {
        if (!args) {
          throw new Error("Missing arguments");
        }

        switch (name) {
          case "tidal_eval": {
            const result = await this.evalPattern(args.channel as string, args.pattern as string);
            console.error(`[TOOL RESULT] tidal_eval: Success`);
            return result;
          }

          case "tidal_hush": {
            const result = await this.hush();
            console.error(`[TOOL RESULT] tidal_hush: Success`);
            return result;
          }

          case "tidal_silence": {
            const result = await this.silence(args.channel as string);
            console.error(`[TOOL RESULT] tidal_silence: Success`);
            return result;
          }

          case "tidal_get_state": {
            const result = await this.getState();
            console.error(`[TOOL RESULT] tidal_get_state: Success`);
            return result;
          }

          case "tidal_solo": {
            const result = await this.solo(args.channel as string);
            console.error(`[TOOL RESULT] tidal_solo: Success`);
            return result;
          }

          case "tidal_unsolo": {
            const result = await this.unsolo();
            console.error(`[TOOL RESULT] tidal_unsolo: Success`);
            return result;
          }

          case "tidal_get_history": {
            const result = await this.getHistory(args.limit as number | undefined);
            console.error(`[TOOL RESULT] tidal_get_history: Success`);
            return result;
          }

          case "tidal_set_tempo": {
            const result = await this.setTempo(args.bpm as number);
            console.error(`[TOOL RESULT] tidal_set_tempo: Success`);
            return result;
          }

          case "generate_drums": {
            const result = await this.generateDrumsHandler(
              args.style as string,
              args.complexity as number | undefined
            );
            console.error(`[TOOL RESULT] generate_drums: Success`);
            return result;
          }

          case "generate_bassline": {
            const result = await this.generateBasslineHandler(args.style as string);
            console.error(`[TOOL RESULT] generate_bassline: Success`);
            return result;
          }

          case "generate_melody": {
            const result = await this.generateMelodyHandler(
              args.scale as string,
              args.length as number | undefined
            );
            console.error(`[TOOL RESULT] generate_melody: Success`);
            return result;
          }

          case "generate_pattern": {
            const result = await this.generatePatternHandler(args.style as string);
            console.error(`[TOOL RESULT] generate_pattern: Success`);
            return result;
          }

          case "generate_variation": {
            const result = await this.generateVariationHandler(
              args.channel as string,
              args.intensity as string
            );
            console.error(`[TOOL RESULT] generate_variation: Success`);
            return result;
          }

          // =========================================================================
          // NEW MUSIC THEORY TOOL HANDLERS
          // =========================================================================

          case "generate_euclidean": {
            const result = await this.generateEuclideanHandler(
              args.hits as number,
              args.steps as number,
              args.sound as string | undefined
            );
            console.error(`[TOOL RESULT] generate_euclidean: Success`);
            return result;
          }

          case "generate_scale": {
            const result = await this.generateScaleHandler(
              args.root as string,
              args.scale as string
            );
            console.error(`[TOOL RESULT] generate_scale: Success`);
            return result;
          }

          case "generate_chord_progression": {
            const result = await this.generateChordProgressionHandler(
              args.key as string,
              args.style as string | undefined
            );
            console.error(`[TOOL RESULT] generate_chord_progression: Success`);
            return result;
          }

          case "generate_fill": {
            const result = await this.generateFillHandler(
              args.style as string | undefined
            );
            console.error(`[TOOL RESULT] generate_fill: Success`);
            return result;
          }

          case "add_effect": {
            const result = await this.addEffectHandler(
              args.channel as string,
              args.effect as string,
              args.amount as number | undefined
            );
            console.error(`[TOOL RESULT] add_effect: Success`);
            return result;
          }

          case "transpose": {
            const result = await this.transposeHandler(
              args.channel as string,
              args.semitones as number
            );
            console.error(`[TOOL RESULT] transpose: Success`);
            return result;
          }

          case "humanize": {
            const result = await this.humanizeHandler(
              args.channel as string,
              args.amount as number | undefined
            );
            console.error(`[TOOL RESULT] humanize: Success`);
            return result;
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[TOOL ERROR] ${name}: ${errorMessage}`);
        console.error(`[TOOL ERROR] Stack:`, error instanceof Error ? error.stack : 'No stack trace');
        return {
          content: [
            {
              type: "text",
              text: `Error: ${errorMessage}`,
            },
          ],
        };
      }
    });
  }

  private async evalPattern(channel: string, pattern: string) {
    const fullPattern = `${channel} $ ${pattern}`;

    console.error(`[EVAL PATTERN] Channel: ${channel}`);
    console.error(`[EVAL PATTERN] Pattern: ${pattern}`);
    console.error(`[EVAL PATTERN] Full: ${fullPattern}`);

    // Log the pattern evaluation
    await this.logPatternEvaluation(`Evaluate pattern on ${channel}`, channel, pattern);

    // Update state
    this.channels.set(channel, {
      channel,
      pattern,
      timestamp: Date.now(),
      active: true,
    });

    // Add to history
    this.patternHistory.push({
      channel,
      pattern,
      timestamp: Date.now(),
    });

    // Broadcast to WebSocket clients if using WebSocket transport
    if (this.wsTransport) {
      this.wsTransport.broadcast({
        type: 'pattern_update',
        channel,
        pattern,
        fullPattern,
        timestamp: Date.now()
      });
    }

    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci(fullPattern);
    } else {
      await this.writeToTidalFile(fullPattern);
    }

    return {
      content: [
        {
          type: "text",
          text: `✓ Evaluated on ${channel}:\n${fullPattern}\n\nPattern is now playing.`,
        },
      ],
    };
  }

  private async hush() {
    console.error(`[HUSH] Stopping all patterns`);
    // Log the action
    await this.logAction("HUSH", "Stopped all patterns");

    // Clear all channel states
    for (const [channel, state] of this.channels.entries()) {
      state.active = false;
      state.pattern = "";
    }

    // Broadcast to WebSocket clients
    if (this.wsTransport) {
      this.wsTransport.broadcast({
        type: 'hush',
        timestamp: Date.now()
      });
    }

    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci("hush");
    } else {
      await this.writeToTidalFile("hush");
    }

    return {
      content: [
        {
          type: "text",
          text: "✓ All patterns stopped (hushed).",
        },
      ],
    };
  }

  private async silence(channel: string) {
    // Log the action
    await this.logAction("SILENCE", `Silenced channel ${channel}`);

    const state = this.channels.get(channel);
    if (state) {
      state.active = false;
      state.pattern = "";
    }

    // Correct Tidal syntax: d1 $ silence or just assign silence to the channel
    const silenceCommand = `${channel} $ silence`;
    
    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci(silenceCommand);
    } else {
      await this.writeToTidalFile(silenceCommand);
    }

    return {
      content: [
        {
          type: "text",
          text: `✓ Silenced ${channel}.`,
        },
      ],
    };
  }

  private async getState() {
    const activeChannels = Array.from(this.channels.values())
      .filter((c) => c.active)
      .map((c) => {
        const elapsed = Math.floor((Date.now() - c.timestamp) / 1000);
        return `  ${c.channel}: ${c.pattern} (${elapsed}s ago)`;
      });

    const stateText = activeChannels.length > 0
      ? `Active channels:\n${activeChannels.join("\n")}`
      : "No active patterns.";

    return {
      content: [
        {
          type: "text",
          text: stateText,
        },
      ],
    };
  }

  private async solo(channel: string) {
    // Log the action
    await this.logAction("SOLO", `Soloed channel ${channel}`);

    const soloPattern = `solo $ ${channel}`;
    
    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci(soloPattern);
    } else {
      await this.writeToTidalFile(soloPattern);
    }

    return {
      content: [
        {
          type: "text",
          text: `✓ Soloed ${channel}. All other channels are muted.`,
        },
      ],
    };
  }

  private async unsolo() {
    // Log the action
    await this.logAction("UNSOLO", "Restored all channels");

    const unsoloCommand = "unsolo $ d1";
    
    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci(unsoloCommand);
    } else {
      await this.writeToTidalFile(unsoloCommand);
    }

    return {
      content: [
        {
          type: "text",
          text: "✓ Unsolo applied. All channels restored.",
        },
      ],
    };
  }

  private async getHistory(limit: number = 10) {
    const recent = this.patternHistory.slice(-limit).reverse();

    if (recent.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No pattern history yet.",
          },
        ],
      };
    }

    const historyText = recent.map((entry, idx) => {
      const elapsed = Math.floor((Date.now() - entry.timestamp) / 1000);
      return `${limit - idx}. ${entry.channel}: ${entry.pattern} (${elapsed}s ago)`;
    }).join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Recent patterns:\n${historyText}`,
        },
      ],
    };
  }

  private async setTempo(bpm: number) {
    // Validate BPM range
    if (bpm < 20 || bpm > 999) {
      throw new Error(`BPM must be between 20 and 999, got ${bpm}`);
    }

    // Convert BPM to cycles per second: cps = bpm / 60 / 4
    // (assuming 4 beats per cycle, which is standard)
    const cps = bpm / 60 / 4;

    console.error(`[SET TEMPO] BPM: ${bpm}, CPS: ${cps}`);

    // Log the action
    await this.logAction("SET_TEMPO", `Set tempo to ${bpm} BPM (${cps.toFixed(4)} cps)`);

    // Send setcps command directly (no channel prefix!)
    const tempoCommand = `setcps ${cps}`;

    if (this.config.useGhci) {
      await this.sendToGhci(tempoCommand);
    } else {
      await this.writeToTidalFile(tempoCommand);
    }

    return {
      content: [
        {
          type: "text",
          text: `✓ Tempo set to ${bpm} BPM`,
        },
      ],
    };
  }

  // Pattern Generator Handlers

  private async generateDrumsHandler(style: string, complexity: number = 0.5) {
    console.error(`[GENERATE DRUMS] Style: ${style}, Complexity: ${complexity}`);

    const result = this.patternGenerator.generateDrums(style, complexity);
    await this.logAction("GENERATE_DRUMS", `Generated ${style} drums (complexity: ${complexity}) on ${result.channel}`);

    // Evaluate the generated pattern
    return this.evalPattern(result.channel, result.pattern);
  }

  private async generateBasslineHandler(style: string) {
    console.error(`[GENERATE BASSLINE] Style: ${style}`);

    const result = this.patternGenerator.generateBassline(style);
    await this.logAction("GENERATE_BASSLINE", `Generated ${style} bassline on ${result.channel}`);

    // Evaluate the generated pattern
    return this.evalPattern(result.channel, result.pattern);
  }

  private async generateMelodyHandler(scale: string, length: number = 8) {
    console.error(`[GENERATE MELODY] Scale: ${scale}, Length: ${length}`);

    const result = this.patternGenerator.generateMelody(scale, length);
    await this.logAction("GENERATE_MELODY", `Generated ${scale} melody (${length} notes) on ${result.channel}`);

    // Evaluate the generated pattern
    return this.evalPattern(result.channel, result.pattern);
  }

  private async generatePatternHandler(style: string) {
    console.error(`[GENERATE PATTERN] Style: ${style}`);

    const results = this.patternGenerator.generateComplete(style);
    await this.logAction("GENERATE_PATTERN", `Generated complete ${style} pattern on ${results.map(r => r.channel).join(', ')}`);

    // Evaluate all generated patterns
    const outputs: string[] = [];
    for (const result of results) {
      await this.evalPattern(result.channel, result.pattern);
      outputs.push(`${result.channel}: ${result.pattern}`);
    }

    return {
      content: [
        {
          type: "text",
          text: `✓ Generated ${style} pattern:\n${outputs.join('\n')}`,
        },
      ],
    };
  }

  private async generateVariationHandler(channel: string, intensity: string) {
    console.error(`[GENERATE VARIATION] Channel: ${channel}, Intensity: ${intensity}`);

    // Get current pattern for the channel
    const currentState = this.channels.get(channel);
    if (!currentState || !currentState.active || !currentState.pattern) {
      throw new Error(`No active pattern on ${channel} to vary. Play something first!`);
    }

    const variedPattern = this.patternGenerator.generateVariation(currentState.pattern, intensity);
    await this.logAction("GENERATE_VARIATION", `Applied ${intensity} variation to ${channel}`);

    // Evaluate the varied pattern
    return this.evalPattern(channel, variedPattern);
  }

  // =========================================================================
  // NEW MUSIC THEORY TOOL HANDLERS
  // =========================================================================

  private async generateEuclideanHandler(hits: number, steps: number, sound?: string) {
    console.error(`[GENERATE EUCLIDEAN] Hits: ${hits}, Steps: ${steps}, Sound: ${sound || 'bd'}`);

    const result = this.patternGenerator.generateEuclidean(hits, steps, sound || 'bd');
    await this.logAction("GENERATE_EUCLIDEAN", `Generated euclidean e(${hits},${steps}) with ${sound || 'bd'} on ${result.channel}`);

    // Evaluate the generated pattern
    return this.evalPattern(result.channel, result.pattern);
  }

  private async generateScaleHandler(root: string, scale: string) {
    console.error(`[GENERATE SCALE] Root: ${root}, Scale: ${scale}`);

    const result = this.patternGenerator.generateScale(root, scale);
    await this.logAction("GENERATE_SCALE", `Generated ${root} ${scale} scale on ${result.channel}`);

    // Evaluate the generated pattern
    return this.evalPattern(result.channel, result.pattern);
  }

  private async generateChordProgressionHandler(key: string, style?: string) {
    console.error(`[GENERATE CHORD PROGRESSION] Key: ${key}, Style: ${style || 'pop'}`);

    const result = this.patternGenerator.generateChordProgression(key, style || 'pop');
    await this.logAction("GENERATE_CHORD_PROGRESSION", `Generated ${style || 'pop'} progression in ${key} on ${result.channel}`);

    // Evaluate the generated pattern
    return this.evalPattern(result.channel, result.pattern);
  }

  private async generateFillHandler(style?: string) {
    console.error(`[GENERATE FILL] Style: ${style || 'standard'}`);

    const result = this.patternGenerator.generateFill(style || 'standard');
    await this.logAction("GENERATE_FILL", `Generated ${style || 'standard'} fill on ${result.channel}`);

    // Evaluate the generated pattern
    return this.evalPattern(result.channel, result.pattern);
  }

  private async addEffectHandler(channel: string, effect: string, amount?: number) {
    console.error(`[ADD EFFECT] Channel: ${channel}, Effect: ${effect}, Amount: ${amount || 0.5}`);

    // Get current pattern for the channel
    const currentState = this.channels.get(channel);
    if (!currentState || !currentState.active || !currentState.pattern) {
      throw new Error(`No active pattern on ${channel} to apply effect to. Play something first!`);
    }

    const newPattern = this.patternGenerator.applyEffect(currentState.pattern, effect, { amount: amount || 0.5 });
    await this.logAction("ADD_EFFECT", `Applied ${effect} (amount: ${amount || 0.5}) to ${channel}`);

    // Evaluate the modified pattern
    return this.evalPattern(channel, newPattern);
  }

  private async transposeHandler(channel: string, semitones: number) {
    console.error(`[TRANSPOSE] Channel: ${channel}, Semitones: ${semitones}`);

    // Get current pattern for the channel
    const currentState = this.channels.get(channel);
    if (!currentState || !currentState.active || !currentState.pattern) {
      throw new Error(`No active pattern on ${channel} to transpose. Play something first!`);
    }

    const newPattern = this.patternGenerator.transpose(currentState.pattern, semitones);
    await this.logAction("TRANSPOSE", `Transposed ${channel} by ${semitones} semitones`);

    // Evaluate the modified pattern
    return this.evalPattern(channel, newPattern);
  }

  private async humanizeHandler(channel: string, amount?: number) {
    console.error(`[HUMANIZE] Channel: ${channel}, Amount: ${amount || 0.02}`);

    // Get current pattern for the channel
    const currentState = this.channels.get(channel);
    if (!currentState || !currentState.active || !currentState.pattern) {
      throw new Error(`No active pattern on ${channel} to humanize. Play something first!`);
    }

    const newPattern = this.patternGenerator.humanize(currentState.pattern, amount || 0.02);
    await this.logAction("HUMANIZE", `Humanized ${channel} (amount: ${amount || 0.02})`);

    // Evaluate the modified pattern
    return this.evalPattern(channel, newPattern);
  }

  private async writeToTidalFile(code: string) {
    console.error(`[WRITE TO FILE] Writing to ${this.config.tidalFile}`);
    console.error(`[WRITE TO FILE] Code: ${code}`);
    const content = `-- TidalCycles MCP Server\n-- Auto-generated at ${new Date().toISOString()}\n\n${code}\n`;
    await fs.writeFile(this.config.tidalFile, content, "utf-8");
    console.error(`[WRITE TO FILE] Successfully written`);
  }

  private async startGhci() {
    if (this.ghciProcess && this.ghciStreamAlive) {
      console.error("[GHCI] Already running and alive");
      return; // Already running
    }

    // Kill old process if it exists
    if (this.ghciProcess) {
      console.error("[GHCI] Cleaning up old process");
      this.ghciProcess.kill();
      this.ghciProcess = undefined;
    }

    const bootTidalPath = this.config.bootTidalPath || "BootTidal.hs";
    const ghciPath = process.env.GHCI_PATH || "ghci";

    console.error(`[GHCI] Starting GHCi with boot script: ${bootTidalPath}`);

    this.ghciProcess = spawn(ghciPath, ["-ghci-script", bootTidalPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Mark stream as alive initially
    this.ghciStreamAlive = true;

    // Handle spawn errors
    this.ghciProcess.on('error', (err) => {
      console.error(`[GHCI ERROR] Failed to start: ${err.message}`);
      console.error('[GHCI ERROR] Make sure ghci is in PATH or set GHCI_PATH environment variable');
      this.ghciStreamAlive = false;
      throw err;
    });

    // Handle process exit
    this.ghciProcess.on('exit', (code, signal) => {
      console.error(`[GHCI] Process exited with code ${code}, signal ${signal}`);
      this.ghciStreamAlive = false;
      this.ghciProcess = undefined;
    });

    // Handle stdin errors (this is the "stream destroyed" error)
    this.ghciProcess.stdin?.on('error', (err) => {
      console.error(`[GHCI STDIN ERROR] ${err.message}`);
      this.ghciStreamAlive = false;
    });

    // Handle stdin close
    this.ghciProcess.stdin?.on('close', () => {
      console.error('[GHCI] stdin stream closed');
      this.ghciStreamAlive = false;
    });

    // Wait for TidalCycles to initialize
    await new Promise<void>((resolve) => {
      const checkInit = (data: Buffer) => {
        const output = data.toString();
        console.error('[GHCI OUTPUT]', output);
        if (output.includes("Connected to SuperDirt") || output.includes("tidal>")) {
          this.ghciProcess?.stdout?.off("data", checkInit);
          console.error('[GHCI] ✓ Successfully initialized and connected to SuperDirt');
          resolve();
        }
      };
      this.ghciProcess?.stdout?.on("data", checkInit);

      // Timeout after 10 seconds
      setTimeout(() => {
        console.error('[GHCI] Initialization timeout reached');
        resolve();
      }, 10000);
    });

    console.error("[GHCI] GHCi/TidalCycles started and ready");
  }

  private async sendToGhci(code: string) {
    // Check if stream is alive, reconnect if needed
    if (!this.isGhciHealthy()) {
      console.error('[GHCI] Stream not alive, attempting reconnection...');
      
      // Prevent multiple simultaneous reconnection attempts
      if (this.isReconnecting) {
        throw new Error("GHCi is currently reconnecting, please try again in a moment");
      }

      this.isReconnecting = true;
      try {
        await this.startGhci();
        console.error('[GHCI] ✓ Reconnection successful');
      } catch (error) {
        this.isReconnecting = false;
        throw new Error(`Failed to reconnect to GHCi: ${error}`);
      }
      this.isReconnecting = false;
    }

    console.error(`[GHCI SEND] ${code}`);

    return new Promise<void>((resolve, reject) => {
      if (!this.ghciProcess?.stdin) {
        reject(new Error("GHCi stdin not available after reconnection"));
        return;
      }

      this.ghciProcess.stdin.write(code + "\n", (err) => {
        if (err) {
          console.error(`[GHCI SEND ERROR] ${err.message}`);
          this.ghciStreamAlive = false; // Mark as dead on write error
          reject(err);
        } else {
          console.error('[GHCI SEND] ✓ Successfully sent');
          resolve();
        }
      });
    });
  }

  /**
   * Check if GHCi connection is healthy
   */
  private isGhciHealthy(): boolean {
    return this.ghciStreamAlive && 
           !!this.ghciProcess && 
           !!this.ghciProcess.stdin && 
           !this.ghciProcess.stdin.destroyed &&
           !this.ghciProcess.killed;
  }

  private async cleanup() {
    console.error('[CLEANUP] Shutting down server...');
    
    if (this.ghciProcess) {
      console.error('[CLEANUP] Stopping GHCi process...');
      
      // Close stdin gracefully first
      if (this.ghciProcess.stdin && !this.ghciProcess.stdin.destroyed) {
        this.ghciProcess.stdin.end();
      }
      
      // Then kill the process
      this.ghciProcess.kill();
      this.ghciStreamAlive = false;
      console.error('[CLEANUP] GHCi process stopped');
    }
    
    await this.server.close();
    console.error('[CLEANUP] Server closed');
  }

  async run() {
    // Start GHCi if using direct mode
    if (this.config.useGhci) {
      await this.startGhci();
    }

    // Initialize log file with header
    const logHeader = `TidalCycles MCP Server - Session Log
Started: ${new Date().toISOString()}
Mode: ${this.config.useGhci ? 'Direct GHCi' : 'File-based'}
Transport: ${this.config.transport}
Log File: ${this.logFile}
================================================================================

`;

    try {
      await fs.writeFile(this.logFile, logHeader, 'utf-8');
      console.error(`Session log: ${this.logFile}`);
    } catch (error) {
      console.error(`Failed to create log file: ${error}`);
    }

    // Choose transport based on configuration
    if (this.config.transport === 'websocket') {
      const port = this.config.websocketPort || 8080;
      const host = this.config.websocketHost || 'localhost';

      this.wsTransport = new WebSocketServerTransport({ port, host });
      await this.server.connect(this.wsTransport);

      console.error(`TidalCycles MCP Server running on WebSocket ws://${host}:${port}`);
      console.error(`Mode: ${this.config.useGhci ? 'Direct GHCi' : 'File-based'}`);
      console.error(`Clients can connect to: ws://${host}:${port}`);
    } else {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error("TidalCycles MCP Server running on stdio");
      console.error(`Mode: ${this.config.useGhci ? 'Direct GHCi' : 'File-based'}`);
    }
  }
}

// Main execution
const tidalFile = process.env.TIDAL_FILE || path.join(process.cwd(), "tidal-mcp-output.tidal");
const useGhci = process.env.TIDAL_USE_GHCI === "true" || process.env.TIDAL_USE_GHCI === "1";
const bootTidalPath = process.env.TIDAL_BOOT_PATH;
const logFile = process.env.TIDAL_LOG_FILE; // Optional: custom log file path

// Transport configuration
const transport = (process.env.TIDAL_TRANSPORT as 'stdio' | 'websocket') || 'stdio';
const websocketPort = process.env.TIDAL_WS_PORT ? parseInt(process.env.TIDAL_WS_PORT) : 8080;
const websocketHost = process.env.TIDAL_WS_HOST || 'localhost';

const config: TidalConfig = {
  tidalFile,
  bootTidalPath,
  useGhci,
  logFile,
  transport,
  websocketPort,
  websocketHost,
};

const server = new TidalMCPServer(config);
server.run().catch(console.error);
