/**
 * Qwen Code Agent Module
 *
 * Exports the QwenAgent implementation that uses the Qwen Code CLI protocol.
 * Communicates via JSON-RPC over stdio with `qwen`.
 *
 * Note: The main QwenAgent class has been moved to ../../qwen-agent.ts
 * for consistency with other agents. This index re-exports for backward compatibility.
 */

// Re-export QwenAgent from its location
export { QwenAgent } from '../../qwen-agent.ts';
export type { QwenBackend } from '../../qwen-agent.ts';
export { QwenEventAdapter } from './event-adapter.ts';
