/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *---------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';

/**
 * State machine for local setup wizard
 */
export type LocalSetupState =
	| { type: 'idle' }
	| { type: 'checking' }
	| { type: 'installing'; progress: number; log: string[] }
	| { type: 'downloading'; currentModel: string; progress: number; totalModels: number }
	| { type: 'verifying'; currentTest: string; progress: number; totalTests: number }
	| { type: 'done'; results: LocalSetupResults }
	| { type: 'error'; error: LocalSetupError };

export type LocalSetupError =
	| { code: 'OLLAMA_NOT_FOUND'; message: string }
	| { code: 'INSTALL_FAILED'; message: string; details?: string }
	| { code: 'DOWNLOAD_FAILED'; message: string; model?: string }
	| { code: 'VERIFICATION_FAILED'; message: string; failedTests: string[] }
	| { code: 'INSUFFICIENT_DISK_SPACE'; message: string; requiredGb: number; availableGb: number }
	| { code: 'NETWORK_ERROR'; message: string }
	| { code: 'CANCELLED'; message: string };

export interface LocalSetupResults {
	ollamaInstalled: boolean;
	ollamaRunning: boolean;
	modelsInstalled: string[];
	verificationResults: VerificationResults;
	defaultsConfigured: boolean;
}

export interface VerificationResults {
	chat: { passed: boolean; error?: string };
	toolCalling: { passed: boolean; error?: string };
	webCalling: { passed: boolean; skipped: boolean; error?: string };
	vision: { passed: boolean; skipped: boolean; error?: string };
}

export interface SystemCheckResult {
	ollamaInstalled: boolean;
	ollamaRunning: boolean;
	ollamaEndpoint: string;
	otherLocalEndpoints: Array<{ provider: string; endpoint: string; running: boolean }>;
	diskSpaceGb: number | null; // null if cannot determine
	hasGpu: boolean | null; // null if cannot determine
}

export type ModelPackType = 'fast' | 'balanced' | 'power';

export interface ModelPack {
	id: ModelPackType;
	name: string;
	description: string;
	models: {
		chat: string;
		tools?: string;
		fim?: string;
		embeddings?: string;
		vision?: string;
	};
	estimatedSizeGb: number;
	minRamGb: number;
	recommendedFor: string[];
}

export interface LocalSetupProgress {
	state: LocalSetupState;
	currentStep: number;
	totalSteps: number;
	canCancel: boolean;
}

