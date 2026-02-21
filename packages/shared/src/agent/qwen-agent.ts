/**
 * Qwen Code Backend
 *
 * Agent backend implementation using the Qwen Code CLI.
 * Uses subprocess execution with --prompt and --resume flags for each message.
 */

import type { AgentEvent } from '@craft-agent/core/types';
import type { FileAttachment } from '../utils/files.ts';
import type { ThinkingLevel } from './thinking-levels.ts';
import type { AuthRequest } from '@craft-agent/session-tools-core';
import { type PermissionMode } from './mode-manager.ts';
import type { LoadedSource } from '../sources/types.ts';

import type {
  BackendConfig,
  ChatOptions,
  SdkMcpServerConfig,
} from './backend/types.ts';
import { AbortReason } from './backend/types.ts';

// Qwen models are managed by Qwen CLI configuration (~/.qwen/settings.json)

// LLM tool types and helpers for call_llm PreToolUse intercept
import { type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';

// BaseAgent provides common functionality
import { BaseAgent } from './base-agent.ts';

// Credential manager for stored tokens
import { getCredentialManager } from '../credentials/index.ts';

// Error parsing for typed errors
import { type AgentError } from './errors.ts';

// Debug logging
import { debug } from '../utils/debug.ts';

// Path utilities
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';

// No default model — Qwen CLI uses its own configuration from ~/.qwen/settings.json

// Qwen CLI event types
interface QwenEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
    }>;
  };
  result?: string;
  is_error?: boolean;
  error?: {
    message: string;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// Generate a unique turn ID for each assistant response
function generateTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Backend implementation using the Qwen Code CLI.
 * Uses subprocess execution for each message exchange.
 */
export class QwenAgent extends BaseAgent {
  private _isProcessing = false;
  private abortReason?: AbortReason;
  private qwenThreadId: string | null = null;
  private currentAbortController: AbortController | null = null;

  // Callbacks
  onQwenAuthRequired: ((reason: string) => void) | null = null;
  onPlanSubmitted: ((planPath: string) => void) | null = null;
  onAuthRequest: ((request: AuthRequest) => void) | null = null;

  constructor(config: BackendConfig) {
    // Qwen CLI uses 'coder-model' or 'vision-model' as model identifiers
    // Convert from prefixed format (qwen/coder-model) to Qwen CLI format
    const defaultModel = config.model ? QwenAgent.convertToQwenModelId(config.model) : 'coder-model';
    const modelDef = { contextWindow: 256000 }; // Qwen default context window
    super(config, defaultModel, modelDef.contextWindow);
    this.qwenThreadId = config.session?.sdkSessionId || null;
    this.debug(`Qwen backend initialized with model: ${defaultModel}${this.qwenThreadId ? ` (will resume thread ${this.qwenThreadId})` : ''}`);
  }

  /**
   * Convert model ID from registry format (qwen/coder-model) to Qwen CLI format (coder-model)
   */
  private static convertToQwenModelId(modelId: string): string {
    // Handle both prefixed and non-prefixed model IDs
    if (modelId.startsWith('qwen/')) {
      return modelId.replace('qwen/', '');
    }
    // Already in Qwen CLI format
    return modelId;
  }

  protected override debug(message: string): void {
    this.onDebug?.(`[Qwen] ${message}`);
  }

  /**
   * Execute Qwen CLI with given prompt and return parsed events.
   */
  private async executeQwen(prompt: string, attachments?: FileAttachment[]): Promise<QwenEvent[]> {
    const events: QwenEvent[] = [];
    const args: string[] = ['--output-format', 'stream-json'];

    // Add auth type
    if (this.config.authType === 'oauth') {
      args.push('--auth-type', 'qwen-oauth');
    } else if (this.config.authType === 'api_key') {
      args.push('--auth-type', 'openai');
    }

    // Add session handling
    if (this.qwenThreadId) {
      args.push('--resume', this.qwenThreadId);
    }

    // Add model if specified
    if (this._model) {
      args.push('--model', this._model);
    }

    // Add permission mode
    const permissionMode = this.permissionManager.getPermissionMode();
    if (permissionMode === 'allow-all') {
      args.push('-y'); // YOLO mode
    } else if (permissionMode === 'safe') {
      args.push('--approval-mode', 'plan');
    }

    // Add prompt
    args.push('--prompt', prompt);

    // Handle attachments by including them in the prompt
    let fullPrompt = prompt;
    if (attachments && attachments.length > 0) {
      const attachmentContent = attachments.map(a => {
        if (a.text) {
          return `\n\n[File: ${a.name}]\n${a.text}`;
        }
        return `\n\n[File: ${a.name}]`;
      }).join('');
      fullPrompt += attachmentContent;
      // Update the last argument (prompt) with full content
      args[args.length - 1] = fullPrompt;
    }

    this.debug(`Executing: qwen ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      this.currentAbortController = new AbortController();
      
      const qwenProcess = spawn('qwen', args, {
        cwd: this.workingDirectory,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let buffer = '';

      qwenProcess.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i]?.trim();
          if (!line) continue;
          
          try {
            const event = JSON.parse(line) as QwenEvent;
            events.push(event);
            
            // Capture session ID from first event
            if (event.session_id && !this.qwenThreadId) {
              this.qwenThreadId = event.session_id;
              this.debug(`Session ID captured: ${this.qwenThreadId}`);
              this.config.onSdkSessionIdUpdate?.(this.qwenThreadId);
            }
          } catch {
            this.debug(`Failed to parse: ${line.substring(0, 100)}`);
          }
        }
        
        buffer = lines[lines.length - 1] || '';
      });

      qwenProcess.stderr?.on('data', (data: Buffer) => {
        const stderr = data.toString().trim();
        if (stderr && !stderr.includes('warning') && !stderr.includes('Warning')) {
          this.debug(`stderr: ${stderr}`);
        }
      });

      qwenProcess.on('error', (err) => {
        this.currentAbortController = null;
        reject(err);
      });

      qwenProcess.on('exit', (code) => {
        this.currentAbortController = null;
        
        if (code !== 0 && code !== null) {
          // Check if it's an auth error
          const errorOutput = events.find(e => e.type === 'error' || e.is_error);
          const errorMsg = errorOutput?.error?.message;
          if (errorMsg && (errorMsg.toLowerCase().includes('auth') ||
              errorMsg.toLowerCase().includes('login'))) {
            reject(new Error('Authentication required. Please check your Qwen credentials.'));
            return;
          }
          
          if (this.abortReason === AbortReason.UserStop) {
            resolve(events);
            return;
          }
          
          reject(new Error(`Qwen CLI exited with code ${code}`));
          return;
        }
        
        resolve(events);
      });

      // Handle abort
      this.currentAbortController.signal.addEventListener('abort', () => {
        qwenProcess.kill('SIGTERM');
      });
    });
  }

  /**
   * Main chat method.
   */
  async *chat(
    message: string,
    attachments?: FileAttachment[],
    _options?: ChatOptions
  ): AsyncGenerator<AgentEvent> {
    this._isProcessing = true;
    this.abortReason = undefined;

    try {
      this.debug(`Starting chat with message: ${message.substring(0, 50)}...`);
      
      // Generate a unique turn ID for this assistant response
      const turnId = generateTurnId();
      this.debug(`Generated turnId: ${turnId}`);

      // Execute Qwen CLI
      const events = await this.executeQwen(message, attachments);

      // Check for auth errors
      const authError = events.find(e => 
        e.error?.message?.toLowerCase().includes('auth') ||
        e.error?.message?.toLowerCase().includes('login') ||
        e.error?.message?.toLowerCase().includes('not logged in')
      );
      
      if (authError) {
        yield {
          type: 'typed_error',
          error: {
            code: 'invalid_credentials',
            title: 'Authentication Required',
            message: 'You need to authenticate with Qwen. Please run Qwen OAuth setup.',
            canRetry: true,
            actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
            originalError: authError.error?.message,
          }
        };
        yield { type: 'complete' };
        return;
      }

      // Process events
      let hasOutput = false;
      let accumulatedText = '';
      
      for (const event of events) {
        // Handle system init
        if (event.type === 'system' && event.subtype === 'init') {
          this.debug(`System init: session=${event.session_id}`);
          continue;
        }

        // Handle assistant messages
        if (event.type === 'assistant' && event.message?.content) {
          for (const content of event.message.content) {
            if (content.type === 'thinking') {
              // Optionally yield thinking content
              this.debug(`Thinking: ${content.thinking?.substring(0, 100)}...`);
            } else if (content.type === 'text' && content.text) {
              // For streaming-like behavior, yield text deltas
              const text = content.text;
              if (text && text !== accumulatedText) {
                const delta = text.substring(accumulatedText.length);
                accumulatedText = text;
                
                yield {
                  type: 'text_delta',
                  text: delta,
                  turnId,
                };
                hasOutput = true;
              }
            }
          }
        }

        // Handle tool calls (if present in output)
        if (event.type === 'tool') {
          this.debug(`Tool call: ${JSON.stringify(event)}`);
          // Qwen CLI handles tools internally, but we could expose them here if needed
        }

        // Handle result
        if (event.type === 'result') {
          this.debug(`Result: ${event.result}`);
          
          // Yield token usage if available
          if (event.usage) {
            yield {
              type: 'usage_update',
              usage: {
                inputTokens: event.usage.input_tokens,
                contextWindow: 128000, // Qwen3 Coder context window
              },
            };
          }
        }

        // Handle errors
        if (event.type === 'error' || event.is_error) {
          const errorMsg = event.error?.message || 'Unknown error';
          this.debug(`Error: ${errorMsg}`);
          yield {
            type: 'error',
            message: errorMsg,
          };
        }
      }

      // If no output was generated, yield an error
      if (!hasOutput && !events.some(e => e.type === 'error' || e.is_error)) {
        this.debug('No output generated');
      }

      // Yield text_complete to mark the end of the assistant message
      if (accumulatedText) {
        yield {
          type: 'text_complete',
          text: accumulatedText,
          turnId,
        };
      }

      yield { type: 'complete' };

    } catch (error) {
      this.debug(`Chat error: ${error instanceof Error ? error.message : String(error)}`);
      
      if (this.abortReason === AbortReason.UserStop ||
          this.abortReason === AbortReason.PlanSubmitted ||
          this.abortReason === AbortReason.AuthRequest) {
        yield { type: 'complete' };
        return;
      }

      const errorMsg = error instanceof Error ? error.message : String(error);
      
      // Check for specific error types
      if (errorMsg.toLowerCase().includes('auth') || 
          errorMsg.toLowerCase().includes('login')) {
        yield {
          type: 'typed_error',
          error: {
            code: 'invalid_credentials',
            title: 'Authentication Required',
            message: 'You need to authenticate with Qwen. Please check your credentials.',
            canRetry: true,
            actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
            originalError: errorMsg,
          }
        };
      } else {
        yield {
          type: 'error',
          message: errorMsg,
        };
      }
      
      yield { type: 'complete' };
    } finally {
      this._isProcessing = false;
      this.currentAbortController = null;
    }
  }

  /**
   * Abort current query.
   */
  async abort(_reason?: string): Promise<void> {
    this.debug('Abort requested');
    this.currentAbortController?.abort();
  }

  /**
   * Force abort with specific reason.
   */
  forceAbort(reason: AbortReason): void {
    this.debug(`Force abort: ${reason}`);
    this.abortReason = reason;
    this.currentAbortController?.abort();
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.debug('Destroying Qwen agent');
    this.currentAbortController?.abort();
  }

  /**
   * Check if currently processing.
   */
  isProcessing(): boolean {
    return this._isProcessing;
  }

  /**
   * Get current model ID.
   */
  getModel(): string {
    return this._model;
  }

  /**
   * Set model.
   * Accepts both registry format (qwen/coder-model) and Qwen CLI format (coder-model)
   */
  setModel(model: string): void {
    this._model = QwenAgent.convertToQwenModelId(model);
  }

  // ============================================================
  // Authentication Management
  // ============================================================

  /**
   * Inject Qwen OAuth tokens.
   * Note: With subprocess model, tokens are read from ~/.qwen/oauth_creds.json automatically.
   */
  async injectQwenTokens(tokens: { accessToken: string; refreshToken?: string; expiresAt?: number; tokenType?: string }): Promise<void> {
    // Store tokens in credential manager for persistence
    const credentialManager = getCredentialManager();
    await credentialManager.setLlmOAuth(this.credentialSlug, {
      accessToken: tokens.accessToken,
      idToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || '',
      expiresAt: tokens.expiresAt,
    });
    
    this.debug('Qwen tokens stored');
  }

  /**
   * Check if we have valid Qwen credentials stored.
   */
  async tryInjectStoredQwenTokens(): Promise<boolean> {
    try {
      const credentialManager = getCredentialManager();
      const storedCreds = await credentialManager.getLlmOAuth(this.credentialSlug);

      if (!storedCreds?.accessToken) {
        return false;
      }

      // Check if expired (with 5-minute buffer)
      if (storedCreds.expiresAt && Date.now() > storedCreds.expiresAt - 5 * 60 * 1000) {
        this.debug('Stored Qwen tokens expired');
        return false;
      }

      this.debug('Stored Qwen tokens found');
      return true;
    } catch (error) {
      this.debug(`Failed to check stored tokens: ${error}`);
      return false;
    }
  }

  /**
   * Inject API key.
   */
  async injectApiKey(apiKey: string): Promise<void> {
    const credentialManager = getCredentialManager();
    await credentialManager.setLlmApiKey(this.credentialSlug, apiKey);
    this.debug('Qwen API key stored');
  }

  /**
   * Check if we have a stored API key.
   */
  async tryInjectStoredApiKey(): Promise<boolean> {
    try {
      const credentialManager = getCredentialManager();
      const apiKey = await credentialManager.getLlmApiKey(this.credentialSlug);
      return !!apiKey;
    } catch {
      return false;
    }
  }

  private get credentialSlug(): string {
    const slug = this.config.connectionSlug ?? this.config.session?.llmConnection;
    if (!slug) {
      throw new Error('QwenAgent: connectionSlug is required for credential routing');
    }
    return slug;
  }

  // ============================================================
  // Source Management (stub implementations)
  // ============================================================

  setSourceServers(
    _mcpServers: Record<string, SdkMcpServerConfig>,
    _apiServers: Record<string, unknown>,
    _intendedSlugs?: string[]
  ): void {
    // Qwen CLI manages sources internally
    this.debug('setSourceServers called (Qwen manages sources internally)');
  }

  getActiveSourceSlugs(): string[] {
    return [];
  }

  getAllSources(): LoadedSource[] {
    return [];
  }

  setAllSources(_sources: LoadedSource[]): void {
    // Qwen CLI manages sources internally
  }

  // ============================================================
  // Permission Resolution
  // ============================================================

  respondToPermission(_requestId: string, _allowed: boolean, _alwaysAllow?: boolean): void {
    // Qwen CLI handles permissions internally based on --approval-mode
    this.debug('respondToPermission called (handled by Qwen CLI)');
  }

  // ============================================================
  // Abstract Method Implementations
  // ============================================================

  async runMiniCompletion(prompt: string): Promise<string | null> {
    this.debug(`Mini completion: ${prompt.substring(0, 50)}...`);
    
    try {
      const args: string[] = ['--output-format', 'text'];
      
      if (this.config.authType === 'oauth') {
        args.push('--auth-type', 'qwen-oauth');
      }
      
      args.push('--prompt', prompt);

      return new Promise((resolve, reject) => {
        const qwenProcess = spawn('qwen', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';
        let errorOutput = '';

        qwenProcess.stdout?.on('data', (data: Buffer) => {
          output += data.toString();
        });

        qwenProcess.stderr?.on('data', (data: Buffer) => {
          errorOutput += data.toString();
        });

        qwenProcess.on('exit', (code) => {
          if (code !== 0 && code !== null) {
            reject(new Error(`Qwen CLI exited with code ${code}: ${errorOutput}`));
            return;
          }
          resolve(output.trim());
        });
      });
    } catch (error) {
      this.debug(`Mini completion error: ${error}`);
      return null;
    }
  }

  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    this.debug(`LLM query: ${request.prompt.substring(0, 50)}...`);
    
    try {
      const result = await this.runMiniCompletion(request.prompt);
      
      return {
        text: result || 'Failed to get response',
        model: this._model,
        inputTokens: 0,
        outputTokens: 0,
      };
    } catch (error) {
      return {
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        model: this._model,
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }
}

// Backwards compatibility export
export type QwenBackend = QwenAgent;
