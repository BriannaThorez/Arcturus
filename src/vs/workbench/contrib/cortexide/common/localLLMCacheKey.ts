/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Generate a cache key for FIM (Fill-in-the-Middle) requests
 * Uses a hash of the prefix and model name to create a stable cache key
 */
export function generateFIMCacheKey(prefix: string, modelName: string): string {
	// Simple hash function for cache key generation
	const hash = (str: string): string => {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return Math.abs(hash).toString(36);
	};

	// Use first 1000 chars of prefix for hash (to avoid very long keys)
	const prefixHash = hash(prefix.substring(0, 1000));
	const modelHash = hash(modelName);

	return `fim:${modelHash}:${prefixHash}`;
}

/**
 * Generate an enhanced multi-level cache key for FIM requests
 * Supports separate caching of:
 * - System message (long-lived, rarely changes)
 * - File context (medium-lived, changes with file edits)
 * - User instruction/cursor position (short-lived, per-request)
 *
 * This enables better cache hit rates for repeated edits in the same file.
 */
export function generateEnhancedFIMCacheKey(
	prefix: string,
	suffix: string,
	modelName: string,
	fileContext?: string,
	systemMessage?: string
): string {
	const hash = (str: string): string => {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return Math.abs(hash).toString(36);
	};

	const modelHash = hash(modelName);

	// System message cache (long-lived) - hash first 200 chars
	const systemHash = systemMessage ? hash(systemMessage.substring(0, 200)) : 'none';

	// File context cache (medium-lived) - hash first 500 chars of file content
	// This captures file structure/imports that don't change often
	const fileContextHash = fileContext ? hash(fileContext.substring(0, 500)) : 'none';

	// Prefix/suffix cache (short-lived) - hash first 800 chars each
	// This captures the immediate context around cursor
	const prefixHash = hash(prefix.substring(0, 800));
	const suffixHash = hash(suffix.substring(0, 800));

	return `fim:enhanced:${modelHash}:${systemHash}:${fileContextHash}:${prefixHash}:${suffixHash}`;
}

/**
 * Generate a cache key for chat requests
 * Uses system message and first few user messages to create a stable cache key
 */
export function generateChatCacheKey(
	systemMsg: string,
	messages: Array<{ role: string; content: string }>,
	modelName: string
): string {
	// Simple hash function for cache key generation
	const hash = (str: string): string => {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return Math.abs(hash).toString(36);
	};

	// Hash system message (first 500 chars)
	const systemHash = hash(systemMsg.substring(0, 500));

	// Hash first 2 messages (first 200 chars each)
	const messagesHash = hash(
		messages.slice(0, 2)
			.map(m => m.content.substring(0, 200))
			.join('|')
	);

	const modelHash = hash(modelName);

	return `chat:${modelHash}:${systemHash}:${messagesHash}`;
}

/**
 * Generate an enhanced multi-level cache key for chat requests
 * Supports separate caching of:
 * - System message (long-lived, rarely changes)
 * - Conversation context (medium-lived, changes with conversation)
 * - Latest user message (short-lived, per-request)
 */
export function generateEnhancedChatCacheKey(
	systemMsg: string,
	messages: Array<{ role: string; content: string }>,
	modelName: string,
	conversationContext?: string
): string {
	const hash = (str: string): string => {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return Math.abs(hash).toString(36);
	};

	const modelHash = hash(modelName);

	// System message cache (long-lived)
	const systemHash = hash(systemMsg.substring(0, 500));

	// Conversation context cache (medium-lived) - previous messages excluding the last one
	const contextHash = conversationContext
		? hash(conversationContext.substring(0, 1000))
		: hash(messages.slice(0, -1).map(m => m.content.substring(0, 200)).join('|'));

	// Latest user message (short-lived)
	const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
	const latestMessageHash = latestMessage ? hash(latestMessage.content.substring(0, 300)) : 'none';

	return `chat:enhanced:${modelHash}:${systemHash}:${contextHash}:${latestMessageHash}`;
}

