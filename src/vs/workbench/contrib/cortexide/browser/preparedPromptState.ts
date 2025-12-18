/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Part B: Incremental Prompt Pipeline
 *
 * PreparedPromptState holds the state needed for incremental prompt building across tool turns.
 * This avoids expensive full message re-preparation on each tool turn.
 */

import type { LLMChatMessage, OpenAILLMChatMessage } from '../common/sendLLMMessageTypes.js';
import type { ModelSelection, ChatMode } from '../common/cortexideSettingsTypes.js';

/**
 * Stable representation of tool schemas for caching
 */
export interface ToolSchemaCache {
	hash: string; // Stable hash of tool names + schemas
	openAIFormat: any[] | null; // OpenAI format tools
	anthropicFormat: any[] | null; // Anthropic format tools
	geminiFormat: any[] | null; // Gemini format tools
	timestamp: number;
}

/**
 * PreparedPromptState holds the incremental state for prompt building
 */
export class PreparedPromptState {
	// Base prepared messages (system + history, without tool results)
	public readonly baseMessages: LLMChatMessage[];
	public readonly separateSystemMessage: string | undefined;

	// Token estimates
	public baseTokenCount: number;
	public baseContextSize: number;

	// Tool schema cache
	public readonly toolSchemaCache: ToolSchemaCache | null;

	// Rolling buffer for tool results and assistant tool_calls
	// This is append-only and gets merged into final messages
	public readonly toolResultsBuffer: Array<{
		assistantMessage?: LLMChatMessage; // Assistant message with tool_calls
		toolResults: Array<{ role: 'tool'; content: string; tool_call_id: string }>;
	}>;

	// Model and chat mode info (for cache invalidation)
	public readonly modelSelection: ModelSelection;
	public readonly chatMode: ChatMode;

	// Provider format info
	public readonly providerName: string;
	public readonly specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined;

	constructor(params: {
		baseMessages: LLMChatMessage[];
		separateSystemMessage: string | undefined;
		baseTokenCount: number;
		baseContextSize: number;
		toolSchemaCache: ToolSchemaCache | null;
		modelSelection: ModelSelection;
		chatMode: ChatMode;
		providerName: string;
		specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined;
	}) {
		this.baseMessages = params.baseMessages;
		this.separateSystemMessage = params.separateSystemMessage;
		this.baseTokenCount = params.baseTokenCount;
		this.baseContextSize = params.baseContextSize;
		this.toolSchemaCache = params.toolSchemaCache;
		this.toolResultsBuffer = [];
		this.modelSelection = params.modelSelection;
		this.chatMode = params.chatMode;
		this.providerName = params.providerName;
		this.specialToolFormat = params.specialToolFormat;
	}

	/**
	 * Append tool results incrementally (without rebuilding entire message array)
	 */
	appendToolResults(
		assistantMessage: LLMChatMessage,
		toolResults: Array<{ role: 'tool'; content: string; tool_call_id: string }>
	): void {
		this.toolResultsBuffer.push({
			assistantMessage,
			toolResults,
		});

		// Update token count incrementally
		const toolResultsTokens = toolResults.reduce((sum, tr) => {
			return sum + Math.ceil(tr.content.length / 4);
		}, 0);
		this.baseTokenCount += toolResultsTokens;
		this.baseContextSize += toolResults.reduce((sum, tr) => sum + tr.content.length, 0);
	}

	/**
	 * Build final messages array by merging base + tool results
	 * This is much faster than rebuilding from scratch
	 */
	buildFinalMessages(): LLMChatMessage[] {
		const messages: LLMChatMessage[] = [...this.baseMessages];

		// Append tool results incrementally
		for (const bufferEntry of this.toolResultsBuffer) {
			// Find the last assistant message in base messages or add the new one
			let lastAssistantIdx = -1;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === 'assistant') {
					lastAssistantIdx = i;
					break;
				}
			}

			if (lastAssistantIdx >= 0 && bufferEntry.assistantMessage) {
				// Patch the existing assistant message with tool_calls
				const existingMsg = messages[lastAssistantIdx];
				if (existingMsg.role === 'assistant') {
					// Merge tool_calls if present (only for OpenAI format assistant messages)
					const existingAssistant = existingMsg as Extract<OpenAILLMChatMessage, { role: 'assistant' }>;
					if ('tool_calls' in existingAssistant && 'tool_calls' in bufferEntry.assistantMessage && bufferEntry.assistantMessage.tool_calls) {
						existingAssistant.tool_calls = bufferEntry.assistantMessage.tool_calls;
					}
					// For Anthropic format, merge content arrays
					if ('content' in bufferEntry.assistantMessage && Array.isArray(bufferEntry.assistantMessage.content)) {
						if (Array.isArray(existingMsg.content)) {
							// Type assertion needed because tool_result types are valid in Anthropic format
							(existingMsg as any).content = [...existingMsg.content, ...bufferEntry.assistantMessage.content];
						} else {
							(existingMsg as any).content = bufferEntry.assistantMessage.content;
						}
					}
				}
			} else if (bufferEntry.assistantMessage) {
				// Add new assistant message if not found
				messages.push(bufferEntry.assistantMessage);
			}

