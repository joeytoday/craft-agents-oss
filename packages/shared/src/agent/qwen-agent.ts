/**
 * Qwen Code Backend
 *
 * Agent backend implementation using the Qwen Code CLI.
 * This backend spawns `qwen` and communicates via JSON-RPC over stdio.
 *
 * Qwen Code supports:
 * - Qwen OAuth (free tier: 1000 requests/day)
 * - API-KEY authentication (OpenAI-compatible endpoints)
 *
 * Features:
 * - Pre-tool approval (blocking permission requests BEFORE execution)
 * - Thread persistence (resume conversations across app restarts)
 * - Built-in auth handling (OAuth flow)
 * - Skills and SubAgents support
 */

import type { AgentEvent } from '@craft-agent/core/types';
import type { FileAttachment } from '../utils/files.ts';
import type { ThinkingLevel } from './thinking-levels.ts';
import type { AuthRequest } from '@craft-agent/session-tools-core';
import { type PermissionMode, shouldAllowToolInMode } from './mode-manager.ts';
import type { LoadedSource } from '../sources/types.ts';

import type {
  BackendConfig,
  ChatOptions,
  SdkMcpServerConfig,
} from './backend/types.ts';
import { AbortReason } from './backend/types.ts';
import type { Workspace } from '../config/storage.ts';

// Import models from centralized registry
import { DEFAULT_MODEL, getModelById, getModelIdByShortName, getModelProvider, MODEL_REGISTRY, getDefaultSummarizationModel } from '../config/models.ts';

