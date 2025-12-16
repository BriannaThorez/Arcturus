/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *---------------------------------------------------------------------------------------------*/

import { ModelPack } from './localSetupServiceTypes.js';

/**
 * Model pack definitions for local setup wizard.
 * Models are selected based on:
 * - Tool calling reliability (tested models)
 * - Structured output support
 * - Context length (prefer 8k+)
 * - Speed on typical hardware (CPU-friendly for Fast pack)
 */
export const MODEL_PACKS: Record<string, ModelPack> = {
	fast: {
		id: 'fast',
		name: 'Fast (CPU-friendly)',
		description: 'Minimal latency, fewer capabilities. Best for older hardware or quick testing.',
		models: {
			chat: 'llama3.2:3b',
			tools: 'llama3.2:3b', // Same model for tools
			fim: 'qwen2.5-coder:1.5b', // Smaller FIM model
		},
		estimatedSizeGb: 4.5,
		minRamGb: 4,
		recommendedFor: ['Older hardware', 'Quick testing', 'Low memory systems'],
	},
	balanced: {
		id: 'balanced',
		name: 'Balanced (Recommended)',
		description: 'Best overall local experience. Good balance of speed and quality.',
		models: {
			chat: 'llama3.2:7b',
			tools: 'llama3.2:7b',
			fim: 'qwen2.5-coder:3b',
		},
		estimatedSizeGb: 12,
		minRamGb: 8,
		recommendedFor: ['Most users', 'General development', 'Best balance'],
	},
	power: {
		id: 'power',
		name: 'Power (GPU recommended)',
		description: 'Best quality, heavier. Requires more RAM and benefits from GPU acceleration.',
		models: {
			chat: 'llama3.3:70b',
			tools: 'llama3.3:70b',
			fim: 'qwen2.5-coder:7b',
		},
		estimatedSizeGb: 45,
		minRamGb: 32,
		recommendedFor: ['High-end hardware', 'Best quality', 'GPU acceleration'],
	},
} as const;

/**
 * Get model pack by ID
 */
export function getModelPack(id: string): ModelPack | undefined {
	return MODEL_PACKS[id];
}

/**
 * Get all model packs
 */
export function getAllModelPacks(): ModelPack[] {
	return Object.values(MODEL_PACKS);
}

/**
 * Get recommended model pack (balanced)
 */
export function getRecommendedModelPack(): ModelPack {
	return MODEL_PACKS.balanced;
}