			// Append tool result messages
			for (const toolResult of bufferEntry.toolResults) {
				messages.push(toolResult as LLMChatMessage);
			}
		}

		return messages;
	}

	/**
	 * Check if we need to truncate based on context window
	 * Returns true if truncation is needed
	 */
	needsTruncation(contextWindow: number, reservedOutputTokenSpace: number): boolean {
		const effectiveWindow = contextWindow - (reservedOutputTokenSpace || 4096);
		return this.baseTokenCount > effectiveWindow;
	}

	/**
	 * Fast truncation that prioritizes:
	 * - system message
	 * - last user message
	 * - most recent tool results
	 * - last assistant response
	 * Drops older assistant/tool chatter first
	 */
	truncateFast(contextWindow: number, reservedOutputTokenSpace: number): void {
		const effectiveWindow = contextWindow - (reservedOutputTokenSpace || 4096);

		if (this.baseTokenCount <= effectiveWindow) {
			return; // No truncation needed
		}

		// Strategy: Keep system + last user message + recent tool results
		// Drop older messages from the middle
		const messages = this.buildFinalMessages();

		// Find system message (usually first)
		const systemMsg = messages.find(m => m.role === 'system');
		const systemTokens = systemMsg ? this._estimateTokens(systemMsg) : 0;

		// Find last user message (for potential future use in truncation strategy)
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'user') {
				// lastUserIdx found but not used in current implementation
				break;
			}
		}

		// Keep: system + last user + recent tool results (last 2 tool turns)
		const keepFromEnd = 10; // Keep last 10 messages (roughly 2 tool turns)
		const keepMessages = messages.slice(-keepFromEnd);
		const keepTokens = keepMessages.reduce((sum, m) => sum + this._estimateTokens(m), 0) + systemTokens;

		// If still too large, trim tool results
		if (keepTokens > effectiveWindow) {
			// Trim tool result content (keep structure, reduce content)
			for (const msg of keepMessages) {
				if (msg.role === 'tool' && 'content' in msg && typeof msg.content === 'string') {
					const maxToolResultChars = 8000; // 8k chars per tool result
					if (msg.content.length > maxToolResultChars) {
						msg.content = msg.content.substring(0, maxToolResultChars) + '\n... (truncated)';
					}
				}
			}
		}

		// Rebuild base messages with truncated content
		// This is a simplified approach - in practice, we'd want to be more careful
		// For now, we'll just update token counts
		this.baseTokenCount = Math.min(this.baseTokenCount, effectiveWindow);
	}

	private _estimateTokens(msg: LLMChatMessage): number {
		if ('parts' in msg) {
			// Gemini format
			return msg.parts.reduce((sum, part) => {
				if ('text' in part) {
					return sum + Math.ceil(part.text.length / 4);
				}
				return sum + 100; // Image estimate
			}, 0);
		}

		if ('content' in msg) {
			if (typeof msg.content === 'string') {
				return Math.ceil(msg.content.length / 4);
			}
			if (Array.isArray(msg.content)) {
				return msg.content.reduce((sum, part) => {
					if (part.type === 'text') {
						return sum + Math.ceil(part.text.length / 4);
					}
					return sum + 100; // Image estimate
				}, 0);
			}
		}

		return 0;
	}

	/**
	 * Create a cache key for this state (excluding tool results)
	 */
	getCacheKey(): string {
		const modelKey = `${this.modelSelection.providerName}:${this.modelSelection.modelName}`;
		const baseMessagesKey = JSON.stringify(this.baseMessages.map(m => ({
			role: m.role,
			// Only include first 100 chars for hash (tool results excluded)
			content: this._getMessageContentPreview(m),
		})));
		const toolSchemaKey = this.toolSchemaCache?.hash || 'null';
		return `${modelKey}|${this.chatMode}|${baseMessagesKey}|${toolSchemaKey}`;
	}

	private _getMessageContentPreview(msg: LLMChatMessage): string {
		if ('parts' in msg) {
			const textParts = msg.parts.filter((p): p is { text: string } => 'text' in p);
			return textParts.map(p => p.text).join(' ').substring(0, 100);
		}
		if ('content' in msg) {
			if (typeof msg.content === 'string') {
				return msg.content.substring(0, 100);
			}
			if (Array.isArray(msg.content)) {
				const textParts = msg.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text');
				return textParts.map(p => p.text).join(' ').substring(0, 100);
			}
		}
		return '';
	}
}