// LLM tool types and helpers for call_llm PreToolUse intercept
import { buildCallLlmRequest, withTimeout, type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';

// BaseAgent provides common functionality
import { BaseAgent } from './base-agent.ts';

// Credential manager for stored tokens
import { getCredentialManager } from '../credentials/index.ts';

// Event adapter
import { QwenEventAdapter } from './backend/qwen/event-adapter.ts';
import { EventQueue } from './backend/event-queue.ts';

// Error parsing for typed errors
import { parseError, type AgentError } from './errors.ts';

// Debug logging
import { debug } from '../utils/debug.ts';

// Session storage for plans folder path
import { getSessionPlansPath } from '../sessions/storage.ts';

// Path utilities for cross-platform normalization
import { join, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

// System prompt for Craft Agent context
import { getSystemPrompt } from '../prompts/system.ts';

// PreToolUse utilities
import {
  expandToolPaths,
  qualifySkillName,
  stripToolMetadata,
  validateConfigWrite,
  BUILT_IN_TOOLS,
} from './core/pre-tool-use.ts';

// ============================================================
// Constants
// ============================================================

/**
 * Default Qwen model - uses the first Qwen model from the registry
 */
const DEFAULT_QWEN_MODEL = getModelIdByShortName('Qwen3 Coder');

/**
 * Map thinking levels to Qwen reasoning effort.
 * Qwen supports: 'low', 'medium', 'high'
 */
const THINKING_TO_EFFORT: Record<ThinkingLevel, 'low' | 'medium' | 'high'> = {
  off: 'low',
  think: 'medium',
  max: 'high',
};

// ============================================================
// QwenAgent Implementation
// ============================================================

/**
 * Backend implementation using the Qwen Code CLI.
 *
 * Extends BaseAgent for common functionality (permission mode, source management,
 * planning heuristics, config watching, usage tracking).
 *
 * Qwen Code provides a structured JSON-RPC API that:
 * 1. Manages thread lifecycle (start, resume, archive)
 * 2. Handles turns with proper approval workflows
 * 3. Emits notifications for streaming events
 * 4. Sends server requests for approval prompts
 */
export class QwenAgent extends BaseAgent {
  // ============================================================
  // Qwen-specific State (not in BaseAgent)
  // ============================================================

  // Qwen CLI client state
  private qwenProcess: import('child_process').ChildProcess | null = null;
  private clientConnecting: Promise<void> | null = null;

  // State
  private _isProcessing: boolean = false;
  private abortReason?: AbortReason;
  private qwenThreadId: string | null = null; // For session resume
  private currentTurnId: string | null = null;

  // Event adapter
  private adapter: QwenEventAdapter;

  // Event queue for streaming (AsyncGenerator pattern)
  private eventQueue = new EventQueue();

  // Current user message (for source_activated event's originalMessage)
  private currentUserMessage: string = '';

  // ============================================================
  // Qwen-specific Callbacks
  // ============================================================

  /**
   * Callback for when Qwen authentication is required.
   * Called when:
   * 1. No stored Qwen tokens exist and they're needed
   * 2. Token refresh fails (refresh token expired)
   *
   * The UI should trigger the Qwen OAuth flow and then call
   * `injectQwenTokens()` with the new tokens.
   */
  onQwenAuthRequired: ((reason: string) => void) | null = null;

  /**
   * Callback when a plan is submitted via SubmitPlan MCP tool.
   * Called when the session-mcp-server sends plan_submitted callback.
   * The UI should display the plan and pause execution.
   */
  onPlanSubmitted: ((planPath: string) => void) | null = null;

  /**
   * Callback when authentication is requested via session MCP tools.
   * Called when OAuth or credential prompt tools trigger auth flow.
   * The UI should show auth dialog and pause execution.
   */
  onAuthRequest: ((request: AuthRequest) => void) | null = null;

  /**
   * Resolve the connection slug for credential routing.
   * Uses connectionSlug from config (set by factory), falls back to session's llmConnection.
   */
  private get credentialSlug(): string {
    const slug = this.config.connectionSlug ?? this.config.session?.llmConnection;
    if (!slug) {
      throw new Error('QwenAgent: connectionSlug is required for credential routing');
    }
    return slug;
  }

  constructor(config: BackendConfig) {
    // Get context window from model definitions for base class
    const modelDef = getModelById(config.model!);

    // Call BaseAgent constructor - handles all core module initialization (model from connection)
    super(config, DEFAULT_QWEN_MODEL, modelDef?.contextWindow);

    // Qwen-specific initialization
    // Restore thread ID from previous session (for resume)
    this.qwenThreadId = config.session?.sdkSessionId || null;

    // Initialize event adapter
    this.adapter = new QwenEventAdapter();

    // Start config watcher for hot-reloading source changes (non-headless only)
    if (!config.isHeadless) {
      this.startConfigWatcher();
    }

    this.debug(`Qwen backend initialized${this.qwenThreadId ? ` (will resume thread ${this.qwenThreadId})` : ''}`);
  }

  /**
   * Override debug to add Qwen prefix.
   */
  protected override debug(message: string): void {
    this.onDebug?.(`[Qwen] ${message}`);
  }

  // ============================================================
  // Client Management
  // ============================================================

  /**
   * Ensure the Qwen CLI client is connected.
   */
  private async ensureClient(): Promise<void> {
    if (this.qwenProcess?.connected) {
      return;
    }

    // Wait if already connecting
    if (this.clientConnecting) {
      await this.clientConnecting;
      if (this.qwenProcess?.connected) {
        return;
      }
    }

    // Create and connect new client
    this.clientConnecting = this.connectClient();
    await this.clientConnecting;
    this.clientConnecting = null;

    this.debug('Qwen client connected');
  }

  /**
   * Connect to Qwen CLI.
   */
  private async connectClient(): Promise<void> {
    const { spawn } = await import('child_process');
    
    // Build environment variables for the Qwen process
    const env: NodeJS.ProcessEnv = { ...process.env };
    
    // Add any custom Qwen home directory if specified
    if (this.config.codexHome) {
      env.QWEN_HOME = this.config.codexHome;
      this.debug(`Using custom QWEN_HOME: ${this.config.codexHome}`);
    }

    // Spawn Qwen CLI in app-server mode (or equivalent)
    const qwenPath = process.env.QWEN_PATH || 'qwen';
    this.qwenProcess = spawn(qwenPath, ['app-server'], {
      cwd: this.workingDirectory,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.debug(`Spawned Qwen CLI: ${qwenPath}`);

    // Set up event handlers
    this.setupProcessEventHandlers();

    // Wait for initialization
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Qwen CLI initialization timeout'));
      }, 30000);

      // Listen for ready signal from stdout
      const onData = (data: Buffer) => {
        const message = data.toString();
        if (message.includes('ready') || message.includes('initialized')) {
          clearTimeout(timeout);
          this.qwenProcess?.stdout?.off('data', onData);
          resolve();
        }
      };

      this.qwenProcess?.stdout?.on('data', onData);

      // Handle process errors
      this.qwenProcess?.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.qwenProcess?.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Qwen CLI exited with code ${code}`));
      });
    });

    // Inject auth tokens if available
    await this.injectAuth();
  }

  /**
   * Set up event handlers for the Qwen process.
   */
  private setupProcessEventHandlers(): void {
    if (!this.qwenProcess) return;

    // Handle stdout data (JSON-RPC responses/notifications)
    this.qwenProcess.stdout?.on('data', (data: Buffer) => {
      const messages = data.toString().split('\n').filter(line => line.trim());
      for (const message of messages) {
        try {
          const event = JSON.parse(message);
          this.handleQwenEvent(event);
        } catch (err) {
          this.debug(`Failed to parse Qwen message: ${message}`);
        }
      }
    });

    // Handle stderr data (debug/logs)
    this.qwenProcess.stderr?.on('data', (data: Buffer) => {
      this.debug(`Qwen stderr: ${data.toString().trim()}`);
    });

    // Handle process exit
    this.qwenProcess.on('exit', (code, signal) => {
      this.debug(`Qwen process exited: code=${code}, signal=${signal}`);
      if (this._isProcessing) {
        this.eventQueue.enqueue({ type: 'error', message: 'Connection to Qwen lost' });
        this.eventQueue.complete();
      }
    });

    // Handle process errors
    this.qwenProcess.on('error', (err) => {
      this.debug(`Qwen process error: ${err.message}`);
      this.eventQueue.enqueue({ type: 'error', message: err.message });
      this.eventQueue.complete();
    });
  }

  /**
   * Handle events from Qwen CLI.
   */
  private handleQwenEvent(event: Record<string, unknown>): void {
    const eventType = event.type as string;
    
    switch (eventType) {
      case 'thread/started':
        this.qwenThreadId = (event.thread as { id: string })?.id || null;
        if (this.qwenThreadId) {
          this.debug(`Thread ID captured: ${this.qwenThreadId}`);
          this.config.onSdkSessionIdUpdate?.(this.qwenThreadId);
        }
        break;

      case 'turn/started':
        this.currentTurnId = (event.turn as { id: string })?.id || null;
        for (const adaptedEvent of this.adapter.adaptTurnStarted(event)) {
          this.eventQueue.enqueue(adaptedEvent);
        }
        break;

      case 'turn/completed':
        for (const adaptedEvent of this.adapter.adaptTurnCompleted(event)) {
          this.eventQueue.enqueue(adaptedEvent);
        }
        this.eventQueue.complete();
        break;

      case 'message/delta':
        for (const adaptedEvent of this.adapter.adaptMessageDelta(event)) {
          this.eventQueue.enqueue(adaptedEvent);
        }
        break;

      case 'reasoning/delta':
        for (const adaptedEvent of this.adapter.adaptReasoningDelta(event)) {
          this.eventQueue.enqueue(adaptedEvent);
        }
        break;

      case 'tool/start':
        for (const adaptedEvent of this.adapter.adaptToolStart(event)) {
          this.eventQueue.enqueue(adaptedEvent);
        }
        break;

      case 'tool/complete':
        for (const adaptedEvent of this.adapter.adaptToolComplete(event)) {
          this.eventQueue.enqueue(adaptedEvent);
        }
        break;

      case 'error':
        const errorMessage = (event.error as { message: string })?.message || 'Unknown error';
        this.debug(`Qwen error: ${errorMessage}`);
        this.eventQueue.enqueue({ type: 'error', message: errorMessage });
        break;

      default:
        this.debug(`Unhandled Qwen event type: ${eventType}`);
    }
  }

  /**
   * Inject authentication into Qwen CLI.
   */
  private async injectAuth(): Promise<void> {
    const normalizedAuthType = this.config.authType;

    if (normalizedAuthType === 'oauth') {
      this.debug('Injecting Qwen OAuth tokens...');
      const injected = await this.tryInjectStoredQwenTokens();
      if (!injected) {
        this.debug('No stored Qwen tokens available - auth may be required');
      }
    } else if (normalizedAuthType === 'api_key') {
      this.debug('Injecting Qwen API key...');
      await this.tryInjectStoredApiKey();
    }
  }

  // ============================================================
  // Authentication Management
  // ============================================================

  /**
   * Inject Qwen OAuth tokens into the Qwen CLI.
   *
   * @param tokens - The tokens from the OAuth flow
   */
  async injectQwenTokens(tokens: { accessToken: string; refreshToken?: string; expiresAt?: number }): Promise<void> {
    await this.ensureClient();

    // Store tokens in credential manager
    const credentialManager = getCredentialManager();
    await credentialManager.setLlmOAuth(this.credentialSlug, {
      accessToken: tokens.accessToken,
      idToken: tokens.accessToken, // Qwen uses access token as ID token
      refreshToken: tokens.refreshToken || '',
      expiresAt: tokens.expiresAt,
    });

    // Send auth to Qwen CLI
    this.sendToQwen({
      type: 'auth/login',
      token: tokens.accessToken,
    });

    this.debug('Qwen tokens injected successfully');
  }

  /**
   * Check if we have valid Qwen credentials stored.
   *
   * @returns true if valid credentials exist and were injected
   */
  async tryInjectStoredQwenTokens(): Promise<boolean> {
    try {
      const credentialManager = getCredentialManager();
      const storedCreds = await credentialManager.getLlmOAuth(this.credentialSlug);

      if (!storedCreds) {
        this.debug('No stored Qwen credentials found');
        return false;
      }

      // Check if expired (with 5-minute buffer)
      if (storedCreds.expiresAt && Date.now() > storedCreds.expiresAt - 5 * 60 * 1000) {
        this.debug('Stored Qwen tokens expired');
        return false;
      }

      if (!storedCreds.accessToken) {
        this.debug('Stored credentials missing accessToken');
        return false;
      }

      // Inject tokens
      this.sendToQwen({
        type: 'auth/login',
        token: storedCreds.accessToken,
      });

      this.debug('Stored Qwen tokens injected successfully');
      return true;
    } catch (error) {
      this.debug(`Failed to inject stored Qwen tokens: ${error}`);
      return false;
    }
  }

  /**
   * Inject API key into the Qwen CLI.
   *
   * @param apiKey - The API key
   */
  async injectApiKey(apiKey: string): Promise<void> {
    await this.ensureClient();

    // Store API key in credential manager for persistence
    const credentialManager = getCredentialManager();
    await credentialManager.setLlmApiKey(this.credentialSlug, apiKey);

    // Send auth to Qwen CLI
    this.sendToQwen({
      type: 'auth/apikey',
      apiKey,
    });

    this.debug('Qwen API key injected successfully');
  }

  /**
   * Check if we have a stored API key and inject it.
   *
   * @returns true if valid API key was found and injected
   */
  async tryInjectStoredApiKey(): Promise<boolean> {
    try {
      const credentialManager = getCredentialManager();
      const apiKey = await credentialManager.getLlmApiKey(this.credentialSlug);

      if (!apiKey) {
        this.debug('No stored Qwen API key found');
        return false;
      }

      // Send auth to Qwen CLI
      this.sendToQwen({
        type: 'auth/apikey',
        apiKey,
      });

      this.debug('Stored Qwen API key injected successfully');
      return true;
    } catch (error) {
      this.debug(`Failed to inject stored API key: ${error}`);
      return false;
    }
  }

  /**
   * Send a message to the Qwen CLI process.
   */
  private sendToQwen(message: Record<string, unknown>): void {
    if (this.qwenProcess?.stdin?.writable) {
      this.qwenProcess.stdin.write(JSON.stringify(message) + '\n');
    }
  }

  // ============================================================
  // Chat & Lifecycle
  // ============================================================

  /**
   * Main chat method - runs the Qwen agent loop.
   */
  async *chat(
    message: string,
    attachments?: FileAttachment[],
    _options?: ChatOptions
  ): AsyncGenerator<AgentEvent> {
    this._isProcessing = true;
    this.abortReason = undefined;
    this.eventQueue.reset();
    this.adapter.startTurn();
    this.currentUserMessage = message;

    try {
      // Ensure client is connected
      await this.ensureClient();

      // Start or resume thread
      const permissionMode = this.permissionManager.getPermissionMode();

      if (this.qwenThreadId) {
        // Resume existing thread
        this.sendToQwen({
          type: 'thread/resume',
          threadId: this.qwenThreadId,
          model: this._model,
          baseInstructions: getSystemPrompt(
            undefined,
            this.config.debugMode,
            this.config.workspace.rootPath,
            this.config.session?.workingDirectory,
            undefined,
            'Qwen'
          ),
        });
        this.debug(`Resuming thread: ${this.qwenThreadId}`);
      } else {
        // Start new thread
        this.sendToQwen({
          type: 'thread/start',
          model: this._model,
          cwd: this.workingDirectory,
          approvalPolicy: this.getApprovalPolicy(permissionMode),
          sandbox: this.getSandboxMode(permissionMode),
          baseInstructions: getSystemPrompt(
            undefined,
            this.config.debugMode,
            this.config.workspace.rootPath,
            this.config.session?.workingDirectory,
            undefined,
            'Qwen'
          ),
        });
        this.debug('Starting new thread');
      }

      // Build user input
      const input = this.buildUserInput(message, attachments);

      // Start turn
      const inputSummary = input.map((item: unknown) => {
        const i = item as { type?: string; name?: string; text?: string };
        return i.type === 'skill' ? `skill:${i.name}` : 
               i.type === 'text' ? `text(${i.text?.length ?? 0} chars)` : 
               i.type;
      }).join(', ');
      this.debug(`Starting turn with ${input.length} input items: [${inputSummary}]`);

      this.sendToQwen({
        type: 'turn/start',
        threadId: this.qwenThreadId,
        input,
        effort: this.getReasoningEffort(),
      });

      // Yield events from queue until turn completes
      yield* this.eventQueue.drain();

      // Emit complete if not already emitted
      if (!this.eventQueue.isComplete) {
        yield { type: 'complete' };
      }

    } catch (error) {
      if (error instanceof Error && error.message.includes('abort')) {
        if (this.abortReason === AbortReason.PlanSubmitted) {
          return;
        }
        if (this.abortReason === AbortReason.AuthRequest) {
          return;
        }
        return;
      }

      // Parse error and emit typed error if possible
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const typedError = this.parseQwenError(errorObj);

      if (typedError.code !== 'unknown_error') {
        yield { type: 'typed_error', error: typedError };
      } else {
        yield {
          type: 'error',
          message: errorObj.message,
        };
      }

      yield { type: 'complete' };
    } finally {
      this._isProcessing = false;
    }
  }

  /**
   * Abort current query.
   */
  async abort(reason?: string): Promise<void> {
    this.debug(`Abort requested: ${reason || 'no reason'}`);
    this.sendToQwen({
      type: 'turn/abort',
      threadId: this.qwenThreadId,
    });
    this.eventQueue.complete();
  }

  /**
   * Force abort with specific reason.
   */
  forceAbort(reason: AbortReason): void {
    this.abortReason = reason;
    this.qwenProcess?.kill('SIGTERM');
    this.eventQueue.complete();
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.debug('Destroying Qwen agent');
    this.qwenProcess?.kill('SIGTERM');
    this.eventQueue.complete();
  }

  /**
   * Check if currently processing a query.
   */
  isProcessing(): boolean {
    return this._isProcessing;
  }

  // ============================================================
  // Model & Thinking Configuration
  // ============================================================

  /**
   * Get current model ID.
   */
  getModel(): string {
    return this._model;
  }

  /**
   * Set model.
   */
  setModel(model: string): void {
    this._model = model;
  }

  /**
   * Get reasoning effort for Qwen.
   */
  private getReasoningEffort(): 'low' | 'medium' | 'high' {
    return THINKING_TO_EFFORT[this._thinkingLevel];
  }

  // ============================================================
  // Permission & Sandbox
  // ============================================================

  /**
   * Get approval policy based on permission mode.
   */
  private getApprovalPolicy(mode: PermissionMode): 'auto' | 'manual' {
    return mode === 'allow-all' ? 'auto' : 'manual';
  }

  /**
   * Get sandbox mode based on permission mode.
   */
  private getSandboxMode(mode: PermissionMode): 'strict' | 'permissive' {
    return mode === 'allow-all' ? 'permissive' : 'strict';
  }

  // ============================================================
  // Source Management
  // ============================================================

  /**
   * Set the MCP server configurations for sources.
   */
  setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[]
  ): void {
    this.sendToQwen({
      type: 'sources/update',
      mcpServers,
      apiServers,
      intendedSlugs,
    });
  }

  /**
   * Get currently active source slugs.
   */
  getActiveSourceSlugs(): string[] {
    // Qwen manages sources internally, return empty for now
    return [];
  }

  /**
   * Get all sources.
   */
  getAllSources(): LoadedSource[] {
    // Qwen manages sources internally, return empty for now
    return [];
  }

  // ============================================================
  // Permission Resolution
  // ============================================================

  /**
   * Respond to a pending permission request.
   */
  respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void {
    this.sendToQwen({
      type: 'permission/response',
      requestId,
      allowed,
      alwaysAllow,
    });
  }

  // ============================================================
  // Error Handling
  // ============================================================

  /**
   * Parse a Qwen error into a typed AgentError.
   */
  private parseQwenError(error: Error): AgentError {
    const errorMessage = error.message.toLowerCase();

    // Auth errors
    if (
      errorMessage.includes('not logged in') ||
      errorMessage.includes('login required') ||
      errorMessage.includes('auth') && errorMessage.includes('fail') ||
      errorMessage.includes('unauthorized')
    ) {
      return {
        code: 'invalid_credentials',
        title: 'Authentication Required',
        message: 'You need to authenticate with Qwen. Run "/auth" to sign in.',
        actions: [
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        originalError: error.message,
      };
    }

    // Rate limit errors
    if (
      errorMessage.includes('rate limit') ||
      errorMessage.includes('too many requests') ||
      errorMessage.includes('quota exceeded')
    ) {
      return {
        code: 'rate_limited',
        title: 'Rate Limited',
        message: 'You have exceeded the rate limit. Please wait a moment and try again.',
        actions: [
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        originalError: error.message,
      };
    }

    // Network errors
    if (
      errorMessage.includes('network') ||
      errorMessage.includes('connection') ||
      errorMessage.includes('timeout')
    ) {
      return {
        code: 'network_error',
        title: 'Network Error',
        message: 'A network error occurred. Please check your connection and try again.',
        actions: [
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        originalError: error.message,
      };
    }

    // Default to unknown error
    return {
      code: 'unknown_error',
      title: 'Error',
      message: error.message,
      actions: [],
      canRetry: false,
      originalError: error.message,
    };
  }

  // ============================================================
  // Abstract Method Implementations
  // ============================================================

  /**
   * Run a mini completion using the Qwen backend.
   * Used for title generation and other small tasks.
   */
  async runMiniCompletion(prompt: string): Promise<string | null> {
    // For now, return null to fall back to default behavior
    // TODO: Implement mini completion using Qwen's lightweight model
    this.debug(`Mini completion requested: ${prompt.slice(0, 50)}...`);
    return null;
  }

  /**
   * Execute an LLM query using the Qwen backend.
   * Used by call_llm tool.
   */
  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    this.debug(`LLM query requested: ${request.prompt.slice(0, 50)}...`);
    
    // Simple implementation - send to Qwen and wait for response
    // This is a placeholder - real implementation would need to:
    // 1. Create an ephemeral thread
    // 2. Send the prompt
    // 3. Collect the response
    // 4. Return the result
    
    return {
      text: 'Qwen LLM query not yet fully implemented. Please use the main chat interface.',
      model: this._model,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  // ============================================================
  // User Input Building
  // ============================================================

  /**
   * Build user input from message and attachments.
   */
  private buildUserInput(message: string, attachments?: FileAttachment[]): unknown[] {
    const input: unknown[] = [];

    // Add text content
    if (message.trim()) {
      input.push({
        type: 'text',
        text: message,
        text_elements: [],
      });
    }

    // Add attachments
    if (attachments && attachments.length > 0) {
      for (const attachment of attachments) {
        input.push({
          type: 'file',
          file_path: attachment.path,
          file_content: attachment.text || attachment.base64 || '',
        });
      }
    }

    return input;
  }
}

// Backwards compatibility export
export type QwenBackend = QwenAgent;
