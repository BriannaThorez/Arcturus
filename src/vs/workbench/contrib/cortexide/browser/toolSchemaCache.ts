/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Part C: Tool Schema Cache
 *
 * Caches tool schemas in different provider formats (OpenAI, Anthropic, Gemini)
 * to avoid rebuilding them on every request.
 */

import type { ChatMode } from '../common/cortexideSettingsTypes.js';
import type { InternalToolInfo } from '../common/prompt/prompts.js';
import type OpenAI from 'openai';

/**
 * Cached tool schemas in different formats
 */
export interface CachedToolSchemas {
	hash: string; // Stable hash of toolset
	openAIFormat: OpenAI.Chat.Completions.ChatCompletionTool[] | null;
	anthropicFormat: any[] | null; // Anthropic tool format
	geminiFormat: any[] | null; // Gemini tool format
	timestamp: number;
}

/**
 * Compute a stable hash of the toolset for cache key
 */
function computeToolsetHash(
	chatMode: ChatMode | null,
	mcpTools: InternalToolInfo[] | undefined,
	allowedTools: { [key: string]: InternalToolInfo } | undefined
): string {
	const toolNames: string[] = [];
	const toolSchemas: string[] = [];
	const mcpServerNames: string[] = [];

	if (allowedTools) {
		for (const toolName in allowedTools) {
			const tool = allowedTools[toolName];
			toolNames.push(tool.name);
			// Hash the schema (name + description + params)
			const schemaStr = JSON.stringify({
				name: tool.name,
				description: tool.description,
				params: tool.params,
			});
			toolSchemas.push(schemaStr);
		}
	}

	// Include MCP tool info for cache invalidation
	if (mcpTools) {
		for (const mcpTool of mcpTools) {
			mcpServerNames.push(mcpTool.mcpServerName || '');
			toolNames.push(mcpTool.name);
			const schemaStr = JSON.stringify({
				name: mcpTool.name,
				description: mcpTool.description,
				params: mcpTool.params,
			});
			toolSchemas.push(schemaStr);
		}
	}

	// Create stable hash from sorted arrays
	const hashInput = JSON.stringify({
		chatMode,
		toolNames: toolNames.sort(),
		toolSchemas: toolSchemas.sort(),
		mcpServerNames: mcpServerNames.sort(),
	});

	// Simple hash function (for production, consider using a proper hash library)
	let hash = 0;
	for (let i = 0; i < hashInput.length; i++) {
		const char = hashInput.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash; // Convert to 32-bit integer
	}
	return hash.toString(36);
}

/**
 * Tool Schema Cache Service
 */
export class ToolSchemaCache {
	private cache: Map<string, CachedToolSchemas> = new Map();
	private readonly TTL = 300_000; // 5 minutes TTL
	private readonly MAX_SIZE = 50; // Limit cache size

	/**
	 * Get cached tool schemas or build and cache them
	 */
	getOrBuildToolSchemas(
		chatMode: ChatMode | null,
		mcpTools: InternalToolInfo[] | undefined,
		allowedTools: { [key: string]: InternalToolInfo } | undefined,
		buildOpenAI: (tools: { [key: string]: InternalToolInfo } | undefined) => OpenAI.Chat.Completions.ChatCompletionTool[] | null,
		buildAnthropic?: (tools: { [key: string]: InternalToolInfo } | undefined) => any[] | null,
		buildGemini?: (tools: { [key: string]: InternalToolInfo } | undefined) => any[] | null
	): CachedToolSchemas {
		const hash = computeToolsetHash(chatMode, mcpTools, allowedTools);
		const now = Date.now();

		// Check cache
		const cached = this.cache.get(hash);
		if (cached && (now - cached.timestamp) < this.TTL) {
			return cached;
		}

		// Build tool schemas
		const buildStart = performance.now();
		const openAIFormat = buildOpenAI(allowedTools);
		const anthropicFormat = buildAnthropic ? buildAnthropic(allowedTools) : null;
		const geminiFormat = buildGemini ? buildGemini(allowedTools) : null;
		const buildMs = performance.now() - buildStart;

		// Log in dev mode
		const isDev = typeof process !== 'undefined' && (process.env.NODE_ENV === 'development' || process.env.DEBUG);
		if (isDev && buildMs > 10) {
			console.debug(`[ToolSchemaCache] Built schemas in ${buildMs.toFixed(2)}ms for ${hash.substring(0, 8)}`);
		}

		const cachedSchemas: CachedToolSchemas = {
			hash,
			openAIFormat,
			anthropicFormat,
			geminiFormat,
			timestamp: now,
		};

		// Cache with LRU eviction
		if (this.cache.size >= this.MAX_SIZE) {
			// Remove oldest entry
			let oldestKey: string | undefined;
			let oldestTime = Infinity;
			for (const [key, value] of this.cache.entries()) {
				if (value.timestamp < oldestTime) {
					oldestTime = value.timestamp;
					oldestKey = key;
				}
			}
			if (oldestKey) {
				this.cache.delete(oldestKey);
			}
		}

		this.cache.set(hash, cachedSchemas);
		return cachedSchemas;
	}

	/**
	 * Invalidate cache (call when tools change)
	 */
	invalidate(): void {
		this.cache.clear();
	}

	/**
	 * Get cache stats (for debugging)
	 */
	getStats(): { size: number; entries: Array<{ hash: string; age: number }> } {
		const now = Date.now();
		return {
			size: this.cache.size,
			entries: Array.from(this.cache.entries()).map(([hash, value]) => ({
				hash: hash.substring(0, 8),
				age: now - value.timestamp,
			})),
		};
	}
}

// Singleton instance
export const toolSchemaCache = new ToolSchemaCache();

