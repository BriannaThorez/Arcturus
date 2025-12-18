/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ProviderName } from './cortexideSettingsTypes.js';

export type LocalLLMPerfSpan = {
	providerName: ProviderName;
	modelName: string;
	featureType: 'chat' | 'complete' | 'edit';
	promptTokens: number;
	promptBytes: number;
	maxTokens: number;
	temperature?: number;
	topP?: number;
	start_time_ms: number;
	firstTokenTime_ms?: number;
	lastTokenTime_ms?: number;
	tokenCount?: number;
	success?: boolean;
	errorCategory?: string;
};

class PerfSpanTracker {
	createSpan(
		providerName: ProviderName,
		modelName: string,
		featureType: 'chat' | 'complete' | 'edit',
		promptTokens: number,
		promptBytes: number,
		maxTokens: number,
		temperature?: number,
		topP?: number
	): LocalLLMPerfSpan {
		const span: LocalLLMPerfSpan = {
			providerName,
			modelName,
			featureType,
			promptTokens,
			promptBytes,
			maxTokens,
			temperature,
			topP,
			start_time_ms: Date.now(),
		};
		return span;
	}

	recordFirstToken(span: LocalLLMPerfSpan): void {
		if (!span.firstTokenTime_ms) {
			span.firstTokenTime_ms = Date.now();
		}
	}

	recordToken(span: LocalLLMPerfSpan, tokenCount: number, elapsedMs: number): void {
		span.tokenCount = tokenCount;
		span.lastTokenTime_ms = Date.now();
	}

	completeSpan(span: LocalLLMPerfSpan, success: boolean, errorCategory?: string): void {
		span.success = success;
		if (errorCategory) {
			span.errorCategory = errorCategory;
		}
		// Could log or send to telemetry here
	}
}

export const perfSpanTracker = new PerfSpanTracker();

