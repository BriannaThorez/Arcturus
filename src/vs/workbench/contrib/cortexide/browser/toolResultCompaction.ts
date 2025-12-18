/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Part D: Tool Result Compaction for Local Providers
 *
 * Compacts large tool results for local models to keep contexts manageable.
 * Full content remains available in UI, but only compacted version is sent to model.
 */

import type { ProviderName } from '../common/cortexideSettingsTypes.js';
import type { ToolName } from '../common/toolsServiceTypes.js';

export interface ToolResultCompactionPolicy {
	maxCharsPerResult: number; // Default: 8k
	keepFirstChars: number; // Keep first N chars
	keepLastChars: number; // Keep last M chars
	enableForLocal: boolean; // Only enable for local providers
}

const DEFAULT_POLICY: ToolResultCompactionPolicy = {
	maxCharsPerResult: 8000, // 8k default (will be overridden to 4k for local in agent mode)
	keepFirstChars: 2000, // First 2k
	keepLastChars: 2000, // Last 2k
	enableForLocal: true,
};

/**
 * Agent mode policy: more aggressive compaction for local models
 */
export const AGENT_MODE_LOCAL_POLICY: Partial<ToolResultCompactionPolicy> = {
	maxCharsPerResult: 4000, // 4k for local models in agent mode (reduced from 8k)
	keepFirstChars: 1500, // First 1.5k
	keepLastChars: 1500, // Last 1.5k
};

/**
 * Compact a tool result content string for local providers
 */
export function compactToolResult(
	content: string,
	toolName: ToolName,
	policy: Partial<ToolResultCompactionPolicy> = {}
): { compacted: string; wasCompacted: boolean; originalLength: number } {
	const effectivePolicy = { ...DEFAULT_POLICY, ...policy };

	// Don't compact if disabled or content is small enough
	if (!effectivePolicy.enableForLocal || content.length <= effectivePolicy.maxCharsPerResult) {
		return {
			compacted: content,
			wasCompacted: false,
			originalLength: content.length,
		};
	}

	const originalLength = content.length;
	const { keepFirstChars, keepLastChars } = effectivePolicy;

	// Extract structured summary header
	const header = `[Tool: ${toolName} | Status: success | Length: ${originalLength} chars]\n`;

	// Get first and last portions
	const firstPortion = content.substring(0, keepFirstChars);
	const lastPortion = content.substring(content.length - keepLastChars);

	// Try to find a good middle separator (look for line breaks)
	const middleSeparator = '\n\n... [middle content truncated] ...\n\n';

	// Build compacted content
	const compacted = header + firstPortion + middleSeparator + lastPortion;

	return {
		compacted,
		wasCompacted: true,
		originalLength,
	};
}

/**
 * Check if a provider is local (for compaction policy)
 */
export function isLocalProviderForCompaction(providerName: ProviderName): boolean {
	return providerName === 'ollama' ||
		providerName === 'vLLM' ||
		providerName === 'lmStudio' ||
		providerName === 'openAICompatible' ||
		providerName === 'liteLLM';
}

/**
 * Compact tool results in messages for local providers
 * Returns new messages array with compacted tool results
 */
export function compactToolResultsInMessages(
	messages: Array<{ role: string; content?: string;[key: string]: unknown }>,
	providerName: ProviderName,
	policy: Partial<ToolResultCompactionPolicy> = {}
): Array<{ role: string; content?: string;[key: string]: unknown }> {
	// Only compact for local providers
	if (!isLocalProviderForCompaction(providerName) || !policy.enableForLocal) {
		return messages;
	}

	return messages.map(msg => {
		// Only compact tool messages
		if (msg.role !== 'tool' || typeof msg.content !== 'string') {
			return msg;
		}

		const toolName = (msg as { name?: ToolName }).name;
		if (!toolName) {
			return msg;
		}

		const { compacted, wasCompacted } = compactToolResult(msg.content, toolName, policy);

		if (wasCompacted) {
			// Return compacted version, but preserve original in metadata for UI
			return {
				...msg,
				content: compacted,
				_originalContent: msg.content, // Store original for UI expansion
				_wasCompacted: true,
			};
		}

		return msg;
	});
}

