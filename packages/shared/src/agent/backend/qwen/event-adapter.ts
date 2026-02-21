/**
 * Qwen Event Adapter
 *
 * Adapts Qwen Code CLI events to Craft Agent events.
 * This adapter converts Qwen-specific event formats to the standardized
 * AgentEvent format used throughout the application.
 */

import type { AgentEvent } from '@craft-agent/core/types';

/**
 * Event adapter for Qwen Code CLI.
 * Converts Qwen events to standardized AgentEvent format.
 */
export class QwenEventAdapter {
  private turnStarted: boolean = false;
  private currentToolName: string | null = null;
  private blockReasons: Map<string, string> = new Map();

  /**
   * Reset adapter state for a new turn.
   */
  startTurn(): void {
    this.turnStarted = false;
    this.currentToolName = null;
    this.blockReasons.clear();
  }

  /**
   * Store a block reason for a specific item ID.
   */
  setBlockReason(itemId: string, reason: string): void {
    this.blockReasons.set(itemId, reason);
  }

  /**
   * Adapt turn started event.
   */
  *adaptTurnStarted(event: Record<string, unknown>): Generator<AgentEvent> {
    this.turnStarted = true;
    
    const turn = event.turn as { id?: string; model?: string } | undefined;
    
    // Use 'status' type instead of non-existent 'turn_start'
    yield {
      type: 'status',
      message: `Turn started${turn?.model ? ` with model ${turn.model}` : ''}`,
    };
  }

  /**
   * Adapt turn completed event.
   */
  *adaptTurnCompleted(event: Record<string, unknown>): Generator<AgentEvent> {
    const turn = event.turn as { 
      id?: string; 
      usage?: { 
        input_tokens?: number; 
        output_tokens?: number;
        total_tokens?: number;
      };
    } | undefined;

    // Emit usage information if available
    if (turn?.usage) {
      yield {
        type: 'usage_update',
        usage: {
          inputTokens: turn.usage.input_tokens || 0,
          contextWindow: undefined,
        },
      };
    }

    // Use 'complete' type instead of non-existent 'turn_complete'
    yield {
      type: 'complete',
    };
  }

  /**
   * Adapt message delta event (streaming text).
   */
  *adaptMessageDelta(event: Record<string, unknown>): Generator<AgentEvent> {
    const delta = event.delta as string | undefined;
    
    if (delta) {
      yield {
        type: 'text_delta',
        text: delta,
      };
    }
  }

  /**
   * Adapt reasoning delta event (streaming thinking).
   */
  *adaptReasoningDelta(event: Record<string, unknown>): Generator<AgentEvent> {
    const delta = event.delta as string | undefined;
    
    if (delta) {
      // Use text_delta for reasoning as there's no specific reasoning event
      yield {
        type: 'text_delta',
        text: delta,
      };
    }
  }

  /**
   * Adapt tool start event.
   */
  *adaptToolStart(event: Record<string, unknown>): Generator<AgentEvent> {
    const tool = event.tool as { 
      id?: string; 
      name?: string; 
      type?: string;
      input?: Record<string, unknown>;
    } | undefined;

    if (tool?.name) {
      this.currentToolName = tool.name;
      
      yield {
        type: 'tool_start',
        toolUseId: tool.id || `tool-${Date.now()}`,
        toolName: tool.name,
        input: tool.input || {},
      };
    }
  }

  /**
   * Adapt tool complete event.
   */
  *adaptToolComplete(event: Record<string, unknown>): Generator<AgentEvent> {
    const tool = event.tool as { 
      id?: string; 
      name?: string;
      output?: string;
      error?: string;
      isError?: boolean;
    } | undefined;

    const toolId = tool?.id;
    const isError = tool?.isError || !!tool?.error;
    
    // Check if this tool was blocked
    const blockReason = toolId ? this.blockReasons.get(toolId) : undefined;
    
    if (tool?.name) {
      yield {
        type: 'tool_result',
        toolUseId: toolId || `tool-${Date.now()}`,
        toolName: tool.name,
        result: blockReason || tool.output || tool.error || '',
        isError: isError || !!blockReason,
        input: {},
      };
    }

    // Clean up block reason
    if (toolId) {
      this.blockReasons.delete(toolId);
    }
  }

  /**
   * Adapt error event.
   */
  *adaptError(event: Record<string, unknown>): Generator<AgentEvent> {
    const error = event.error as { message?: string; code?: string } | undefined;
    
    yield {
      type: 'error',
      message: error?.message || 'Unknown error',
    };
  }

  /**
   * Adapt config warning event.
   */
  *adaptConfigWarning(event: Record<string, unknown>): Generator<AgentEvent> {
    const summary = event.summary as string | undefined;
    
    yield {
      type: 'info',
      message: summary || 'Configuration warning',
    };
  }

  /**
   * Adapt context compacted event.
   */
  *adaptContextCompacted(event: Record<string, unknown>): Generator<AgentEvent> {
    const threadId = event.threadId as string | undefined;
    
    yield {
      type: 'info',
      message: `Context compacted for thread ${threadId}`,
    };
  }
}
